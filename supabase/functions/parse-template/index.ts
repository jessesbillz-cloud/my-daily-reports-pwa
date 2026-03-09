import "https://deno.land/x/xhr@0.3.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { unzipSync } from "https://esm.sh/fflate@0.8.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── DOCX XML parser — extracts text structure from .docx ZIP ──
function parseDocxToTextItems(docxBytes: Uint8Array): any[] {
  // .docx is a ZIP — use fflate to unzip, then grab word/document.xml
  let documentXml = "";

  const unzipped = unzipSync(docxBytes);
  const docEntry = unzipped["word/document.xml"];
  if (docEntry) {
    documentXml = new TextDecoder().decode(docEntry);
  }

  if (!documentXml) throw new Error("Could not extract document.xml from .docx file");

  const items: any[] = [];
  let y = 0;
  const PAGE_W = 612;

  const extractText = (xml: string): string => {
    let text = "";
    let m;
    const re = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    while ((m = re.exec(xml)) !== null) text += m[1];
    return text.trim();
  };

  const boldRegex = /<w:b\s*\/?>|<w:b\s[^>]*\/>/;
  const isBold = (xml: string): boolean => boldRegex.test(xml);

  // First pass: extract table content
  const tableRe = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g;
  let tableMatch;
  while ((tableMatch = tableRe.exec(documentXml)) !== null) {
    const tableXml = tableMatch[1];
    const rowRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
    let rowMatch;
    while ((rowMatch = rowRe.exec(tableXml)) !== null) {
      const rowXml = rowMatch[1];
      const cellRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
      let cellMatch;
      let cellX = 36;
      const cellWidth = (PAGE_W - 72) / 4;
      let cellIdx = 0;
      while ((cellMatch = cellRe.exec(rowXml)) !== null) {
        const cellXml = cellMatch[1];
        const cellTexts: string[] = [];
        const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
        let pMatch;
        while ((pMatch = pRe.exec(cellXml)) !== null) {
          const pText = extractText(pMatch[1]);
          if (pText) cellTexts.push(pText);
        }
        const fullText = cellTexts.join(" ").trim();
        if (fullText) {
          const bold = isBold(cellXml);
          items.push({
            str: fullText, x: Math.round(cellX), y: Math.round(y),
            w: Math.round(cellWidth), h: 14, page: 1, fontSize: 10,
            bold, inTable: true, cellIndex: cellIdx,
          });
        }
        cellX += cellWidth;
        cellIdx++;
      }
      y += 18;
    }
    y += 10;
  }

  // Second pass: standalone paragraphs outside tables
  const noTables = documentXml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, "");
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let pMatch;
  while ((pMatch = pRe.exec(noTables)) !== null) {
    const pText = extractText(pMatch[1]);
    if (pText && pText.length > 1) {
      const bold = isBold(pMatch[1]);
      items.push({
        str: pText, x: 36, y: Math.round(y),
        w: PAGE_W - 72, h: 14, page: 1,
        fontSize: bold ? 14 : 10, bold, inTable: false,
      });
      y += 16;
    }
  }

  return items;
}

// ── Safely extract JSON from AI response text ──
function extractJSON(text: string): any {
  // Strip markdown fences
  let clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

  // Try parsing as-is
  try { return JSON.parse(clean); } catch (_) {}

  // Find the first { and last } for object
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return JSON.parse(clean.substring(firstBrace, lastBrace + 1)); } catch (_) {}
  }

  // Find array brackets
  const firstBracket = clean.indexOf("[");
  const lastBracket = clean.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try { return JSON.parse(clean.substring(firstBracket, lastBracket + 1)); } catch (_) {}
  }

  throw new Error("Could not extract valid JSON from AI response");
}

