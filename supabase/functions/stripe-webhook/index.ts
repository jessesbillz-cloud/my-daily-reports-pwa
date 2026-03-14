import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Stripe webhook signature verification using Web Crypto API
async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string
): Promise<boolean> {
  const parts = sigHeader.split(",").reduce((acc: Record<string, string>, part) => {
    const [k, v] = part.split("=");
    acc[k] = v;
    return acc;
  }, {});

  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  // Check timestamp tolerance (5 minutes)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return computed === signature;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.text();
    const sigHeader = req.headers.get("stripe-signature") || "";

    // Verify webhook signature
    if (STRIPE_WEBHOOK_SECRET) {
      const valid = await verifyStripeSignature(body, sigHeader, STRIPE_WEBHOOK_SECRET);
      if (!valid) {
        console.error("Invalid Stripe webhook signature");
        return new Response("Invalid signature", { status: 400 });
      }
    }

    const event = JSON.parse(body);
    console.log("Stripe webhook:", event.type, event.id);

    // Log the event
    const logEvent = async (userId: string, eventType: string, plan: string, status: string, metadata: any = {}) => {
      try {
        await supabase.from("subscription_events").insert({
          user_id: userId,
          stripe_event_id: event.id,
          event_type: eventType,
          plan,
          status,
          metadata,
        });
      } catch (e) {
        console.error("Log event error:", e);
      }
    };

    // Helper: look up user by stripe customer ID
    const getUserByCustomer = async (customerId: string) => {
      const { data } = await supabase
        .from("profiles")
        .select("id")
        .eq("stripe_customer_id", customerId)
        .single();
      return data?.id || null;
    };

    // Helper: get subscription details from Stripe
    const getSubscription = async (subId: string) => {
      const r = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
        headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
      });
      return await r.json();
    };

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerId = session.customer;
      const subscriptionId = session.subscription;
      const userId = await getUserByCustomer(customerId);

      if (userId && subscriptionId) {
        const sub = await getSubscription(subscriptionId);
        const plan = sub.items?.data?.[0]?.price?.id || "unknown";
        const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

        await supabase.from("profiles").update({
          subscription_status: sub.status, // "trialing" or "active"
          subscription_plan: plan,
          stripe_subscription_id: subscriptionId,
          trial_ends_at: trialEnd,
          subscription_ends_at: periodEnd,
        }).eq("id", userId);

        await logEvent(userId, "checkout.completed", plan, sub.status, { subscription_id: subscriptionId });

        // Check card fingerprint for trial abuse
        if (sub.status === "trialing" && session.payment_method_types) {
          try {
            // Get the payment method to check fingerprint
            const pmId = sub.default_payment_method || session.setup_intent;
            if (pmId) {
              const pmRes = await fetch(`https://api.stripe.com/v1/payment_methods/${pmId}`, {
                headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
              });
              const pm = await pmRes.json();
              const fingerprint = pm.card?.fingerprint;
              if (fingerprint) {
                const { data: fpOk } = await supabase.rpc("check_trial_fingerprint", {
                  p_fingerprint: fingerprint,
                  p_user_id: userId,
                });
                if (fpOk === false) {
                  console.warn("Trial abuse detected — card fingerprint already used by another account");
                  // Cancel the trial immediately
                  await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
                    method: "DELETE",
                    headers: { "Authorization": `Bearer ${STRIPE_SECRET}` },
                  });
                  await supabase.from("profiles").update({
                    subscription_status: "trial_abused",
                    subscription_plan: "none",
                  }).eq("id", userId);
                  await logEvent(userId, "trial.abuse_detected", plan, "cancelled", { fingerprint });
                }
              }
            }
          } catch (e) {
            console.error("Fingerprint check error (non-fatal):", e);
          }
        }
      }
    } else if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const customerId = sub.customer;
      const userId = await getUserByCustomer(customerId);

      if (userId) {
        const plan = sub.items?.data?.[0]?.price?.id || "unknown";
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

        await supabase.from("profiles").update({
          subscription_status: sub.status, // "active", "past_due", "canceled", "trialing"
          subscription_plan: plan,
          subscription_ends_at: periodEnd,
        }).eq("id", userId);

        await logEvent(userId, "subscription.updated", plan, sub.status);
      }
    } else if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const customerId = sub.customer;
      const userId = await getUserByCustomer(customerId);

      if (userId) {
        await supabase.from("profiles").update({
          subscription_status: "cancelled",
          subscription_plan: "none",
        }).eq("id", userId);

        await logEvent(userId, "subscription.cancelled", "none", "cancelled");
      }
    } else if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const userId = await getUserByCustomer(customerId);

      if (userId) {
        await supabase.from("profiles").update({
          subscription_status: "past_due",
        }).eq("id", userId);

        await logEvent(userId, "payment.failed", "", "past_due", {
          amount: invoice.amount_due,
          attempt_count: invoice.attempt_count,
        });
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
