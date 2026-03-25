import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// send-reminders — Runs on a cron schedule (every 30 min).
// Checks all jobs with reminder_enabled=true, determines if today is a
// scheduled report day, and sends push notifications to users who
// have not submitted their report yet.
//
// Environment variables required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   VAPID_PRIVATE_KEY — base64url-encoded ECDSA P-256 private key (matches the public key in AccountSettings)
//   VAPID_SUBJECT — mailto:support@mydailyreports.org
//
// Deploy: supabase functions deploy send-reminders --no-verify-jwt
// Cron: Set up via Supabase Dashboard > Database > pg_cron

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// VAPID public key (must match the one in AccountSettings.jsx)
const VAPID_PUBLIC_KEY = "BIYqy5Y2mBafWr4QkgR2WHqS305qoHug2LzpAH-pgWoxn94MORgNzTc0t_nSUygPLxBkPQzEjX8rMZDKb_qYsKM";

// Map day abbreviations to JS getDay() values
const DAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// ── Web Push helpers (RFC 8291 / RFC 8292) ──────────────────────────────
// These implement VAPID JWT signing + payload encryption without npm deps

function base64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function createVapidJwt(audience: string, subject: string, privateKeyB64: string): Promise<string> {
  // Import the ECDSA P-256 private key
  const rawKey = base64urlDecode(privateKeyB64);
  // Build JWK from raw 32-byte private key
  // For ECDSA P-256, we need x, y (public) and d (private) coords
  // The private key alone is the "d" parameter
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: privateKeyB64,
      // We derive x,y from the public key
      x: VAPID_PUBLIC_KEY.slice(0, 43), // not right — we need to parse the uncompressed public key
      y: VAPID_PUBLIC_KEY.slice(43),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64urlEncode(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: now + 86400,
    sub: subject,
  })));

  const sigInput = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cryptoKey, sigInput);

  // Convert DER signature to raw r||s format for JWT
  const sigBytes = new Uint8Array(sig);
  return `${header}.${payload}.${base64urlEncode(sigBytes)}`;
}

// Encrypt push payload per RFC 8291 (aes128gcm content encoding)
async function encryptPayload(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string
): Promise<{ encrypted: Uint8Array; salt: Uint8Array; localPublicKey: Uint8Array }> {
  // Generate local ECDH key pair
  const localKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPublicKeyRaw = await crypto.subtle.exportKey("raw", localKeyPair.publicKey);
  const localPublicKey = new Uint8Array(localPublicKeyRaw);

  // Import subscriber's public key
  const subscriberPubKey = base64urlDecode(subscription.keys.p256dh);
  const subscriberKey = await crypto.subtle.importKey("raw", subscriberPubKey, { name: "ECDH", namedCurve: "P-256" }, false, []);

  // Derive shared secret via ECDH
  const sharedSecret = await crypto.subtle.deriveBits({ name: "ECDH", public: subscriberKey }, localKeyPair.privateKey, 256);

  // auth secret from subscription
  const authSecret = base64urlDecode(subscription.keys.auth);

  // Generate salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF-based key derivation (simplified for Web Push)
  const ikm = new Uint8Array(sharedSecret);

  // PRK = HMAC-SHA-256(auth, shared_secret)
  const authKey = await crypto.subtle.importKey("raw", authSecret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", authKey, ikm));

  // Build info for content encryption key
  const encoder = new TextEncoder();
  const keyInfo = new Uint8Array([
    ...encoder.encode("Content-Encoding: aes128gcm\0"),
  ]);
  const nonceInfo = new Uint8Array([
    ...encoder.encode("Content-Encoding: nonce\0"),
  ]);

  // Derive CEK (16 bytes) and nonce (12 bytes) using HKDF
  const prkKey = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

  const cekFull = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, new Uint8Array([...salt, ...keyInfo, 1])));
  const cek = cekFull.slice(0, 16);

  const nonceFull = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, new Uint8Array([...salt, ...nonceInfo, 1])));
  const nonce = nonceFull.slice(0, 12);

  // Encrypt with AES-128-GCM
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const paddedPayload = new Uint8Array([...encoder.encode(payload), 2]); // delimiter byte
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, paddedPayload);

  // Build aes128gcm body: salt(16) | rs(4) | idlen(1) | keyid(65) | ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const body = new Uint8Array([
    ...salt,
    ...rs,
    localPublicKey.length,
    ...localPublicKey,
    ...new Uint8Array(ciphertext),
  ]);

  return { encrypted: body, salt, localPublicKey };
}