// Claude does SEMANTIC classification — coordinates come from text extraction (PDF) or table structure (DOCX)
const PROMPT = `You are analyzing text items extracted from an inspection report template.
Each item has: str (the text), x, y, w, h (position/size in points), page, fontSize.

YOUR JOB: Identify which text items are FIELD LABELS (like "Date:", "Project Name:", "IOR Notes:").
For each label you find, classify it.

FIELD CLASSIFICATION — determine if each field CHANGES per report or STAYS THE SAME:
- CHANGES per report (→ editable): Date, Report Date, Report Number, DR#, Daily Report, Notes, IOR Notes, Observations, Comments, Work Observed, Weather, Hours, Time In, Time Out, Temperature, Correction Notices Issued, Observation Letters Issued, Inspection Activities, On-Site Activities
- STAYS THE SAME (→ locked): Project Name, Owner, Client, District, DSA File #, DSA App #, Contractor, Architect, Engineer, Inspector, IOR, Project Inspector, Address, Location, Project No, Project Manager, Jurisdiction

IMPORTANT — DETECTING ALL DATE FIELDS:
- There may be MULTIPLE date fields on the document (e.g. a "Date:" at the top AND a date near a signature at the bottom).
- Dates can appear ANYWHERE: top of page, bottom-right corner, next to signatures, in footers.
- If a date value (e.g. "Jan 31, 2026", "01/31/2026") appears near a signature line or at the bottom of the page, it IS a date field — include it as a separate field like "Signature Date".
- Look for standalone date values even WITHOUT an explicit "Date:" label. If a text item looks like a date and is near a signature, it is a date field.

For each field label found, return:
- "label": The exact text string from the document (must match one of the str values)
- "name": Clean field name (e.g. "Date", "Signature Date", "Project Name", "IOR Notes")
- "category": "editable" or "locked"
- "layout": "inline" (value is in the adjacent cell or after the label on same line) or "below" (value area is below the label)
- "autoFill": "date" for ALL date fields (including signature dates), "increment" for report number fields, null otherwise
- "voiceEnabled": true for notes/observations/comments/activities fields, false otherwise
- "multiline": true for notes/observations/comments/activities fields, false otherwise
- "valueText": If you can identify the current value text near this label, include the exact str. Otherwise empty string.

CRITICAL RULES:
1. NEVER output duplicate field names. Each field appears EXACTLY ONCE. If there are multiple dates, give them UNIQUE names (e.g. "Date", "Signature Date", "Report Date").
2. If a label appears multiple times (e.g. "IOR Notes" in header AND as section heading), pick the one with the larger writable area (layout: "below").
3. NOTES/OBSERVATIONS: Output exactly ONE notes field with layout "below", multiline true, voiceEnabled true.
4. Ignore signature LINES themselves (the line where someone signs) and page numbers.
5. The "label" field MUST exactly match a "str" value from the input text items.
6. Date values next to signatures ARE fields and MUST be included.

Return ONLY valid JSON object with "fields" array, no markdown, no explanation:
{"fields":[{"label":"Date:","name":"Date","category":"editable","layout":"inline","autoFill":"date","voiceEnabled":false,"multiline":false,"valueText":""}]}`;

