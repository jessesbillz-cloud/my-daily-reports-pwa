import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Resend webhook events:
// email.sent, email.delivered, email.bounced,
// email.complained, email.delivery_delayed, email.opened, email.clicked

serve(async (req) => {
  // Resend sends POST with JSON body; verify via signing secret
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify webhook signature if secret is configured
    if (WEBHOOK_SECRET) {
      const svixId = req.headers.get("svix-id");
      const svixTimestamp = req.headers.get("svix-timestamp");
      const svixSignature = req.headers.get("svix-signature");

      if (!svixId || !svixTimestamp || !svixSignature) {
        console.error("Missing Svix headers");
        return new Response("Unauthorized", { status: 401 });
      }

      // Timestamp check — reject if older than 5 minutes
      const now = Math.floor(Date.now() / 1000);
      const ts = parseInt(svixTimestamp);
      if (Math.abs(now - ts) > 300) {
        console.error("Webhook timestamp too old:", svixTimestamp);
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const body = await req.text();
    const event = JSON.parse(body);

    const eventType = event.type;
    const data = event.data;

    if (!eventType || !data) {
      return new Response(JSON.stringify({ error: "Invalid event" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Log every event
    await supabase.from("email_events").insert({
      resend_email_id: data.email_id || data.id || null,
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
      const badEmail = Array.isArray(data.to) ? data.to[0] : data.to;
      if (badEmail) {
        // Upsert into suppression list
        await supabase.from("email_suppressions").upsert(
          {
            email: badEmail.toLowerCase().trim(),
            reason: eventType === "email.bounced" ? "bounce" : "complaint",
            bounce_type: data.bounce?.type || null,
            last_event_at: new Date().toISOString(),
            event_count: 1,
          },
          {
            onConflict: "email",
          }
        );

        // Update the count for existing records
        const { data: existing } = await supabase
          .from("email_suppressions")
          .select("event_count")
          .eq("email", badEmail.toLowerCase().trim())
          .single();

        if (existing && existing.event_count > 0) {
          await supabase
            .from("email_suppressions")
            .update({
              event_count: existing.event_count + 1,
              last_event_at: new Date().toISOString(),
              reason: eventType === "email.bounced" ? "bounce" : "complaint",
              bounce_type: data.bounce?.type || null,
            })
            .eq("email", badEmail.toLowerCase().trim());
        }

        console.warn(
          `Email ${eventType}: ${badEmail} — ${data.bounce?.type || data.complaint?.type || "unknown"}`
        );
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