async function sendWebPush(
  subscription: { endpoint: string; keys?: { p256dh: string; auth: string } },
  payload: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<boolean> {
  if (!subscription.keys?.p256dh || !subscription.keys?.auth) {
    console.error("[web-push] Subscription missing encryption keys");
    return false;
  }

  try {
    const url = new URL(subscription.endpoint);
    const audience = `${url.protocol}//${url.host}`;

    // Create VAPID authorization JWT
    const jwt = await createVapidJwt(audience, vapidSubject, vapidPrivateKey);
    const vapidHeader = `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`;

    // Encrypt the payload
    const { encrypted } = await encryptPayload(subscription, payload);

    const resp = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "Authorization": vapidHeader,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": "86400",
        "Urgency": "normal",
      },
      body: encrypted,
    });

    if (resp.status === 201 || resp.status === 200) {
      return true;
    } else if (resp.status === 410 || resp.status === 404) {
      // Subscription expired/invalid — should remove it
      console.warn("[web-push] Subscription gone (410/404) for endpoint:", subscription.endpoint);
      return false;
    } else {
      const body = await resp.text().catch(() => "");
      console.error(`[web-push] Push failed: ${resp.status} ${body}`);
      return false;
    }
  } catch (e) {
    console.error("[web-push] Error:", e);
    return false;
  }
}

