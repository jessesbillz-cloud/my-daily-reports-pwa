#!/bin/bash
set -e
cd ~/Documents/my-daily-reports-pwa

# ── Backups ──
cp index.html index.html.bak
cp sw.js sw.js.bak
cp supabase/functions/submit-inspection/index.ts supabase/functions/submit-inspection/index.ts.bak
echo "✅ Backups created"

# ── 1. Write new sw.js ──
cat > sw.js << 'SWEOF'
const CACHE_NAME = 'mdr-v135';
const CACHE_URLS = [
  '/icon-192.png',
  '/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js',
  'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('push', e => {
  let data = { title: 'My Daily Reports', body: 'New notification' };
  try { if (e.data) data = e.data.json(); } catch (err) { if (e.data) data.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(data.title || 'My Daily Reports', {
    body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png',
    tag: data.tag || 'mdr-notification', data: data.url || '/', vibrate: [200, 100, 200],
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
    for (const w of wins) { if (w.url.includes('mydailyreports') && 'focus' in w) return w.focus(); }
    return clients.openWindow(url);
  }));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith(fetch(e.request).then(resp => { const clone = resp.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone)); return resp; }).catch(() => caches.match(e.request)));
    return;
  }
  if (url.hostname.includes('supabase') || url.pathname.startsWith('/functions/')) { e.respondWith(fetch(e.request)); return; }
  e.respondWith(caches.match(e.request).then(cached => {
    if (cached) return cached;
    return fetch(e.request).then(resp => { if (resp.ok) { const clone = resp.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone)); } return resp; });
  }));
});
SWEOF
echo "✅ sw.js written"

# ── 2. Fix emails in index.html ──
sed -i '' 's/jessesbillz@gmail.com/support@mydailyreports.org/g' index.html
echo "✅ Email references fixed"

# ── 3. Patch index.html with python (all push notification changes) ──
python3 << 'PYEOF'
with open("index.html", "r") as f:
    c = f.read()

changes = 0

# A. Add push state vars
old = 'const [ntfyTopic,setNtfyTopic]=useState("");'
new = 'const [ntfyTopic,setNtfyTopic]=useState(""); const [pushEnabled,setPushEnabled]=useState(false); const [pushLoading,setPushLoading]=useState(false);'
if old in c:
    c = c.replace(old, new)
    changes += 1

# B. Add push check on profile load
old = 'if(p.ntfy_topic)setNtfyTopic(p.ntfy_topic);'
new = 'if(p.ntfy_topic)setNtfyTopic(p.ntfy_topic); if(p.push_subscription)setPushEnabled(true);'
if old in c:
    c = c.replace(old, new)
    changes += 1

# C. Update notification description
old = 'Email reminders are sent based on your per-job reminder settings. Push notifications use ntfy for real-time scheduling alerts.'
new = 'Email reminders are sent based on your per-job reminder settings. Push notifications deliver real-time scheduling alerts directly to your device.'
if old in c:
    c = c.replace(old, new)
    changes += 1

# D. Replace ntfy header
old = 'Push Notifications (ntfy)'
new = 'Push Notifications'
if old in c:
    c = c.replace(old, new)
    changes += 1

# E. Replace ntfy description
old = 'Get instant push notifications on your phone when scheduling requests come in. Install the free <a href="https://ntfy.sh" target="_blank" rel="noopener" style={{color:C.org}}>ntfy app</a> on your phone, then subscribe to your topic below.'
new = 'Get instant push notifications on your phone when scheduling requests come in. No extra apps needed.'
if old in c:
    c = c.replace(old, new)
    changes += 1

# F. Replace the ntfy input/button/url with push toggle
old_ui = '''<div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <input type="text" value={ntfyTopic} onChange={e=>setNtfyTopic(e.target.value.replace(/[^a-zA-Z0-9_-]/g,""))} placeholder={"mdr-"+(slug||"your-slug")} style={{flex:1,padding:"10px 12px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.txt,fontSize:13}}/>
                    {ntfyTopic&&<button onClick={()=>{navigator.clipboard?.writeText("https://ntfy.sh/"+ntfyTopic);flash("Copied subscribe link");}} style={{padding:"10px 14px",background:C.inp,border:`1px solid ${C.brd}`,borderRadius:8,color:C.lt,fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>Copy Link</button>}
                  </div>
                  {ntfyTopic&&<div style={{fontSize:11,color:C.mut,marginTop:6}}>Subscribe URL: <span style={{color:C.lt}}>ntfy.sh/{ntfyTopic}</span></div>}'''

