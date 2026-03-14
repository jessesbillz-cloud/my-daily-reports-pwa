import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
    const { conversation_id, guest_name, guest_email } = await req.json();

    // Send WhatsApp notification via CallMeBot
    // To set up: assistant texts "I allow callmebot to send me messages" to +34 644 71 86 28
    // Then she gets an API key. Set WHATSAPP_PHONE and WHATSAPP_API_KEY as env vars.
    const phone = Deno.env.get("WHATSAPP_PHONE");
    const apiKey = Deno.env.get("WHATSAPP_API_KEY");

    if (phone && apiKey) {
      const name = guest_name || "Anonymous";
      const email = guest_email ? ` (${guest_email})` : "";
      const message = encodeURIComponent(
        `🔔 New MDR Support Chat\n\nFrom: ${name}${email}\n\nOpen dashboard to respond:\nhttps://mydailyreports.org/support.html`
      );

      try {
        const waRes = await fetch(
          `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${message}&apikey=${apiKey}`
        );
        console.log("WhatsApp notification:", waRes.status);
      } catch (waErr) {
        console.error("WhatsApp send error (non-fatal):", waErr);
      }
    } else {
      console.log("WhatsApp not configured — skipping notification");
    }

    // Also send ntfy as backup (if configured)
    const ntfyTopic = Deno.env.get("SUPPORT_NTFY_TOPIC");
    if (ntfyTopic) {
      try {
        await fetch(`https://ntfy.sh/${ntfyTopic}`, {
          method: "POST",
          headers: {
            Title: "New Support Chat",
            Priority: "high",
            Tags: "speech_balloon",
            Click: "https://mydailyreports.org/support.html",
          },
          body: `${guest_name || "Anonymous"} started a chat${
            guest_email ? " (" + guest_email + ")" : ""
          }`,
        });
      } catch (e) {
        console.error("ntfy error (non-fatal):", e);
      }
    }

    return new Response(
      JSON.stringify({ success: true }),
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
