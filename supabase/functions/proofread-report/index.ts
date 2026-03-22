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
    // ── Manual auth check (verify_jwt is off to bypass gateway issues) ──
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Not authenticated. Please log in again." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
      const token = authHeader.replace("Bearer ", "");
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const { error: authErr } = await sb.auth.getUser(token);
      if (authErr) {
        return new Response(
          JSON.stringify({ error: "Invalid session. Please log out and log back in." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const { fields } = await req.json();

    if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) {
      return new Response(
        JSON.stringify({ error: "No fields provided" }),
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

    // Build the field text for proofreading — only non-empty text fields
    const fieldEntries: [string, string][] = [];
    for (const [name, value] of Object.entries(fields)) {
      const v = String(value || "").trim();
      if (v && v.length > 2) {
        fieldEntries.push([name, v]);
      }
    }

    if (fieldEntries.length === 0) {
      // Nothing to proofread — return empty corrections
      return new Response(
        JSON.stringify({ corrected: {} }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Format fields as numbered list for the model
    const fieldText = fieldEntries
      .map(([name, val], i) => `[${i}] ${name}: ${val}`)
      .join("\n");

    const systemPrompt = `You are a proofreader for construction daily inspection reports. Your ONLY job is to fix errors. Do NOT rewrite, rephrase, restructure, or improve the text.

Fix ONLY these issues:
- Spelling errors (including voice-to-text mistakes like "steal" → "steel", "pored" → "poured", "site" ↔ "sight")
- Missing or incorrect capitalization (start of sentences, proper nouns)
- Missing punctuation (periods at end of sentences, commas in lists)
- Obvious grammar errors from voice dictation (wrong word, missing word, duplicate word)
- Abbreviation consistency (keep industry shorthand like CMU, GPR, rebar, MEP as-is)

Do NOT change:
- Writing style, tone, or word choice (if the meaning is clear, leave it)
- Sentence structure or order
- Technical terms, trade names, measurements, numbers
- Field notes shorthand or informal phrasing (inspectors write brief notes, not essays)
- Content that is already correct

Response format — return ONLY a JSON object mapping field index to corrected text. Only include fields that had corrections. If nothing needed fixing, return {}.

Example input:
[0] General: the concrete was pored today at the east wing. rebar inspection passed
[1] Activities: installed 12 CMU blcoks on the 3rd floor north wall

Example output:
{"0":"The concrete was poured today at the east wing. Rebar inspection passed.","1":"Installed 12 CMU blocks on the 3rd floor north wall."}`;

    console.log("[proofread-report] Proofreading", fieldEntries.length, "fields");

    const apiBody = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: fieldText,
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
      console.log(`[proofread-report] Claude response (attempt ${attempt + 1}):`, response.status);

      if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`[proofread-report] Rate limited (${response.status}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      break;
    }

    if (!response!.ok) {
      const errMsg = result.error?.message || result.message || "AI request failed";
      console.error("[proofread-report] Claude error:", response!.status, errMsg);
      return new Response(
        JSON.stringify({ error: errMsg }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const rawText = result.content?.[0]?.text || "{}";
    console.log("[proofread-report] Raw response:", rawText.slice(0, 200));

    // Parse the JSON response — extract from markdown code block if wrapped
    let corrections: Record<string, string> = {};
    try {
      const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, rawText];
      corrections = JSON.parse(jsonMatch[1]!.trim());
    } catch (parseErr) {
      console.warn("[proofread-report] Could not parse corrections JSON:", parseErr.message);
      // Return empty corrections rather than failing — report still submits
      return new Response(
        JSON.stringify({ corrected: {} }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Map index-based corrections back to field names
    const corrected: Record<string, string> = {};
    for (const [idxStr, correctedText] of Object.entries(corrections)) {
      const idx = parseInt(idxStr, 10);
      if (!isNaN(idx) && idx >= 0 && idx < fieldEntries.length) {
        const fieldName = fieldEntries[idx][0];
        // Only include if the text actually changed
        if (correctedText !== fieldEntries[idx][1]) {
          corrected[fieldName] = correctedText as string;
        }
      }
    }

    console.log("[proofread-report] Corrections made:", Object.keys(corrected).length, "of", fieldEntries.length, "fields");

    return new Response(
      JSON.stringify({ corrected }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[proofread-report] Uncaught error:", error.message);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
