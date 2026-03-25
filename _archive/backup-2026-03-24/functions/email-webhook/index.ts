import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Resend webhook events:
// email.sent, email.delivered, email.bounced,
// email.complained, email.delivery_delayed, email.opened, email.clicked

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, svix-id, svix-timestamp, svix-signature",
};

async function verifyWebhookSignature(
  secret: string,
  msgId: string,
  timestamp: string,
  body: string,
  signatures: string
): Promise<boolean> {
  try {
    // Resend/Svix secret starts with "whsec_" prefix — strip it and decode base64
    const secretBytes = Uint8Array.from(
      atob(secret.startsWith("whsec_") ? secret.slice(6) : secret),
      (c) => c.charCodeAt(0)
    );

    const toSign = `${msgId}.${timestamp}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(toSign));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

    // Svix sends multiple signatures separated by spaces: "v1,<sig1> v1,<sig2>"
    const sigs = signatures.split(" ").map((s) => s.replace("v1,", ""));
    return sigs.some((s) => s === expected);
  } catch (e) {
    console.error("Signature verification error:", e);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body = await req.text();

    // Verify webhook signature if secret is configured
    if (WEBHOOK_SECRET) {
      const svixId = req.headers.get("svix-id");
      const svixTimestamp = req.headers.get("svix-timestamp");
      const svixSignature = req.headers.get("svix-signature");

      if (!svixId || !svixTimestamp || !svixSignature) {
        console.error("Missing Svix headers");
        return new Response(JSON.stringify({ error: "Missing signature headers" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Timestamp check — reject if older than 5 minutes
      const now = Math.floor(Date.now() / 1000);
      const ts = parseInt(svixTimestamp);
      if (Math.abs(now - ts) > 300) {
        console.error("Webhook timestamp too old:", svixTimestamp);
        return new Response(JSON.stringify({ error: "Timestamp expired" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const valid = await verifyWebhookSignature(WEBHOOK_SECRET, svixId, svixTimestamp, body, svixSignature);
      if (!valid) {
        console.error("Invalid webhook signature");
        return new Response(JSON.stringify({ error: "Invalid signature" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const event = JSON.parse(body);
    const eventType = event.type;
    const data = event.data;

    if (!eventType || !data) {
      return new Response(JSON.stringify({ error: "Invalid event" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resendEmailId = data.email_id || data.id || null;
    console.log("[email-webhook] Event:", eventType, "Email ID:", resendEmailId);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Replay protection: check if we've already processed this exact event
    if (resendEmailId) {
      const { data: existingEvent } = await supabase
        .from("email_events")
        .select("id")
        .eq("resend_email_id", resendEmailId)
        .eq("event_type", eventType)
        .maybeSingle();

      if (existingEvent) {
        console.log("[email-webhook] Duplicate event skipped:", eventType, resendEmailId);
        return new Response(JSON.stringify({ received: true, duplicate: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Log every event
    await supabase.from("email_events").insert({
      resend_email_id: resendEmailId,
      event_type: eventType,
      to_email: Array.isArray(data.to) ? data.to[0] : data.to || null,
      from_email: data.from || null,
      subject: data.subject || null,
      bounce_type: data.bounce?.type || null,
      complaint_type: data.complaint?.type || null,
      raw_payload: event,
    });

    // On bounce or complaint, flag the email address
    if (eventType === "email.bounced" || eventType === "email.complained") {
      const badEmail = (Array.isArray(data.to) ? data.to[0] : data.to) || data.recipient || data.email;
      if (badEmail) {
        const normalized = badEmail.toLowerCase().trim();
        const reason = eventType === "email.bounced" ? "bounce" : "complaint";
        const bounceType = data.bounce?.type || data.complaint?.type || null;

        // Upsert into suppression list — this creates or updates the record
        await supabase.from("email_suppressions").upsert(
          {
            email: normalized,
            reason,
            bounce_type: bounceType,
            last_event_at: new Date().toISOString(),
            event_count: 1,
            suppressed: true,
          },
          { onConflict: "email" }
        );

        // Atomic increment via RPC to avoid race conditions on concurrent webhooks
        // Falls back to manual increment if the RPC doesn't exist yet
        const { error: rpcError } = await supabase.rpc("increment_suppression_count", {
          p_email: normalized,
          p_reason: reason,
          p_bounce_type: bounceType || "unknown",
        });

        if (rpcError) {
          // Fallback: direct update (still better than read-then-write)
          console.warn("[email-webhook] RPC increment_suppression_count not available, using direct update:", rpcError.message);
          await supabase
            .from("email_suppressions")
            .update({
              last_event_at: new Date().toISOString(),
              reason,
              bounce_type: bounceType,
            })
            .eq("email", normalized);
        }

        console.warn(`[email-webhook] ${eventType}: ${normalized} — ${bounceType || "unknown"}`);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[email-webhook] Uncaught error:", error.message, error.stack);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
