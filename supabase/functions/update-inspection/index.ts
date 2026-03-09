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

    if (action === "cancel") {
      // Cancel the inspection request
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

      // Send cancellation email if recipients exist
      const recipients = existing.email_recipients || [];
      if (recipients.length > 0) {
        const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
        const FROM_EMAIL =
          Deno.env.get("FROM_EMAIL") || "reports@mydailyreports.com";

        if (RESEND_API_KEY) {
          const projectName = (existing.project || "").replace(/-/g, " ");
          const typeLabel = (existing.inspection_types || []).join(", ");

          try {
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${RESEND_API_KEY}`,
              },
              body: JSON.stringify({
                from: `My Daily Reports <${FROM_EMAIL}>`,
                to: recipients,
                subject: `CANCELLED: ${projectName} — ${typeLabel} on ${existing.inspection_date}`,
                html: `
                  <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;">
                    <div style="background:#c44;padding:20px 24px;border-radius:8px 8px 0 0;">
                      <h1 style="color:#fff;margin:0;font-size:20px;">Scheduling Request Cancelled</h1>
                    </div>
                    <div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
                      <table style="width:100%;font-size:14px;color:#333;border-collapse:collapse;">
                        <tr><td style="padding:8px 0;font-weight:bold;width:140px;">Project:</td><td>${projectName}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:bold;">Date:</td><td>${existing.inspection_date}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:bold;">Type:</td><td>${typeLabel}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:bold;">Cancelled By:</td><td>${action_by || "Unknown"}</td></tr>
                        ${reason ? `<tr><td style="padding:8px 0;font-weight:bold;">Reason:</td><td>${reason}</td></tr>` : ""}
                      </table>
                    </div>
                    <p style="color:#999;font-size:11px;text-align:center;margin-top:16px;">
                      Sent via My Daily Reports &bull; mydailyreports.org
                    </p>
                  </div>
                `,
              }),
            });
          } catch (emailErr) {
            console.error("Cancel email error:", emailErr);
          }
        }
      }

      return new Response(JSON.stringify({ success: true, action: "cancel" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else if (action === "edit") {
      // Edit the inspection request (reschedule date/time)
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

      // Build edit history entry
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
      if (new_date) updates.inspection_date = new_date;
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

      // Send edit notification email if recipients exist
      const recipients = existing.email_recipients || [];
      if (recipients.length > 0) {
        const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
        const FROM_EMAIL =
          Deno.env.get("FROM_EMAIL") || "reports@mydailyreports.com";

        if (RESEND_API_KEY) {
          const projectName = (existing.project || "").replace(/-/g, " ");
          const typeLabel = (existing.inspection_types || []).join(", ");

          try {
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${RESEND_API_KEY}`,
              },
              body: JSON.stringify({
                from: `My Daily Reports <${FROM_EMAIL}>`,
                to: recipients,
                subject: `UPDATED: ${projectName} — ${typeLabel} rescheduled`,
                html: `
                  <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;">
                    <div style="background:#e8742a;padding:20px 24px;border-radius:8px 8px 0 0;">
                      <h1 style="color:#fff;margin:0;font-size:20px;">Scheduling Request Updated</h1>
                    </div>
                    <div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
                      <table style="width:100%;font-size:14px;color:#333;border-collapse:collapse;">
                        <tr><td style="padding:8px 0;font-weight:bold;width:140px;">Project:</td><td>${projectName}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:bold;">Type:</td><td>${typeLabel}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:bold;">Old Date:</td><td>${existing.inspection_date}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:bold;">New Date:</td><td style="color:#e8742a;font-weight:bold;">${new_date || existing.inspection_date}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:bold;">Old Time:</td><td>${existing.inspection_time}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:bold;">New Time:</td><td style="color:#e8742a;font-weight:bold;">${new_time || existing.inspection_time}</td></tr>
                        <tr><td style="padding:8px 0;font-weight:bold;">Updated By:</td><td>${action_by || "Unknown"}</td></tr>
                      </table>
                    </div>
                    <p style="color:#999;font-size:11px;text-align:center;margin-top:16px;">
                      Sent via My Daily Reports &bull; mydailyreports.org
                    </p>
                  </div>
                `,
              }),
            });
          } catch (emailErr) {
            console.error("Edit email error:", emailErr);
          }
        }
      }

      return new Response(JSON.stringify({ success: true, action: "edit" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else if (action === "schedule") {
      // Mark as scheduled
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
