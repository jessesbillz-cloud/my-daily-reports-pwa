import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { image_base64, context } = await req.json();

    if (!image_base64) {
      return new Response(
        JSON.stringify({ error: "No image provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Detect media type from base64 header or default to jpeg
    let mediaType = "image/jpeg";
    if (image_base64.startsWith("/9j/")) mediaType = "image/jpeg";
    else if (image_base64.startsWith("iVBOR")) mediaType = "image/png";
    else if (image_base64.startsWith("R0lG")) mediaType = "image/gif";
    else if (image_base64.startsWith("UklG")) mediaType = "image/webp";

    const systemPrompt = `You are a construction site photo analyst for daily inspection reports. Describe what you see in 1-2 concise sentences. Focus on:
- Work activity (what trade/task is being performed)
- Materials visible (rebar, concrete, framing, conduit, etc.)
- Location context if identifiable (floor level, grid line, room, exterior/interior)
- Stage of work (in progress, completed, inspection-ready)

Keep it factual and professional — this goes directly into an official daily report. Do NOT start with "This photo shows" or "The image depicts". Just state what's happening.`;

    const userPrompt = context
      ? `Describe this construction site photo. Context: ${context}`
      : "Describe this construction site photo for a daily inspection report.";

    console.log("[describe-photo] Calling Claude API, image size:", image_base64.length, "context:", context?.slice(0, 80));

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: image_base64,
                },
              },
              {
                type: "text",
                text: userPrompt,
              },
            ],
          },
        ],
      }),
    });

    const result = await response.json();
    console.log("[describe-photo] Claude response status:", response.status);

    if (!response.ok) {
      const errMsg = result.error?.message || result.message || "AI request failed";
      console.error("[describe-photo] Claude error:", response.status, errMsg);
      return new Response(
        JSON.stringify({ error: errMsg }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const description = result.content?.[0]?.text || "";
    console.log("[describe-photo] Success:", description.slice(0, 80));

    return new Response(
      JSON.stringify({ description }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[describe-photo] Uncaught error:", error.message);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
