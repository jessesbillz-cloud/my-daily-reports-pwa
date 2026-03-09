import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email, full_name } = await req.json();

    if (!email) {
      return new Response(JSON.stringify({ error: "No email provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      return new Response(
        JSON.stringify({ error: "RESEND_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "reports@mydailyreports.org";
    const firstName = (full_name || "").split(" ")[0] || "there";

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
        <div style="background: #e8742a; padding: 24px 32px; border-radius: 8px 8px 0 0;">
          <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 700;">Welcome to My Daily Reports</h1>
        </div>
        <div style="padding: 32px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
          <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0 0 20px;">
            Hey ${firstName}! Your account is all set up and ready to go.
          </p>
          <p style="color: #555; font-size: 15px; line-height: 1.6; margin: 0 0 20px;">
            Here's how to get started:
          </p>
          <div style="background: #f8f8f8; border-radius: 8px; padding: 20px; margin: 0 0 24px;">
            <div style="margin-bottom: 16px;">
              <span style="display: inline-block; width: 28px; height: 28px; background: #e8742a; color: #fff; border-radius: 50%; text-align: center; line-height: 28px; font-weight: 700; font-size: 14px; margin-right: 10px;">1</span>
              <span style="color: #333; font-size: 15px; font-weight: 600;">Create your first job</span>
              <p style="color: #666; font-size: 14px; margin: 6px 0 0 38px;">Tap "+ New Job" and enter your project name.</p>
            </div>
            <div style="margin-bottom: 16px;">
              <span style="display: inline-block; width: 28px; height: 28px; background: #e8742a; color: #fff; border-radius: 50%; text-align: center; line-height: 28px; font-weight: 700; font-size: 14px; margin-right: 10px;">2</span>
              <span style="color: #333; font-size: 15px; font-weight: 600;">Upload your template</span>
              <p style="color: #666; font-size: 14px; margin: 6px 0 0 38px;">Drop in your PDF or DOCX inspection form. AI will detect all the fields automatically.</p>
            </div>
            <div style="margin-bottom: 16px;">
              <span style="display: inline-block; width: 28px; height: 28px; background: #e8742a; color: #fff; border-radius: 50%; text-align: center; line-height: 28px; font-weight: 700; font-size: 14px; margin-right: 10px;">3</span>
              <span style="color: #333; font-size: 15px; font-weight: 600;">Add your team</span>
              <p style="color: #666; font-size: 14px; margin: 6px 0 0 38px;">Enter team email addresses so reports are automatically distributed when you submit.</p>
            </div>
            <div>
              <span style="display: inline-block; width: 28px; height: 28px; background: #e8742a; color: #fff; border-radius: 50%; text-align: center; line-height: 28px; font-weight: 700; font-size: 14px; margin-right: 10px;">4</span>
              <span style="color: #333; font-size: 15px; font-weight: 600;">Fill out and submit</span>
              <p style="color: #666; font-size: 14px; margin: 6px 0 0 38px;">Fill in your daily fields, attach photos, and hit Submit. Your report is generated and emailed instantly.</p>
            </div>
          </div>
          <p style="color: #555; font-size: 15px; line-height: 1.6; margin: 0 0 20px;">
            Check the <strong>Training Center</strong> inside the app for detailed guides and tips.
          </p>
          <p style="color: #555; font-size: 15px; line-height: 1.6; margin: 0;">
            Questions? Reply to this email anytime — we're here to help.
          </p>
        </div>
        <p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">
          My Daily Reports &bull; mydailyreports.org
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
        from: `My Daily Reports <${FROM_EMAIL}>`,
        to: [email],
        subject: "Welcome to My Daily Reports — let's get you set up",
        html,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: result.message || "Welcome email failed" }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ success: true, id: result.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
