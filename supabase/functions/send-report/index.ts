import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log("[send-report] Starting — parsing request body");
    const { to, subject, body, html_body, pdf_base64, pdf_filename, sender_name } = await req.json();
    console.log("[send-report] Recipients:", JSON.stringify(to), "Subject:", subject?.slice(0, 60), "Has PDF:", !!pdf_base64, "PDF size:", pdf_base64?.length || 0);

    if (!to || !to.length) {
      console.error("[send-report] No recipients provided");
      return new Response(JSON.stringify({ error: "No recipients" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      console.error("[send-report] RESEND_API_KEY not found in env");
      return new Response(
        JSON.stringify({ error: "RESEND_API_KEY not configured. Set it in Edge Function secrets." }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    console.log("[send-report] RESEND_API_KEY found, length:", RESEND_API_KEY.length, "prefix:", RESEND_API_KEY.slice(0, 6));

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // Filter out suppressed email addresses (bounced/complained)
    let validRecipients = [...to];
    let skippedEmails: string[] = [];

    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const normalized = to.map((e: string) => e.toLowerCase().trim());
        const { data: suppressed } = await supabase
          .from("email_suppressions")
          .select("email")
          .eq("suppressed", true)
          .in("email", normalized);

        if (suppressed && suppressed.length > 0) {
          const suppressedSet = new Set(suppressed.map((s: { email: string }) => s.email));
          validRecipients = to.filter((e: string) => !suppressedSet.has(e.toLowerCase().trim()));
          skippedEmails = to.filter((e: string) => suppressedSet.has(e.toLowerCase().trim()));
          if (skippedEmails.length > 0) {
            console.warn("[send-report] Skipped suppressed:", skippedEmails);
          }
        }
      } catch (suppErr) {
        console.error("[send-report] Suppression check failed (sending anyway):", suppErr);
      }
    }

    if (validRecipients.length === 0) {
      console.error("[send-report] All recipients suppressed");
      return new Response(
        JSON.stringify({
          error: "All recipients are suppressed due to previous bounces or complaints.",
          skipped: skippedEmails,
        }),
        {
          status: 422,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "reports@mydailyreports.org";
    console.log("[send-report] Sending from:", FROM_EMAIL, "to:", validRecipients, "sender_name:", sender_name);

    const emailHtml = html_body || `
      <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #e8742a; padding: 20px 24px; border-radius: 8px 8px 0 0;">
          <h1 style="color: #fff; margin: 0; font-size: 20px;">My Daily Reports</h1>
        </div>
        <div style="background: #f9f9f9; padding: 24px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
          <p style="color: #333; font-size: 15px; line-height: 1.6; margin: 0 0 16px;">${body || "A daily report has been submitted."}</p>
          <p style="color: #666; font-size: 13px; margin: 0;">The PDF report is attached to this email.</p>
        </div>
        <p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">
          Sent via My Daily Reports &bull; mydailyreports.org
        </p>
      </div>
    `;

    console.log("[send-report] Calling Resend API...");
    const resendPayload = {
      from: `${sender_name || "My Daily Reports"} <${FROM_EMAIL}>`,
      to: validRecipients,
      subject: subject,
      html: emailHtml,
      attachments: pdf_base64
        ? [{ filename: pdf_filename || "report.pdf", content: pdf_base64 }]
        : [],
    };

    // Rate-limit aware send with retry + exponential backoff (Resend Pro = 2 req/sec)
    const MAX_RETRIES = 3;
    let response: Response | null = null;
    let result: any = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify(resendPayload),
      });

      result = await response.json();
      console.log(`[send-report] Resend response (attempt ${attempt + 1}):`, response.status, JSON.stringify(result));

      if (response.status === 429 && attempt < MAX_RETRIES) {
        // Rate limited — back off exponentially: 500ms, 1s, 2s
        const delay = 500 * Math.pow(2, attempt);
        console.warn(`[send-report] Rate limited (429), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      break; // success or non-retryable error
    }

    if (!response!.ok) {
      // IMPORTANT: return 502 (not Resend's status) so the client doesn't confuse
      // a Resend 401 (bad API key) with a Supabase 401 (expired JWT)
      const resendError = result.message || result.name || "Email send failed";
      console.error("[send-report] Resend error:", response!.status, resendError, JSON.stringify(result));
      return new Response(
        JSON.stringify({ error: `Resend API error (${response!.status}): ${resendError}`, resend_status: response!.status, details: result }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    console.log("[send-report] Success! Email ID:", result.id);

    // Increment monthly send counter and check threshold
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      try {
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const { data: counterData } = await sb.rpc("increment_email_counter");
        if (counterData) {
          const cnt = counterData.count;
          const alertSent = counterData.alert_sent;
          const MONTHLY_LIMIT = 50000;
          const THRESHOLD = Math.floor(MONTHLY_LIMIT * 0.8); // 40,000
          console.log(`[send-report] Monthly send count: ${cnt}/${MONTHLY_LIMIT}`);

          if (cnt >= THRESHOLD && !alertSent) {
            // Fire alert — ntfy + email to owner
            console.warn(`[send-report] ALERT: ${cnt} emails sent this month (${Math.round(cnt/MONTHLY_LIMIT*100)}% of limit)`);
            const alertMsg = `⚠️ Resend Email Alert: ${cnt.toLocaleString()} / ${MONTHLY_LIMIT.toLocaleString()} emails sent this month (${Math.round(cnt/MONTHLY_LIMIT*100)}%). Upgrade plan or reduce volume soon.`;

            // ntfy alert
            try {
              await fetch("https://ntfy.sh/mdr-system-alerts", {
                method: "POST",
                headers: { "Title": "Email Limit Warning", "Priority": "urgent", "Tags": "warning,email" },
                body: alertMsg,
              });
            } catch (e) { console.error("[send-report] ntfy alert failed:", e); }

            // Self-email alert
            try {
              await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
                body: JSON.stringify({
                  from: `MDR System <${Deno.env.get("FROM_EMAIL") || "reports@mydailyreports.org"}>`,
                  to: ["jessesbillz@gmail.com"],
                  subject: `⚠️ Resend Limit Alert: ${cnt.toLocaleString()} / ${MONTHLY_LIMIT.toLocaleString()} emails`,
                  html: `<div style="font-family:sans-serif;padding:20px;"><h2 style="color:#e8742a;">Email Volume Alert</h2><p>Your MDR app has sent <strong>${cnt.toLocaleString()}</strong> of your <strong>${MONTHLY_LIMIT.toLocaleString()}</strong> monthly Resend emails (${Math.round(cnt/MONTHLY_LIMIT*100)}%).</p><p>Consider upgrading your Resend plan or monitoring volume closely.</p></div>`,
                }),
              });
            } catch (e) { console.error("[send-report] alert email failed:", e); }

            // Mark alert as sent so we don't spam
            await sb.rpc("mark_email_alert_sent");
          }
        }
      } catch (counterErr) {
        console.error("[send-report] Counter increment failed (non-fatal):", counterErr);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        id: result.id,
        sent_to: validRecipients,
        skipped: skippedEmails.length > 0 ? skippedEmails : undefined,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("[send-report] Uncaught error:", error.message, error.stack);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
