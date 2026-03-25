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
    // ── Parse body first so we can check mode before auth ──
    const { image_base64, context, mode } = await req.json();

    // ── Auth check ──
    // For parse_scheduling mode (public scheduling page), just require a Bearer token
    // For all other modes, validate the JWT against Supabase auth
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Not authenticated. Please log in again." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isSchedulingPublic = mode === "parse_scheduling";
    if (!isSchedulingPublic) {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      const token = authHeader.replace("Bearer ", "");
      if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const { error: authErr } = await sb.auth.getUser(token);
        if (authErr) {
          return new Response(
            JSON.stringify({ error: "Invalid session. Please log out and log back in." }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    }

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

    // Strip Data URL prefix if present (e.g. "data:image/jpeg;base64,...")
    // This is common when the frontend sends a FileReader result directly
    const base64Data = image_base64.includes(",")
      ? image_base64.split(",")[1]
      : image_base64;

    // Reject oversized images before they hit the API (~5MB base64 ≈ ~3.75MB raw)
    const MAX_IMAGE_B64_LENGTH = 7 * 1024 * 1024; // ~5MB raw
    if (base64Data.length > MAX_IMAGE_B64_LENGTH) {
      return new Response(
        JSON.stringify({ error: "Image too large. Please use an image under 5MB." }),
        { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Detect media type from base64 header or default to jpeg
    let mediaType = "image/jpeg";
    if (base64Data.startsWith("/9j/")) mediaType = "image/jpeg";
    else if (base64Data.startsWith("iVBOR")) mediaType = "image/png";
    else if (base64Data.startsWith("R0lG")) mediaType = "image/gif";
    else if (base64Data.startsWith("UklG")) mediaType = "image/webp";

    // ── Mode: parse_scheduling — extract scheduling request fields from photo ──
    const isSchedulingMode = mode === "parse_scheduling";

    const schedulingSystemPrompt = `You extract scheduling/inspection request data from photos of forms, emails, texts, or handwritten notes.

Return ONLY a valid JSON object with these fields (omit any you can't determine):
{
  "date": "YYYY-MM-DD",
  "time": "HH:MM" (24h format, round to nearest 30min: 05:00,05:30,06:00,...,17:00, or "flexible"),
  "duration": 30 or 60 or 120 or 240 or 480,
  "type": "Special" or "Regular",
  "special_type": "Concrete" or "Shotcrete" or "Grout" or "Welding" or "Bolting" or "Epoxy" or "Soils" or "Material ID" or "Material ID CWI" or "UT/MP" or "Pull Test" or "Post Inst. Anchor" or "Fireproofing",
  "identifier": "request number or title if visible",
  "notes": "any additional details from the document",
  "subcontractor": "subcontractor name if mentioned"
}

Rules:
- Return ONLY the JSON. No markdown, no explanation, no code fences.
- For time, pick the closest 30-min slot (e.g. 7:15 → "07:00", 9:45 → "10:00").
- If the document says "morning" use "08:00", "afternoon" use "13:00", "ASAP" or "first thing" use "07:00".
- If time is unclear or says "anytime"/"flexible", use "flexible".
- Default duration to 60 if not specified.
- If you see concrete/shotcrete/grout work mentioned, type is "Special" with the matching special_type.
- If you see welding/bolting/soils etc., type is "Special" with matching special_type.
- If it's a general inspection with no special trade, type is "Regular".
- Extract everything you can read from the image. Be thorough.`;

    const defaultSystemPrompt = `You write ONE SHORT LINE photo descriptions for construction daily inspection reports. Maximum 8-12 words.

Rules:
- ONE line only. Brief. To the point. Like a field note, not a paragraph.
- Focus on the key technical element: what trade, what activity, what stage.
- If readable text is visible (delivery tickets, labels, tags), note it: "Concrete delivery ticket #4521, sampled"
- Use shorthand a real inspector would use: "CMU wall, rebar dowels above 2nd floor", "Footing excavation east side", "Concrete truck on site, load verified"
- Do NOT describe the photo — describe what's happening on site.
- No AI-sounding language. No "This image shows". No filler words. No evaluative adjectives.
- If you can identify the building or area from context, include it briefly.
- Skip anything you can't confidently identify.`;

    const systemPrompt = isSchedulingMode ? schedulingSystemPrompt : defaultSystemPrompt;

    const userPrompt = isSchedulingMode
      ? "Extract all scheduling/inspection request data from this image. Return JSON only."
      : context
        ? `Describe this photo for a daily report. Context: ${context}`
        : "Describe this photo for a professional daily report.";

    console.log("[describe-photo] Calling Claude API, image size:", base64Data.length, "context:", context?.slice(0, 80));

    const apiBody = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: isSchedulingMode ? 500 : 60,
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
                data: base64Data,
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