new_ui = '''<div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <div><div style={{fontSize:13,fontWeight:600,color:pushEnabled?C.ok:C.lt}}>{pushEnabled?"Notifications Enabled":"Notifications Off"}</div><div style={{fontSize:11,color:C.mut}}>{pushEnabled?"You will receive alerts for new requests":"Tap to enable push alerts"}</div></div>
                    <button onClick={async()=>{if(pushEnabled){setPushEnabled(false);try{const reg=await navigator.serviceWorker.ready;const sub=await reg.pushManager.getSubscription();if(sub)await sub.unsubscribe();await fetch(SB_URL+"/rest/v1/profiles?id=eq."+user.id,{method:"PATCH",headers:{"Content-Type":"application/json",apikey:SB_KEY,Authorization:"Bearer "+(AUTH_TOKEN||SB_KEY)},body:JSON.stringify({push_subscription:null})});flash("Push notifications disabled");}catch(e){flash("Error: "+e.message,"err");}return;}setPushLoading(true);try{const perm=await Notification.requestPermission();if(perm!=="granted"){flash("Permission denied — check browser settings","err");setPushLoading(false);return;}const reg=await navigator.serviceWorker.ready;const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:"BGrSijJatannNokQU0QyNpxDi47RhIFVkbj1DYhFGwRaFU3OwbzVjzxn1DUCFtGZO9Uj8caxFzBiQ8N7KNh-SOA"});const subJson=sub.toJSON();await fetch(SB_URL+"/rest/v1/profiles?id=eq."+user.id,{method:"PATCH",headers:{"Content-Type":"application/json",apikey:SB_KEY,Authorization:"Bearer "+(AUTH_TOKEN||SB_KEY)},body:JSON.stringify({push_subscription:subJson})});setPushEnabled(true);flash("Push notifications enabled!");}catch(e){flash("Error: "+e.message,"err");}finally{setPushLoading(false);}}} disabled={pushLoading} style={{padding:"10px 20px",borderRadius:8,border:"none",fontWeight:700,fontSize:13,cursor:pushLoading?"wait":"pointer",background:pushEnabled?C.err:C.ok,color:"#fff",opacity:pushLoading?0.6:1}}>{pushLoading?"...":(pushEnabled?"Disable":"Enable")}</button>
                  </div>'''

if old_ui in c:
    c = c.replace(old_ui, new_ui)
    changes += 1
else:
    print("⚠️  Could not find ntfy input UI block — may need manual check")

with open("index.html", "w") as f:
    f.write(c)

print(f"✅ index.html patched ({changes} changes applied)")
PYEOF

# ── 4. Write updated submit-inspection Edge Function ──
cat > supabase/functions/submit-inspection/index.ts << 'EFEOF'
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

    const insertData: Record<string, any> = {
      project, inspection_date: inspectionDate, inspection_time: actualTime,
      inspection_types: inspectionTypes, duration, submitted_by: submittedBy,
      notes, subcontractor, location_detail: siteAddress,
      inspection_identifier: inspectionIdentifier, email_recipients: emailRecipients,
      flexible_display: flexibleDisplay, status: "pending", requested_date: inspectionDate,
    };
    if (ownerId) insertData.user_id = ownerId;

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
EFEOF
echo "✅ submit-inspection Edge Function written"

echo ""
echo "═══════════════════════════════════════"
echo "ALL DONE. Now run these 3 commands:"
echo ""
echo "1. Add the database column (paste in Supabase SQL Editor):"
echo "   ALTER TABLE profiles ADD COLUMN IF NOT EXISTS push_subscription jsonb DEFAULT NULL;"
echo ""
echo "2. Deploy the app:"
echo "   git add -A && git commit -m 'Web push + email fix' && git push --force"
echo ""
echo "3. Deploy the Edge Function:"
echo "   supabase functions deploy submit-inspection --project-ref wluvkmpncafugdbunlkw"
echo "═══════════════════════════════════════"
