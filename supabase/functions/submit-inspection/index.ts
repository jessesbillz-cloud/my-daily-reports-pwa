import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

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
    const inspectionIdentifier = (formData.get("inspection_identifier") as string) || "";
    const emailRecipientsRaw = (formData.get("email_recipients") as string) || "[]";
    const requesterEmail = (formData.get("requester_email") as string) || "";
    const requesterName = (formData.get("requester_name") as string) || "";
    const requesterCompany = (formData.get("requester_company") as string) || "";
    const specialType = (formData.get("special_type") as string) || "";

    if (!project || !inspectionDate || !inspectionTime || !submittedBy) {
      return new Response(JSON.stringify({ success: false, error: "Missing required fields" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let inspectionTypes: string[] = [];
    try { inspectionTypes = JSON.parse(inspectionTypesRaw || "[]"); } catch { inspectionTypes = [inspectionTypesRaw || "Regular"]; }
    let emailRecipients: string[] = [];
    try { emailRecipients = JSON.parse(emailRecipientsRaw); } catch { emailRecipients = []; }

    const flexibleDisplay = inspectionTime === "flexible" ? "flexible" : "";
    const actualTime = inspectionTime === "flexible" ? "08:00" : inspectionTime;

    // Upload files
    const fileUrls: string[] = [];
    const fileKeys = [...formData.keys()].filter((k) => k.startsWith("file_"));
    for (const key of fileKeys) {
      const file = formData.get(key) as File;
      if (!file || !file.name) continue;
      const timestamp = Date.now();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `${project}/${timestamp}_${safeName}`;
      const arrayBuffer = await file.arrayBuffer();
      const { error: uploadError } = await supabase.storage.from("scheduling-attachments").upload(storagePath, arrayBuffer, { contentType: file.type, upsert: false });
      if (uploadError) { console.error(`Upload error for ${file.name}:`, uploadError.message); continue; }
      const { data: { publicUrl } } = supabase.storage.from("scheduling-attachments").getPublicUrl(storagePath);
      fileUrls.push(publicUrl);
    }

    // Look up job owner
    let ownerId = "";
    let ownerEmail = "";
    let ownerPushSub: any = null;
    let ownerNtfyTopic = "";
    let ownerCompanyName = "";

    try {
      const { data: allJobs } = await supabase.from("jobs").select("user_id, name").limit(200);
      const projectLower = project.toLowerCase();
      const matchedJob = (allJobs || []).find((j: any) => (j.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-") === projectLower);
      if (matchedJob) ownerId = matchedJob.user_id;
    } catch (e) { console.error("Job lookup failed:", e); }

    if (!ownerId) {
      try {
        const { data: profile } = await supabase.from("profiles").select("id").eq("slug", project).single();
        if (profile) ownerId = profile.id;
      } catch (e) {}
    }

    if (ownerId) {
      try {
        const { data: profile } = await supabase.from("profiles").select("ntfy_topic, company_name, push_subscription").eq("id", ownerId).single();
        if (profile) {
          ownerNtfyTopic = profile.ntfy_topic || "";
          ownerCompanyName = profile.company_name || "";
          ownerPushSub = profile.push_subscription || null;
        }
        const { data: authUser } = await supabase.auth.admin.getUserById(ownerId);
        if (authUser?.user?.email) ownerEmail = authUser.user.email;
      } catch (e) { console.error("Owner profile lookup failed:", e); }
    }

    let siteAddress = locationDetail;
    if (!siteAddress && ownerId) {
      try {
        const { data: jobs } = await supabase.from("jobs").select("site_address, name").eq("user_id", ownerId).limit(10);
        const matchJob = (jobs || []).find((j: any) => j.site_address && (j.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-") === project);
        if (matchJob?.site_address) siteAddress = matchJob.site_address;
        if (!siteAddress && jobs?.length === 1 && jobs[0].site_address) siteAddress = jobs[0].site_address;
      } catch (e) { console.error("Job address lookup:", e); }
    }

    // Server-side conflict detection
    // Rules: Regular blocks across ALL projects. Special only blocks if type is Concrete, Shotcrete, or Grout.
    // Other special types (Soils, Material ID, Bolting, etc.) do NOT block.
    const BLOCKING_SPECIAL_TYPES = ["Concrete", "Shotcrete", "Grout"];
    const isRegular = inspectionTypes.includes("Regular");
    const isBlockingSpecial = BLOCKING_SPECIAL_TYPES.some(t => inspectionTypes.includes(t) || specialType === t);
    const incomingBlocks = isRegular || isBlockingSpecial;

    if (incomingBlocks && flexibleDisplay !== "flexible") {
      const reqStart = parseInt(actualTime.split(":")[0]) * 60 + parseInt(actualTime.split(":")[1]);
      const reqEnd = reqStart + duration;

      // For Regular: check ALL projects for Regular + blocking-special conflicts on this date
      // For blocking specials: also check ALL projects
      const { data: existing } = await supabase
        .from("inspection_requests")
        .select("id, inspection_time, duration, status, inspection_types, flexible_display")
        .eq("inspection_date", inspectionDate)
        .neq("status", "cancelled")
        .neq("status", "deleted");

      if (existing && existing.length > 0) {
        const conflict = existing.find((r: any) => {
          const rTypes = r.inspection_types || [];
          const rIsRegular = rTypes.includes("Regular");
          const rIsBlockingSpecial = BLOCKING_SPECIAL_TYPES.some((t: string) => rTypes.includes(t));
          // Only conflict against other blocking types
          if (!rIsRegular && !rIsBlockingSpecial) return false;
          // Flexible existing requests block all day
          if (r.flexible_display === "flexible") return true;
          const rStart = parseInt((r.inspection_time || "08:00").split(":")[0]) * 60 + parseInt((r.inspection_time || "08:00").split(":")[1]);
          const rEnd = rStart + (parseInt(r.duration) || 60);
          return reqStart < rEnd && reqEnd > rStart;
        });
        if (conflict) {
          return new Response(JSON.stringify({ success: false, error: `Time conflict: an existing request already covers ${actualTime} on ${inspectionDate}` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }
    }

    const insertData: Record<string, any> = {
      project, inspection_date: inspectionDate, inspection_time: actualTime,
      inspection_types: inspectionTypes, duration, submitted_by: submittedBy,
      notes, subcontractor, location_detail: siteAddress,
      inspection_identifier: inspectionIdentifier, email_recipients: emailRecipients,
      flexible_display: flexibleDisplay, status: "pending", requested_date: inspectionDate,
    };
    if (ownerId) insertData.user_id = ownerId;
    if (requesterEmail) insertData.requester_email = requesterEmail;
    if (requesterName) insertData.requester_name = requesterName;
    if (requesterCompany) insertData.requester_company = requesterCompany;
    if (specialType) insertData.special_type = specialType;
    if (fileUrls.length > 0) insertData.file_urls = fileUrls;

    const { data: inserted, error: insertError } = await supabase.from("inspection_requests").insert(insertData).select().single();
    if (insertError) {
      return new Response(JSON.stringify({ success: false, error: insertError.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (ownerId) {
      try {
        await supabase.from("inspection_requests").update({ user_id: ownerId }).eq("project", project).is("user_id", null);
        const { data: orphans } = await supabase.from("inspection_requests").select("id, inspection_date").eq("project", project).is("requested_date", null).not("inspection_date", "is", null);
        if (orphans && orphans.length > 0) { for (const o of orphans) { await supabase.from("inspection_requests").update({ requested_date: o.inspection_date }).eq("id", o.id); } }
      } catch (e) { console.error("Backfill error (non-fatal):", e); }
    }

    // Email
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "reports@mydailyreports.org";
    if (RESEND_API_KEY) {
      const allRecipients = [...emailRecipients];
      if (ownerEmail && !allRecipients.includes(ownerEmail)) allRecipients.push(ownerEmail);
      if (allRecipients.length > 0) {
        const typeLabel = inspectionTypes.join(", ");
        const timeLabel = flexibleDisplay === "flexible" ? "Flexible — anytime" : inspectionTime;
        const filesHtml = fileUrls.length > 0 ? `<div style="margin-top:16px;padding:12px;background:#f0f0f0;border-radius:6px;"><strong style="font-size:13px;">Attached Files (${fileUrls.length}):</strong><div style="margin-top:8px;">${fileUrls.map((url, i) => `<a href="${url}" style="display:block;color:#e8742a;font-size:13px;margin:4px 0;">File ${i + 1}</a>`).join("")}</div></div>` : "";
        const emailHtml = `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;"><div style="background:#e8742a;padding:20px 24px;border-radius:8px 8px 0 0;"><h1 style="color:#fff;margin:0;font-size:20px;">New Scheduling Request</h1></div><div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;"><table style="width:100%;font-size:14px;color:#333;border-collapse:collapse;"><tr><td style="padding:8px 0;font-weight:bold;width:140px;">Project:</td><td style="padding:8px 0;">${project.replace(/-/g, " ")}</td></tr><tr><td style="padding:8px 0;font-weight:bold;">Date:</td><td style="padding:8px 0;">${inspectionDate}</td></tr><tr><td style="padding:8px 0;font-weight:bold;">Time:</td><td style="padding:8px 0;">${timeLabel}</td></tr><tr><td style="padding:8px 0;font-weight:bold;">Type:</td><td style="padding:8px 0;">${typeLabel}</td></tr><tr><td style="padding:8px 0;font-weight:bold;">Duration:</td><td style="padding:8px 0;">${duration >= 480 ? "All Day" : duration >= 60 ? duration / 60 + " hr" : duration + " min"}</td></tr><tr><td style="padding:8px 0;font-weight:bold;">Submitted By:</td><td style="padding:8px 0;">${submittedBy}</td></tr>${inspectionIdentifier ? `<tr><td style="padding:8px 0;font-weight:bold;">Request #:</td><td style="padding:8px 0;">${inspectionIdentifier}</td></tr>` : ""}${notes ? `<tr><td style="padding:8px 0;font-weight:bold;">Notes:</td><td style="padding:8px 0;">${notes}</td></tr>` : ""}</table>${filesHtml}</div><p style="color:#999;font-size:11px;text-align:center;margin-top:16px;">Sent via My Daily Reports &bull; mydailyreports.org</p></div>`;
        try {
          const emailRes = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` }, body: JSON.stringify({ from: `${ownerCompanyName || "My Daily Reports"} <${FROM_EMAIL}>`, to: allRecipients, subject: `Scheduling Request: ${project.replace(/-/g, " ")} — ${typeLabel} on ${inspectionDate}`, html: emailHtml }) });
          console.log("Email send result:", emailRes.status, await emailRes.text());
        } catch (emailErr) { console.error("Email send error:", emailErr); }
      }
    }

    // Push notification — Web Push first, ntfy fallback
    const typeLabel = inspectionTypes.join(", ");
    const timeLabel = flexibleDisplay === "flexible" ? "Flexible" : inspectionTime;
    const pushTitle = "New Scheduling Request";
    const pushBody = `${submittedBy} requested ${typeLabel} on ${inspectionDate} at ${timeLabel} for ${project.replace(/-/g, " ")}`;

    if (ownerPushSub && ownerPushSub.endpoint) {
      try {
        const pushRes = await fetch(ownerPushSub.endpoint, { method: "POST", headers: { "Content-Type": "application/json", "TTL": "86400" }, body: JSON.stringify({ title: pushTitle, body: pushBody, tag: "scheduling-" + inserted.id }) });
        console.log("Web push result:", pushRes.status);
      } catch (pushErr) { console.error("Web push error (non-fatal):", pushErr); }
    } else if (ownerNtfyTopic) {
      try {
        await fetch(`https://ntfy.sh/${ownerNtfyTopic}`, { method: "POST", headers: { "Title": pushTitle, "Priority": "high", "Tags": "calendar" }, body: pushBody });
      } catch (ntfyErr) { console.error("ntfy push error (non-fatal):", ntfyErr); }
    }

    return new Response(JSON.stringify({ success: true, id: inserted.id, files: fileUrls }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
