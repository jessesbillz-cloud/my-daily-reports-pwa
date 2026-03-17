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

    // Verify the caller's identity via JWT instead of trusting user_id from body
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing Authorization header");
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !authUser) throw new Error("Unauthorized");

    const { action } = await req.json();
    if (!action) throw new Error("Missing action");
    const user_id = authUser.id;

    // Get user's Stripe customer ID
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id, stripe_subscription_id")
      .eq("id", user_id)
      .single();

    if (!profile?.stripe_customer_id) throw new Error("No Stripe customer found");

    if (action === "portal") {
      // Create a Stripe Customer Portal session (manage billing, cancel, update card)
      const portalRes = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${STRIPE_SECRET}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          customer: profile.stripe_customer_id,
          return_url: "https://mydailyreports.org/",
        }),
      });
      const portal = await portalRes.json();
      if (portal.error) throw new Error(portal.error.message);

      return new Response(
        JSON.stringify({ success: true, url: portal.url }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else if (action === "cancel") {
      // Cancel subscription at period end
      if (!profile.stripe_subscription_id) throw new Error("No active subscription");

      const cancelRes = await fetch(
        `https://api.stripe.com/v1/subscriptions/${profile.stripe_subscription_id}`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${STRIPE_SECRET}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ cancel_at_period_end: "true" }),
        }
      );
      const result = await cancelRes.json();
      if (result.error) throw new Error(result.error.message);

      return new Response(
        JSON.stringify({ success: true, cancel_at: result.cancel_at }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unknown action: ${action}`);
  } catch (error) {
    console.error("[manage-subscription] Error:", error.message);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
