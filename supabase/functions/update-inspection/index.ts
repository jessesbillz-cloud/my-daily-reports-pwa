import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Auth: require apikey header but skip user JWT validation ──
    // External scheduling forms call this with the anon key (not a user JWT).
    // We keep a basic Authorization check to deter casual abuse.
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Not authenticated. Please include an API key." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { request_id, action, action_by, reason, new_date, new_time, new_duration, new_notes } = body;

    if (!request_id || !action) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing request_id or action",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Fetch the existing request
    const { data: existing, error: fetchError } = await supabase
      .from("inspection_requests")
      .select("*")
      .eq("id", request_id)
      .single();

    if (fetchError || !existing) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Request not found",
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Look up the job owner's email, ntfy topic, company name, and notification preferences
    let ownerEmail = "";
    let ownerNtfyTopic = "";
    let ownerCompanyName = "";
    let ownerNotifPrefs: any = { request_new: true, request_edited: true, request_deleted: true, request_scheduled: true };

    // Primary: use user_id stored on the request record
    const lookupId = existing.user_id;
    if (lookupId) {
      try {
        const { data: profile } = await supabase
          .from("profiles")
          .select("ntfy_topic, company_name, notification_prefs")
          .eq("id", lookupId)
          .single();
        if (profile) {
          ownerNtfyTopic = profile.ntfy_topic || "";
          ownerCompanyName = profile.company_name || "";
          if (profile.notification_prefs) ownerNotifPrefs = { ...ownerNotifPrefs, ...profile.notification_prefs };
        }
        const { data: authUser } = await supabase.auth.admin.getUserById(lookupId);
        if (authUser?.user?.email) ownerEmail = authUser.user.email;
      } catch (e) {
        console.error("[update-inspection] Owner lookup failed for request_id:", request_id, e);
      }
    }

    // Fallback: find owner via jobs table if user_id wasn't on the request
    if (!ownerEmail) {
      try {
        const projectSlug = (existing.project || "").toLowerCase();
        const { data: allJobs } = await supabase.from("jobs").select("user_id, name").limit(200);
        const matched = (allJobs || []).find(
          (j: any) => (j.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-") === projectSlug
        );
        if (matched) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("ntfy_topic, company_name")
            .eq("id", matched.user_id)
            .single();
          if (profile) {
            ownerNtfyTopic = profile.ntfy_topic || "";
            ownerCompanyName = profile.company_name || "";
          }
          const { data: authUser } = await supabase.auth.admin.getUserById(matched.user_id);
          if (authUser?.user?.email) ownerEmail = authUser.user.email;
        }
      } catch (e) {
        console.error("[update-inspection] Fallback owner lookup failed for request_id:", request_id, e);
      }
    }

    // Build full recipient list: saved recipients + owner email
    const buildRecipients = (): string[] => {
      const recipients = [...(existing.email_recipients || [])];
      if (ownerEmail && !recipients.includes(ownerEmail)) {
        recipients.push(ownerEmail);
      }
      return recipients;
    };

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FROM_EMAIL =
      Deno.env.get("FROM_EMAIL") || "reports@mydailyreports.org";
    const REPLY_TO = Deno.env.get("REPLY_TO_EMAIL") || FROM_EMAIL;
    const projectName = (existing.project || "").replace(/-/g, " ");
    const typeLabel = (existing.inspection_types || []).join(", ");

    // Helper to send ntfy push notification
    const sendNtfy = async (title: string, body: string, tags = "calendar", priority = "default") => {
      if (!ownerNtfyTopic) return;
      try {
        await fetch(`https://ntfy.sh/${ownerNtfyTopic}`, {
          method: "POST",
          headers: { "Title": title, "Priority": priority, "Tags": tags },
          body,
        });
      } catch (e) {
        console.error("ntfy push error (non-fatal):", e);
      }
    };

    // Helper to build .ics calendar content for an inspection
    const buildICS = (): string => {
      const dateField = existing.inspection_date || "";
      const timeField = existing.inspection_time || "";
      const dur = parseInt(existing.duration) || 60;
      const isFlexible = existing.flexible_display === "flexible";
      const uid = `${existing.id}@mydailyreports.org`;
      const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const icsDate = dateField.replace(/-/g, "");
      const summary = `${typeLabel}: ${projectName}`;
      let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//My Daily Reports//Scheduling//EN\r\nMETHOD:PUBLISH\r\nBEGIN:VEVENT\r\n";
      ics += `UID:${uid}\r\nDTSTAMP:${now}\r\n`;
      if (!isFlexible && timeField) {
        const tParts = timeField.split(":").map(Number);
        const startMin = tParts[0] * 60 + tParts[1];
        const endMin = startMin + dur;
        const tStart = String(tParts[0]).padStart(2, "0") + String(tParts[1]).padStart(2, "0") + "00";
        const tEnd = String(Math.floor(endMin / 60)).padStart(2, "0") + String(endMin % 60).padStart(2, "0") + "00";
        ics += `DTSTART:${icsDate}T${tStart}\r\nDTEND:${icsDate}T${tEnd}\r\n`;
      } else {
        ics += `DTSTART;VALUE=DATE:${icsDate}\r\n`;
      }
      ics += `SUMMARY:${summary}\r\nSTATUS:CONFIRMED\r\n`;
      if (existing.location_detail) ics += `LOCATION:${existing.location_detail.replace(/[,;]/g, " ")}\r\n`;
      ics += "END:VEVENT\r\nEND:VCALENDAR";
      return ics;
    };

    // Helper to send notification email
    const sendEmail = async (
      subject: string,
      headerBg: string,
      headerTitle: string,
      tableRows: string,
      icsAttachment?: string
    ) => {
      const recipients = buildRecipients();
      if (!RESEND_API_KEY || recipients.length === 0) return;

      const html = `
        <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:${headerBg};padding:20px 24px;border-radius:8px 8px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:20px;">${headerTitle}</h1>
          </div>
          <div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
            <table style="width:100%;font-size:14px;color:#333;border-collapse:collapse;">
              <tr><td style="padding:8px 0;font-weight:bold;width:140px;">Project:</td><td>${projectName}</td></tr>
              <tr><td style="padding:8px 0;font-weight:bold;">Type:</td><td>${typeLabel}</td></tr>
              ${tableRows}
            </table>
          </div>
          <p style="color:#999;font-size:11px;text-align:center;margin-top:16px;">
            Sent via My Daily Reports &bull; mydailyreports.org
          </p>
        </div>
      `;

      // Strip HTML tags for plain-text version
      const textContent = html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&bull;/g, "-")
        .replace(/\s+/g, " ")
        .trim();

      const attachments: any[] = [];
      if (icsAttachment) {
        // Resend expects base64-encoded content for attachments
        const icsB64 = btoa(icsAttachment);
        attachments.push({ filename: "invite.ics", content: icsB64, content_type: "text/calendar; method=PUBLISH" });
      }

      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: `${ownerCompanyName || "My Daily Reports"} <${FROM_EMAIL}>`,
            reply_to: REPLY_TO,
            to: recipients,
            subject,
            html,
            text: textContent,
            headers: {
              "List-Unsubscribe": `<mailto:${FROM_EMAIL}?subject=unsubscribe>`,
            },
            ...(attachments.length > 0 ? { attachments } : {}),
          }),
        });
        console.log("Email result:", res.status, await res.text());
      } catch (emailErr) {
        console.error("Email send error:", emailErr);
      }
    };

    if (action === "cancel") {
      const { error: updateError } = await supabase
        .from("inspection_requests")
        .update({
          status: "cancelled",
          cancelled_by: action_by || "Unknown",
          cancel_reason: reason || "",
        })
        .eq("id", request_id);

      if (updateError) {
        return new Response(
          JSON.stringify({ success: false, error: updateError.message }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Only send notifications if owner has request_deleted enabled
      if (ownerNotifPrefs.request_deleted !== false) {
        await sendEmail(
          `CANCELLED: ${projectName} — ${typeLabel} on ${existing.inspection_date}`,
          "#c44",
          "Scheduling Request Cancelled",
          `<tr><td style="padding:8px 0;font-weight:bold;">Date:</td><td>${existing.inspection_date}</td></tr>
           <tr><td style="padding:8px 0;font-weight:bold;">Cancelled By:</td><td>${action_by || "Unknown"}</td></tr>
           ${reason ? `<tr><td style="padding:8px 0;font-weight:bold;">Reason:</td><td>${reason}</td></tr>` : ""}`
        );
        await sendNtfy("Request Cancelled", `${typeLabel} on ${existing.inspection_date} for ${projectName} was cancelled by ${action_by || "Unknown"}`, "x", "default");
      }

      return new Response(JSON.stringify({ success: true, action: "cancel" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else if (action === "edit") {
      if (!new_date && !new_time && !new_duration && new_notes === undefined) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Nothing to update — provide new_date, new_time, new_duration, or new_notes",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const editEntry = {
        edited_by: action_by || "Unknown",
        edited_at: new Date().toISOString(),
        old_date: existing.inspection_date,
        old_time: existing.inspection_time,
        new_date: new_date || existing.inspection_date,
        new_time: new_time || existing.inspection_time,
        new_duration: new_duration || null,
        new_notes: new_notes || null,
      };

      const editHistory = [...(existing.edit_history || []), editEntry];

      const updates: Record<string, unknown> = { edit_history: editHistory };
      if (new_date) {
        updates.inspection_date = new_date;
        updates.requested_date = new_date; // keep in sync for main app calendar
      }
      if (new_time) updates.inspection_time = new_time;
      if (new_duration) updates.duration = new_duration;
      if (new_notes !== undefined) updates.notes = new_notes;

      const { error: updateError } = await supabase
        .from("inspection_requests")
        .update(updates)
        .eq("id", request_id);

      if (updateError) {
        return new Response(
          JSON.stringify({ success: false, error: updateError.message }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // No email for edits — too noisy

      return new Response(JSON.stringify({ success: true, action: "edit" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else if (action === "schedule") {
      const { error: updateError } = await supabase
        .from("inspection_requests")
        .update({ status: "scheduled" })
        .eq("id", request_id);

      if (updateError) {
        return new Response(
          JSON.stringify({ success: false, error: updateError.message }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Only send notifications if owner has request_scheduled enabled
      if (ownerNotifPrefs.request_scheduled !== false) {
        const ics = buildICS();
        await sendEmail(
          `SCHEDULED: ${projectName} — ${typeLabel} on ${existing.inspection_date}`,
          "#4a4",
          "Scheduling Request Confirmed ✅",
          `<tr><td style="padding:8px 0;font-weight:bold;">Date:</td><td>${existing.inspection_date}</td></tr>
           <tr><td style="padding:8px 0;font-weight:bold;">Time:</td><td>${existing.flexible_display === "flexible" ? "Flexible" : existing.inspection_time}</td></tr>
           <tr><td style="padding:8px 0;font-weight:bold;">Submitted By:</td><td>${existing.submitted_by}</td></tr>
           <tr><td style="padding:8px 0;font-weight:bold;">Status:</td><td style="color:#4a4;font-weight:bold;">✅ Scheduled</td></tr>`,
          ics
        );
        await sendNtfy("Request Confirmed", `${typeLabel} on ${existing.inspection_date} for ${projectName} is confirmed`, "white_check_mark", "default");
      }

      return new Response(
        JSON.stringify({ success: true, action: "schedule" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    } else if (action === "delete") {
      const { error: updateError } = await supabase
        .from("inspection_requests")
        .update({
          status: "deleted",
          deleted_by: action_by || "Admin",
          deleted_at: new Date().toISOString(),
        })
        .eq("id", request_id);

      if (updateError) {
        return new Response(
          JSON.stringify({ success: false, error: updateError.message }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // No email for deletes — too noisy

      return new Response(JSON.stringify({ success: true, action: "delete" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Unknown action: ${action}. Use cancel, edit, delete, or schedule.`,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
  } catch (error) {
    console.error("[update-inspection] Uncaught error:", error.message, error.stack);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
