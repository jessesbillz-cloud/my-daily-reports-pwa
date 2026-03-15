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

    const systemPrompt = `You write photo descriptions for construction daily reports. Technical language only. 1-2 sentences max.

Rules:
- State exactly what is visible: materials, equipment, work activity, conditions, defects, measurements if readable
- Use trade-specific terminology (e.g. "rebar mat at grade", "CMU coursing", "HVAC ductwork rough-in", "standing water at footing")
- If you cannot identify something, skip it — do NOT guess, speculate, or use vague filler
- No openers like "This photo shows" or "The image depicts" — just state the facts
- No adjectives like "professional", "thorough", "well-maintained" — describe, don't evaluate
- No generalities like "various materials" or "ongoing work" — be specific or say nothing`;

    const userPrompt = context
      ? `Describe this photo for a daily report. Context: ${context}`
      : "Describe this photo for a professional daily report.";

    console.log("[describe-photo] Calling Claude API, image size:", image_base64.length, "context:", context?.slice(0, 80));

    const apiBody = JSON.stringify({
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
    });

    // Retry with exponential backoff on 429 (rate limit) or 529 (overloaded)
    const MAX_RETRIES = 3;
    let response: Response | null = null;
    let result: any = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: apiBody,
      });

      result = await response.json();
      console.log(`[describe-photo] Claude response (attempt ${attempt + 1}):`, response.status);

      if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        console.warn(`[describe-photo] Rate limited (${response.status}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      break;
    }

    if (!response!.ok) {
      const errMsg = result.error?.message || result.message || "AI request failed";
      console.error("[describe-photo] Claude error:", response!.status, errMsg);
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
