import "https://deno.land/x/xhr@0.3.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PROMPT = `Analyze this inspection report template PDF. Find all fillable fields.

CRITICAL RULES:
1. NEVER output duplicate field names. Each field appears EXACTLY ONCE. If a label like "IOR Notes" appears both in a header table AND as a section heading below it, output it ONLY ONCE — use the coordinates of the large writable area (the section below the table), not the table cell.
2. The template may have pre-filled values (like a project name, date, or a standing note). Include those values in the "value" field so we know what's already printed on the form.

FIELD CLASSIFICATION — determine if each field CHANGES per report or STAYS THE SAME:
- CHANGES per report (→ editable): Date, Report Date, Report Number, DR#, Notes, IOR Notes, Observations, Comments, Work Observed, Weather, Hours, Time In, Time Out, Temperature, Correction Notices Issued, Observation Letters Issued
- STAYS THE SAME (→ locked): Project Name, Owner, Client, District, DSA File #, DSA App #, Contractor, Architect, Engineer, Inspector, IOR, Project Inspector, Address, Location, Project No, Project Manager, Jurisdiction

POSITION COORDINATES — estimate PRECISE position for each field:
- "page": which page (1-indexed)
- "x": x position in PDF points where the VALUE starts (after the label). 72pt = 1 inch, page width = 612pt
- "y": y position in PDF points FROM THE TOP. Top of page ≈ 0, bottom ≈ 792. A field 2 inches from top = ~144pt.
- "w": width of the value area in points
- "h": height of the value area in points
- "fontSize": estimated font size (typically 8-12pt)
- "labelEndX": x position in PDF points where the label text ENDS (right after the colon or last character of the label). This is critical — the value will be placed starting at labelEndX + a small gap, so it appears directly after the label text.

COORDINATE PRECISION IS CRITICAL:
- x = where the VALUE text starts, not the label. "Date: 04 February 2026" → x points to where "04" starts.
- labelEndX = where the label colon/text ends. For "Date: 04 Feb..." → labelEndX points to right after the colon+space. x and labelEndX should be very close (within a few points).
- Each field on a different line MUST have a different y value. Measure each independently.
- For fields side-by-side on the same row (like "Date:" on the left and "Project Name:" on the right), they share a similar y but have different x values.
- The app will place typed values at labelEndX + 3pt, so be precise about where each label ends.

NOTES/OBSERVATIONS SECTION:
- Many forms have a large notes area below the header table (labeled "IOR Notes:", "Observations:", "Notes:", etc.)
- Output this as EXACTLY ONE field — pick the best name (e.g. "IOR Notes" or "Observations") and use it ONCE.
- NEVER create BOTH an "IOR Notes" field AND a separate "Notes" field. They are the SAME section. Pick ONE name and output ONE field.
- The coordinates should point to the writable area BELOW the label — where the inspector writes their daily notes.
- Set "multiline": true, "voiceEnabled": true
- The y should be just below the section label, x at the left margin of the writing area, w spanning the full width
- If text already exists in this area (a standing note), include it in "value"
- Do NOT also create a separate field for the same label if it appears in the header table
- Do NOT create fields like "Notes and Comments", "Notes", etc. if you already have "IOR Notes" or "Observations" — ONE notes field total.

SIGNATURE LINES: Ignore signature lines (like "x___Name___") — do not include them as fields.

Return ONLY valid JSON, no markdown or explanation:
{"editable":[{"name":"Date","value":"04 February 2026","autoFill":"date","page":1,"x":110,"y":148,"w":160,"h":14,"fontSize":10,"labelEndX":107}],"locked":[{"name":"Project Name","value":"Woodland Park MS Mod","page":1,"x":395,"y":148,"w":180,"h":14,"fontSize":10,"labelEndX":392}]}

autoFill values: "date" (for date fields) or "increment" (for report numbers). voiceEnabled=true for notes/observations fields.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { file_base64, file_name } = body;

    const content = [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: file_base64 },
      },
      { type: "text", text: PROMPT },
    ];

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY"),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        messages: [{ role: "user", content }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message || "Anthropic API error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const text = data.content?.map((c) => c.text || "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    // Safety net: deduplicate fields by name (keep first occurrence)
    const dedup = (arr: any[]) => {
      const seen = new Set<string>();
      return (arr || []).filter((f) => {
        const key = (f.name || "").toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    // Merge notes-like fields: if multiple fields contain "notes", "observations", or "comments", keep only the one with the largest area
    const NOTES_KEYWORDS = ["notes", "observations", "comments"];
    const mergeNotes = (arr: any[]) => {
      const notesFields = (arr || []).filter((f) => {
        const n = (f.name || "").toLowerCase();
        return NOTES_KEYWORDS.some((k) => n.includes(k));
      });
      if (notesFields.length <= 1) return arr;
      // Keep the one with the biggest writing area (w * h), or first if no dimensions
      const best = notesFields.reduce((a, b) => ((a.w || 0) * (a.h || 0) >= (b.w || 0) * (b.h || 0) ? a : b));
      const bestName = best.name;
      return (arr || []).filter((f) => {
        const n = (f.name || "").toLowerCase();
        const isNotes = NOTES_KEYWORDS.some((k) => n.includes(k));
        return !isNotes || f.name === bestName;
      });
    };
    if (parsed.editable) parsed.editable = mergeNotes(dedup(parsed.editable));
    if (parsed.locked) parsed.locked = mergeNotes(dedup(parsed.locked));
    // Also dedup across editable+locked (editable wins if same name in both)
    const editNames = new Set((parsed.editable || []).map((f: any) => (f.name || "").toLowerCase().trim()));
    if (parsed.locked) {
      parsed.locked = parsed.locked.filter((f: any) => !editNames.has((f.name || "").toLowerCase().trim()));
    }
    // Final check: no notes field in locked if one exists in editable
    const editHasNotes = (parsed.editable || []).some((f: any) => NOTES_KEYWORDS.some((k) => (f.name || "").toLowerCase().includes(k)));
    if (editHasNotes && parsed.locked) {
      parsed.locked = parsed.locked.filter((f: any) => !NOTES_KEYWORDS.some((k) => (f.name || "").toLowerCase().includes(k)));
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