// Separate prompt for filename convention analysis
const FILENAME_PROMPT = `You are analyzing a PDF filename to determine its naming convention.

Given a filename like "Daily Report 45 Woodland Park 03-08-2026", you must identify which parts are TOKENS that change per report and which parts are STATIC text.

TOKENS to detect:
- {report_number}: The report/inspection number (e.g. "45", "001", "12")
- {date}: A date in any format (e.g. "03-08-2026", "2026-03-08", "03.08.2026", "03082026", "March 8 2026")
- {year}: A standalone year (e.g. "2026") — only if no full date is present

Return a JSON object:
- "pattern": The filename with tokens replacing the dynamic parts. Keep ALL static text exactly as-is.
- "dateFormat": The detected date format using these codes: MM=2-digit month, DD=2-digit day, YYYY=4-digit year, Month=full month name, Mon=abbreviated month. Use the actual separator found.
  If no date found, use "".
- "numberPadding": How many digits the report number is zero-padded to (e.g. "45"→0, "045"→3). Use 0 if no padding detected.

Return ONLY valid JSON, no markdown, no explanation.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { text_items, file_name, docx_base64 } = body;

    // Two paths: PDF sends text_items, DOCX sends docx_base64
    let resolvedItems = text_items;
    let fileType = "pdf";

    if (docx_base64) {
      fileType = "docx";
      try {
        const raw = Uint8Array.from(atob(docx_base64), c => c.charCodeAt(0));
        resolvedItems = parseDocxToTextItems(raw);
      } catch (docxErr) {
        return new Response(JSON.stringify({
          error: "Could not parse DOCX file: " + (docxErr.message || "Unknown error") + ". Try saving the file as a new .docx in Word first."
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (!resolvedItems || !resolvedItems.length) {
      return new Response(JSON.stringify({ error: "No text items found in document. The template may be image-based — try a text-based PDF." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Format text items for Claude
    const itemsSummary = resolvedItems.map((t: any, i: number) =>
      `[${i}] page:${t.page} str:"${t.str}" x:${t.x} y:${t.y} w:${t.w} h:${t.h} fs:${t.fontSize}${t.bold ? " BOLD" : ""}${t.inTable ? " TABLE" : ""}`
    ).join("\n");

    const userMsg = `Here are ${resolvedItems.length} text items extracted from "${file_name}" (${fileType}):\n\n${itemsSummary}\n\n${PROMPT}`;

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured. Set it in Supabase Edge Function secrets." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiHeaders = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };

    // Fire both requests in parallel — field analysis + filename convention
    const cleanName = (file_name || "").replace(/\.[^.]+$/, "");
    const fnMsg = `Analyze this filename and determine the naming convention:\n\n"${cleanName}"\n\n${FILENAME_PROMPT}`;

    const [fieldsResp, fnResp] = await Promise.all([
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          messages: [{ role: "user", content: userMsg }],
        }),
      }),
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 512,
          messages: [{ role: "user", content: fnMsg }],
        }),
      }),
    ]);

    const data = await fieldsResp.json();
    const fnData = await fnResp.json();

    if (data.error) {
      return new Response(JSON.stringify({ error: "AI service error: " + (data.error.message || JSON.stringify(data.error)) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse filename convention result (non-fatal if it fails)
    let filenameConvention: any = null;
    try {
      const fnRaw = fnData.content?.map((c: any) => c.text || "").join("") || "";
      filenameConvention = extractJSON(fnRaw);
    } catch (_e) {
      // Non-fatal
    }

    // Parse field analysis result
    const rawText = data.content?.map((c: any) => c.text || "").join("") || "";
    let parsed: any;
    try {
      parsed = extractJSON(rawText);
    } catch (jsonErr) {
      return new Response(JSON.stringify({
        error: "AI returned invalid response. Please try again.",
        rawResponse: rawText.substring(0, 200)
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const fieldMappings = Array.isArray(parsed) ? parsed : (parsed.fields || parsed);

    if (!Array.isArray(fieldMappings) || fieldMappings.length === 0) {
      return new Response(JSON.stringify({
        error: "AI could not identify any fields in this template. You can still create the job and configure fields manually.",
        editable: [],
        locked: [],
        fileType
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Reconstruct coordinates from real text positions ──
    const itemsByStr = new Map<string, any[]>();
    for (const item of resolvedItems) {
      const key = (item.str || "").trim();
      if (!itemsByStr.has(key)) itemsByStr.set(key, []);
      itemsByStr.get(key)!.push(item);
    }

    const itemsByPage = new Map<number, any[]>();
    for (const item of resolvedItems) {
      const pg = item.page || 1;
      if (!itemsByPage.has(pg)) itemsByPage.set(pg, []);
      itemsByPage.get(pg)!.push(item);
    }
    for (const [, items] of itemsByPage) {
      items.sort((a: any, b: any) => a.y - b.y || a.x - b.x);
    }

    const PADDING = 4;
    const PAGE_WIDTH = 612;

    const findLabelItem = (label: string, page?: number): any | null => {
      const exactMatches = itemsByStr.get(label) || [];
      if (exactMatches.length === 1) return exactMatches[0];
      if (exactMatches.length > 1 && page) {
        const onPage = exactMatches.filter((m: any) => m.page === page);
        if (onPage.length > 0) return onPage[0];
      }
      if (exactMatches.length > 0) return exactMatches[0];

      const variants = [label.replace(/:$/, "").trim(), label.trim() + ":", label.trim()];
      for (const v of variants) {
        const matches = itemsByStr.get(v);
        if (matches && matches.length > 0) {
          if (page) {
            const onPage = matches.filter((m: any) => m.page === page);
            if (onPage.length > 0) return onPage[0];
          }
          return matches[0];
        }
      }

      for (const item of resolvedItems) {
        if ((item.str || "").toLowerCase().includes(label.toLowerCase())) {
          if (!page || item.page === page) return item;
        }
      }
      return null;
    };

    const findNextItemRight = (item: any): any | null => {
      const pageItems = itemsByPage.get(item.page || 1) || [];
      const yTolerance = (item.h || 10) * 0.6;
      let best: any = null;
      let bestDist = Infinity;
      for (const other of pageItems) {
        if (other === item) continue;
        if (Math.abs(other.y - item.y) > yTolerance) continue;
        const dist = other.x - (item.x + (item.w || 0));
        if (dist > -2 && dist < bestDist) { bestDist = dist; best = other; }
      }
      return best;
    };

    const findNextItemBelow = (item: any): any | null => {
      const pageItems = itemsByPage.get(item.page || 1) || [];
      let best: any = null;
      let bestDist = Infinity;
      for (const other of pageItems) {
        if (other === item) continue;
        const dist = other.y - (item.y + (item.h || 10));
        if (dist > 2 && dist < bestDist) { bestDist = dist; best = other; }
      }
      return best;
    };

    const editable: any[] = [];
    const locked: any[] = [];
    const NOTES_KEYWORDS = ["notes", "observations", "comments"];

    // Column detection for inline field positioning
    const columnCache = new Map<number, number[]>();
    const getColumnStarts = (pg: number): number[] => {
      if (columnCache.has(pg)) return columnCache.get(pg)!;
      const pgItems = itemsByPage.get(pg) || [];
      const rows = new Map<number, any[]>();
      for (const item of pgItems) {
        const yKey = Math.round(item.y / 14) * 14;
        if (!rows.has(yKey)) rows.set(yKey, []);
        rows.get(yKey)!.push(item);
      }
      const valXs: number[] = [];
      for (const [, rItems] of rows) {
        const sorted = [...rItems].sort((a: any, b: any) => a.x - b.x);
        if (sorted.length >= 2) valXs.push(sorted[1].x);
        if (sorted.length >= 4) valXs.push(sorted[3].x);
      }
      valXs.sort((a, b) => a - b);
      const clusters: { sum: number; count: number; avg: number }[] = [];
      for (const xv of valXs) {
        const last = clusters[clusters.length - 1];
        if (last && Math.abs(xv - last.avg) < 25) {
          last.sum += xv; last.count++; last.avg = last.sum / last.count;
        } else {
          clusters.push({ sum: xv, count: 1, avg: xv });
        }
      }
      const cols = clusters.filter(c => c.count >= 2).map(c => Math.round(c.avg));
      columnCache.set(pg, cols);
      return cols;
    };

    for (const mapping of fieldMappings) {
      if (!mapping || !mapping.label) continue;
      const labelItem = findLabelItem(mapping.label, mapping.page);
      if (!labelItem) continue;

      let x: number, y: number, w: number, h: number;
      const fontSize = labelItem.fontSize || 10;
      const page = labelItem.page || 1;

      if (mapping.layout === "below") {
        x = labelItem.x;
        y = labelItem.y + (labelItem.h || fontSize) + PADDING;
        w = PAGE_WIDTH - labelItem.x - 36;
        const nextBelow = findNextItemBelow(labelItem);
        h = nextBelow ? Math.max(nextBelow.y - y - PADDING, 40) : 100;
      } else {
        const labelEnd = labelItem.x + (labelItem.w || 0);
        x = labelEnd + PADDING;
        y = labelItem.y;

        if (mapping.valueText) {
          const valVariants = [mapping.valueText, mapping.valueText.trim()];
          for (const vt of valVariants) {
            const valMatches = itemsByStr.get(vt);
            if (valMatches) {
              const samePage = valMatches.find((v: any) => (v.page || 1) === page && v.x > labelEnd);
              if (samePage) { x = samePage.x; break; }
            }
          }
        }

        if (x < labelEnd + 20) {
          const cols = getColumnStarts(page);
          const snapCol = cols.find((cx: number) => cx > labelEnd + 10 && cx < labelEnd + 250);
          if (snapCol) x = snapCol;
        }

        const nextRight = findNextItemRight(labelItem);
        if (nextRight && nextRight.x > x) {
          w = nextRight.x - x - PADDING;
        } else {
          w = PAGE_WIDTH - x - 36;
        }
        h = labelItem.h || fontSize;
      }

      if (x > 560) x = labelItem.x + 5;
      if (w < 20) w = 100;
      if (h < 10) h = fontSize;

      const field: any = {
        name: mapping.name,
        value: mapping.valueText || "",
        page,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        w: Math.round(w * 100) / 100,
        h: Math.round(h * 100) / 100,
        fontSize: Math.round(fontSize * 10) / 10,
        multiline: mapping.multiline || false,
        voiceEnabled: mapping.voiceEnabled || false,
      };

      if (mapping.autoFill) field.autoFill = mapping.autoFill;

      if (mapping.category === "editable") {
        editable.push(field);
      } else {
        locked.push(field);
      }
    }

    // ── Dedup and merge notes ──
    const dedup = (arr: any[]) => {
      const seen = new Set<string>();
      return arr.filter((f) => {
        const key = (f.name || "").toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const mergeNotes = (arr: any[]) => {
      const notesFields = arr.filter((f) => {
        const n = (f.name || "").toLowerCase();
        return NOTES_KEYWORDS.some((k) => n.includes(k));
      });
      if (notesFields.length <= 1) return arr;
      const best = notesFields.reduce((a, b) => ((a.w || 0) * (a.h || 0) >= (b.w || 0) * (b.h || 0) ? a : b));
      return arr.filter((f) => {
        const n = (f.name || "").toLowerCase();
        const isNotes = NOTES_KEYWORDS.some((k) => n.includes(k));
        return !isNotes || f.name === best.name;
      });
    };

    const dedupedEditable = mergeNotes(dedup(editable));
    const editNames = new Set(dedupedEditable.map((f: any) => (f.name || "").toLowerCase().trim()));
    let dedupedLocked = mergeNotes(dedup(locked));
    dedupedLocked = dedupedLocked.filter((f: any) => !editNames.has((f.name || "").toLowerCase().trim()));
    const editHasNotes = dedupedEditable.some((f: any) => NOTES_KEYWORDS.some((k) => (f.name || "").toLowerCase().includes(k)));
    if (editHasNotes) {
      dedupedLocked = dedupedLocked.filter((f: any) => !NOTES_KEYWORDS.some((k) => (f.name || "").toLowerCase().includes(k)));
    }

    const result: any = { editable: dedupedEditable, locked: dedupedLocked, fileType };
    if (filenameConvention) result.filenameConvention = filenameConvention;
    if (fileType === "docx") result.docxTextItems = resolvedItems;

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Parse failed: " + (error.message || "Unknown error") }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
