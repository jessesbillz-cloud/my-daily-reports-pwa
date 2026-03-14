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
    const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
    if (!STRIPE_SECRET) throw new Error("Stripe not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { user_id, price_id, success_url, cancel_url } = await req.json();
    if (!user_id || !price_id) throw new Error("Missing user_id or price_id");

    // Look up user email
    const { data: authUser } = await supabase.auth.admin.getUserById(user_id);
    const email = authUser?.user?.email || "";

    // Check if user already has a Stripe customer ID
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user_id)
      .single();

    let customerId = profile?.stripe_customer_id;

    // Create Stripe customer if needed
    if (!customerId) {
      const custRes = await fetch("https://api.stripe.com/v1/customers", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${STRIPE_SECRET}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          email,
          "metadata[supabase_user_id]": user_id,
        }),
      });
      const cust = await custRes.json();
      if (cust.error) throw new Error(cust.error.message);
      customerId = cust.id;

      // Save to profile
      await supabase
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", user_id);
    }

    // Create Checkout Session with 14-day trial
    const checkoutParams = new URLSearchParams({
      "customer": customerId,
      "mode": "subscription",
      "line_items[0][price]": price_id,
      "line_items[0][quantity]": "1",
      "subscription_data[trial_period_days]": "14",
      "payment_method_collection": "always",
      "success_url": success_url || "https://mydailyreports.org/?checkout=success",
      "cancel_url": cancel_url || "https://mydailyreports.org/?checkout=cancel",
      "allow_promotion_codes": "true",
    });

    // Enable PayPal + Venmo alongside cards (Stripe handles this if enabled in dashboard)
    // No extra params needed — Stripe shows available payment methods automatically

    const sessRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${STRIPE_SECRET}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: checkoutParams,
    });
    const sess = await sessRes.json();
    if (sess.error) throw new Error(sess.error.message);

    return new Response(
      JSON.stringify({ success: true, url: sess.url, session_id: sess.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
