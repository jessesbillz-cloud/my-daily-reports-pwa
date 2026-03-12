import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verify the caller is authenticated
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create a client with the user's token to verify identity
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    // Use service role client to bypass RLS and delete everything
    const admin = createClient(supabaseUrl, supabaseServiceKey);

    // Delete user data from all tables (order matters for foreign keys)
    const tables = [
      { name: "reports", col: "user_id" },
      { name: "templates", col: "user_id" },
      { name: "saved_templates", col: "user_id" },
      { name: "scheduling_requests", col: "user_id" },
      { name: "jobs", col: "user_id" },
      { name: "profiles", col: "id" },
    ];

    const results: Record<string, string> = {};
    for (const t of tables) {
      const { error } = await admin.from(t.name).delete().eq(t.col, userId);
      results[t.name] = error ? `error: ${error.message}` : "ok";
    }

    // Delete the auth user using admin API
    const { error: deleteAuthError } = await admin.auth.admin.deleteUser(userId);
    results["auth_user"] = deleteAuthError ? `error: ${deleteAuthError.message}` : "ok";

    return new Response(JSON.stringify({ success: true, results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