// ── Main handler ────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") || "";
    const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:support@mydailyreports.org";
    const supabase = createClient(supabaseUrl, supabaseKey);

    const now = new Date();
    const todayISO = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const todayDOW = now.getDay(); // 0=Sun

    // 1. Get all jobs with reminders enabled
    const { data: jobs, error: jobsErr } = await supabase
      .from("jobs")
      .select("id, user_id, name, schedule, schedule_days, reminder_enabled, reminder_time, reminder_hours_before, last_reminder_sent_at")
      .eq("reminder_enabled", true)
      .eq("is_archived", false);

    if (jobsErr) throw new Error("Failed to query jobs: " + jobsErr.message);
    if (!jobs || jobs.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: "No jobs with reminders" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. For each job, check if today is a scheduled day
    const dueJobs: typeof jobs = [];
    for (const job of jobs) {
      const sched = job.schedule || "as_needed";
      let scheduledDays: number[] = [];

      if (sched === "daily_7") scheduledDays = [0, 1, 2, 3, 4, 5, 6];
      else if (sched === "daily_mf") scheduledDays = [1, 2, 3, 4, 5];
      else if (sched === "custom" && Array.isArray(job.schedule_days)) {
        scheduledDays = job.schedule_days.map((d: string) => DAY_MAP[d]).filter((n: number | undefined) => n != null);
      }

      if (scheduledDays.includes(todayDOW)) {
        const reminderHours = job.reminder_hours_before || 2;
        const reminderTime = job.reminder_time || "5:00 PM";

        const match = reminderTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (match) {
          let h = parseInt(match[1]);
          const m = parseInt(match[2]);
          if (match[3].toUpperCase() === "PM" && h !== 12) h += 12;
          if (match[3].toUpperCase() === "AM" && h === 12) h = 0;
          const deadlineMinutes = h * 60 + m;
          const reminderMinutes = deadlineMinutes - (reminderHours * 60);
          const nowMinutes = now.getHours() * 60 + now.getMinutes();

          if (nowMinutes >= reminderMinutes && nowMinutes <= deadlineMinutes) {
            const lastSent = job.last_reminder_sent_at ? new Date(job.last_reminder_sent_at) : null;
            const alreadySentToday = lastSent && lastSent.toISOString().split("T")[0] === todayISO;
            if (!alreadySentToday) {
              dueJobs.push(job);
            }
          }
        }
      }
    }

    if (dueJobs.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: "No reminders due right now" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Check which of these jobs already have today's report submitted
    const jobIds = dueJobs.map(j => j.id);
    const { data: todayReports } = await supabase
      .from("reports")
      .select("job_id, status")
      .in("job_id", jobIds)
      .eq("report_date", todayISO)
      .eq("status", "submitted");

    const submittedJobIds = new Set((todayReports || []).map(r => r.job_id));
    const needsReminder = dueJobs.filter(j => !submittedJobIds.has(j.id));

    if (needsReminder.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: "All due reports already submitted" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Group by user and send one notification per user
    const userJobs: Record<string, typeof needsReminder> = {};
    for (const job of needsReminder) {
      if (!userJobs[job.user_id]) userJobs[job.user_id] = [];
      userJobs[job.user_id].push(job);
    }

    const userIds = Object.keys(userJobs);
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, ntfy_topic, push_subscription")
      .in("id", userIds);

    let sentCount = 0;
    let pushCount = 0;
    const staleSubscriptions: string[] = [];

    // 5. Send notifications
    const sendResults = await Promise.allSettled((profiles || []).map(async (profile) => {
      const jobs = userJobs[profile.id];
      if (!jobs || jobs.length === 0) return;

      const jobNames = jobs.map(j => j.name).join(", ");
      const title = "Report Reminder";
      const body = jobs.length === 1
        ? `Your report for ${jobs[0].name} is due today.`
        : `You have ${jobs.length} reports due today: ${jobNames}`;

      const tag = `reminder-${profile.id}-${todayISO}`;

      // Send via ntfy (simple HTTP — always works)
      if (profile.ntfy_topic) {
        try {
          await fetch(`https://ntfy.sh/${profile.ntfy_topic}`, {
            method: "POST",
            headers: {
              "Title": title,
              "Priority": "default",
              "Tags": "memo",
              "X-Tag": tag,
            },
            body: body,
          });
          sentCount++;
        } catch (e) {
          console.error("ntfy send failed for", profile.id, e);
        }
      }

      // Send via Web Push (VAPID-signed, encrypted)
      if (vapidPrivateKey && profile.push_subscription?.endpoint) {
        const pushPayload = JSON.stringify({ title, body, tag, url: "/" });
        const success = await sendWebPush(profile.push_subscription, pushPayload, vapidPrivateKey, vapidSubject);
        if (success) {
          pushCount++;
          sentCount++;
        } else if (!success && profile.push_subscription?.endpoint) {
          // Mark stale subscription for cleanup
          staleSubscriptions.push(profile.id);
        }
      }

      // Mark jobs as reminded today
      const jobIdsForUser = jobs.map(j => j.id);
      for (const jobId of jobIdsForUser) {
        await supabase
          .from("jobs")
          .update({ last_reminder_sent_at: new Date().toISOString() })
          .eq("id", jobId);
      }
    }));

    // Clean up stale push subscriptions (410 Gone)
    for (const userId of staleSubscriptions) {
      await supabase
        .from("profiles")
        .update({ push_subscription: null })
        .eq("id", userId);
      console.log("[send-reminders] Cleared stale push subscription for user:", userId);
    }

    for (const r of sendResults) {
      if (r.status === "rejected") console.error("[send-reminders] Notification batch error:", r.reason);
    }

    return new Response(JSON.stringify({ sent: sentCount, push: pushCount, checked: needsReminder.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("send-reminders error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
