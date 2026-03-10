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

    // Parse multipart FormData (schedule.html sends files + metadata)
    const formData = await req.formData();

    const project = formData.get("project") as string;
    const inspectionDate = formData.get("inspection_date") as string;
    const inspectionTime = formData.get("inspection_time") as string;
    const inspectionTypesRaw = formData.get("inspection_types") as string;
    const duration = parseInt(formData.get("duration") as string) || 60;
    const submittedBy = formData.get("submitted_by") as string;
    const notes = (formData.get("notes") as string) || "";
    const subcontractor = (formData.get("subcontractor") as string) || "";
    const locationDetail = (formData.get("location_detail") as string) || "";
    const inspectionIdentifier =
      (formData.get("inspection_identifier") as string) || "";
    const emailRecipientsRaw =
      (formData.get("email_recipients") as string) || "[]";

    // Validate required fields
    if (!project || !inspectionDate || !inspectionTime || !submittedBy) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Parse JSON fields
    let inspectionTypes: string[] = [];
    try {
      inspectionTypes = JSON.parse(inspectionTypesRaw || "[]");
    } catch {
      inspectionTypes = [inspectionTypesRaw || "Regular"];
    }

    let emailRecipients: string[] = [];
    try {
      emailRecipients = JSON.parse(emailRecipientsRaw);
    } catch {
      emailRecipients = [];
    }

    // Determine flexible_display
    const flexibleDisplay = inspectionTime === "flexible" ? "flexible" : "";
    const actualTime =
      inspectionTime === "flexible" ? "08:00" : inspectionTime;

    // Upload files to Supabase Storage
    const fileUrls: string[] = [];
    const fileKeys = [...formData.keys()].filter((k) => k.startsWith("file_"));

    for (const key of fileKeys) {
      const file = formData.get(key) as File;
      if (!file || !file.name) continue;

      const timestamp = Date.now();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `${project}/${timestamp}_${safeName}`;

      const arrayBuffer = await file.arrayBuffer();
      const { error: uploadError } = await supabase.storage
        .from("scheduling-attachments")
        .upload(storagePath, arrayBuffer, {
          contentType: file.type,
          upsert: false,
        });

      if (uploadError) {
        console.error(`Upload error for ${file.name}:`, uploadError.message);
        continue;
      }

      const {
        data: { publicUrl },
      } = supabase.storage
        .from("scheduling-attachments")
        .getPublicUrl(storagePath);

      fileUrls.push(publicUrl);
    }

    // Look up the job owner via profile slug so we can link the request to them
    let ownerId = "";
    let ownerEmail = "";
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("slug", project)
        .single();
      if (profile) {
        ownerId = profile.id;
        const { data: authUser } = await supabase.auth.admin.getUserById(
          profile.id
        );
        if (authUser?.user?.email) ownerEmail = authUser.user.email;
      }
    } catch (e) {
      console.error("Owner lookup failed:", e);
    }

    // Insert inspection request — include user_id and requested_date so it shows on owner's calendar
    const insertData: Record<string, any> = {
      project,
      inspection_date: inspectionDate,
      inspection_time: actualTime,
      inspection_types: inspectionTypes,
      duration,
      submitted_by: submittedBy,
      notes,
      subcontractor,
      location_detail: locationDetail,
      inspection_identifier: inspectionIdentifier,
      email_recipients: emailRecipients,
      flexible_display: flexibleDisplay,
      status: "pending",
      requested_date: inspectionDate, // mirror for main app calendar query
    };
    if (ownerId) insertData.user_id = ownerId;

    const { data: inserted, error: insertError } = await supabase
      .from("inspection_requests")
      .insert(insertData)
      .select()
      .single();

    if (insertError) {
      return new Response(
        JSON.stringify({ success: false, error: insertError.message }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Send email notifications — always notify the job owner + any checked recipients
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FROM_EMAIL =
      Deno.env.get("FROM_EMAIL") || "reports@mydailyreports.org";

    if (RESEND_API_KEY) {
      // Combine owner email (looked up above) + checked recipients, deduplicate
      const allRecipients = [...emailRecipients];
      if (ownerEmail && !allRecipients.includes(ownerEmail)) {
        allRecipients.push(ownerEmail);
      }

      if (allRecipients.length > 0) {
        const typeLabel = inspectionTypes.join(", ");
        const timeLabel =
          flexibleDisplay === "flexible"
            ? "Flexible — anytime"
            : inspectionTime;

        // Build file attachments HTML
        const filesHtml =
          fileUrls.length > 0
            ? `<div style="margin-top:16px;padding:12px;background:#f0f0f0;border-radius:6px;">
            <strong style="font-size:13px;">Attached Files (${fileUrls.length}):</strong>
            <div style="margin-top:8px;">
              ${fileUrls
                .map(
                  (url, i) =>
                    `<a href="${url}" style="display:block;color:#e8742a;font-size:13px;margin:4px 0;">File ${i + 1}</a>`
                )
                .join("")}
            </div>
          </div>`
            : "";

        const emailHtml = `
          <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;">
            <div style="background:#e8742a;padding:20px 24px;border-radius:8px 8px 0 0;">
              <h1 style="color:#fff;margin:0;font-size:20px;">New Scheduling Request</h1>
            </div>
            <div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
              <table style="width:100%;font-size:14px;color:#333;border-collapse:collapse;">
                <tr><td style="padding:8px 0;font-weight:bold;width:140px;">Project:</td><td style="padding:8px 0;">${project.replace(/-/g, " ")}</td></tr>
                <tr><td style="padding:8px 0;font-weight:bold;">Date:</td><td style="padding:8px 0;">${inspectionDate}</td></tr>
                <tr><td style="padding:8px 0;font-weight:bold;">Time:</td><td style="padding:8px 0;">${timeLabel}</td></tr>
                <tr><td style="padding:8px 0;font-weight:bold;">Type:</td><td style="padding:8px 0;">${typeLabel}</td></tr>
                <tr><td style="padding:8px 0;font-weight:bold;">Duration:</td><td style="padding:8px 0;">${duration >= 480 ? "All Day" : duration >= 60 ? duration / 60 + " hr" : duration + " min"}</td></tr>
                <tr><td style="padding:8px 0;font-weight:bold;">Submitted By:</td><td style="padding:8px 0;">${submittedBy}</td></tr>
                ${inspectionIdentifier ? `<tr><td style="padding:8px 0;font-weight:bold;">Request #:</td><td style="padding:8px 0;">${inspectionIdentifier}</td></tr>` : ""}
                ${notes ? `<tr><td style="padding:8px 0;font-weight:bold;">Notes:</td><td style="padding:8px 0;">${notes}</td></tr>` : ""}
              </table>
              ${filesHtml}
            </div>
            <p style="color:#999;font-size:11px;text-align:center;margin-top:16px;">
              Sent via My Daily Reports &bull; mydailyreports.org
            </p>
          </div>
        `;

        try {
          const emailRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${RESEND_API_KEY}`,
            },
            body: JSON.stringify({
              from: `My Daily Reports <${FROM_EMAIL}>`,
              to: allRecipients,
              subject: `Scheduling Request: ${project.replace(/-/g, " ")} — ${typeLabel} on ${inspectionDate}`,
              html: emailHtml,
            }),
          });
          console.log("Email send result:", emailRes.status, await emailRes.text());
        } catch (emailErr) {
          console.error("Email send error:", emailErr);
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, id: inserted.id, files: fileUrls }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
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
