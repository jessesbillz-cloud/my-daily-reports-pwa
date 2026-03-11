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
    const { to, subject, body, html_body, pdf_base64, pdf_filename, sender_name } = await req.json();

    if (!to || !to.length) {
      return new Response(JSON.stringify({ error: "No recipients" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      return new Response(
        JSON.stringify({ error: "RESEND_API_KEY not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

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
            console.warn("Skipped suppressed emails:", skippedEmails);
          }
        }
      } catch (suppErr) {
        // If suppression check fails, send to all — don't block the report
        console.error("Suppression check failed (sending anyway):", suppErr);
      }
    }

    if (validRecipients.length === 0) {
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

    // Use custom HTML body if provided, fallback to plain body text
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

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `${sender_name || "My Daily Reports"} <${FROM_EMAIL}>`,
        to: validRecipients,
        subject: subject,
        html: emailHtml,
        attachments: pdf_base64
          ? [
              {
                filename: pdf_filename || "report.pdf",
                content: pdf_base64,
                type: "application/pdf",
              },
            ]
          : [],
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: result.message || "Email send failed" }),
        {
          status: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
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
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
