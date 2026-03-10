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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { request_id, action, action_by, reason, new_date, new_time } = body;

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

    // Look up the job owner's email via profile slug so they always get notified
    let ownerEmail = "";
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("slug", existing.project)
        .single();
      if (profile) {
        const { data: authUser } = await supabase.auth.admin.getUserById(
          profile.id
        );
        if (authUser?.user?.email) ownerEmail = authUser.user.email;
      }
    } catch (e) {
      console.error("Owner lookup failed:", e);
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
    const projectName = (existing.project || "").replace(/-/g, " ");
    const typeLabel = (existing.inspection_types || []).join(", ");

    // Helper to send notification email
    const sendEmail = async (
      subject: string,
      headerBg: string,
      headerTitle: string,
      tableRows: string
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

      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: `My Daily Reports <${FROM_EMAIL}>`,
            to: recipients,
            subject,
            html,
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

      await sendEmail(
        `CANCELLED: ${projectName} — ${typeLabel} on ${existing.inspection_date}`,
        "#c44",
        "Scheduling Request Cancelled",
        `<tr><td style="padding:8px 0;font-weight:bold;">Date:</td><td>${existing.inspection_date}</td></tr>
         <tr><td style="padding:8px 0;font-weight:bold;">Cancelled By:</td><td>${action_by || "Unknown"}</td></tr>
         ${reason ? `<tr><td style="padding:8px 0;font-weight:bold;">Reason:</td><td>${reason}</td></tr>` : ""}`
      );

      return new Response(JSON.stringify({ success: true, action: "cancel" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else if (action === "edit") {
      if (!new_date && !new_time) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Nothing to update — provide new_date or new_time",
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
      };

      const editHistory = [...(existing.edit_history || []), editEntry];

      const updates: Record<string, unknown> = { edit_history: editHistory };
      if (new_date) {
        updates.inspection_date = new_date;
        updates.requested_date = new_date; // keep in sync for main app calendar
      }
      if (new_time) updates.inspection_time = new_time;

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

      await sendEmail(
        `UPDATED: ${projectName} — ${typeLabel} rescheduled`,
        "#e8742a",
        "Scheduling Request Updated",
        `<tr><td style="padding:8px 0;font-weight:bold;">Old Date:</td><td>${existing.inspection_date}</td></tr>
         <tr><td style="padding:8px 0;font-weight:bold;">New Date:</td><td style="color:#e8742a;font-weight:bold;">${new_date || existing.inspection_date}</td></tr>
         <tr><td style="padding:8px 0;font-weight:bold;">Old Time:</td><td>${existing.inspection_time}</td></tr>
         <tr><td style="padding:8px 0;font-weight:bold;">New Time:</td><td style="color:#e8742a;font-weight:bold;">${new_time || existing.inspection_time}</td></tr>
         <tr><td style="padding:8px 0;font-weight:bold;">Updated By:</td><td>${action_by || "Unknown"}</td></tr>`
      );

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

      await sendEmail(
        `SCHEDULED: ${projectName} — ${typeLabel} on ${existing.inspection_date}`,
        "#4a4",
        "Scheduling Request Confirmed ✅",
        `<tr><td style="padding:8px 0;font-weight:bold;">Date:</td><td>${existing.inspection_date}</td></tr>
         <tr><td style="padding:8px 0;font-weight:bold;">Time:</td><td>${existing.flexible_display === "flexible" ? "Flexible" : existing.inspection_time}</td></tr>
         <tr><td style="padding:8px 0;font-weight:bold;">Submitted By:</td><td>${existing.submitted_by}</td></tr>
         <tr><td style="padding:8px 0;font-weight:bold;">Status:</td><td style="color:#4a4;font-weight:bold;">✅ Scheduled</td></tr>`
      );

      return new Response(
        JSON.stringify({ success: true, action: "schedule" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    } else {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Unknown action: ${action}. Use cancel, edit, or schedule.`,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
