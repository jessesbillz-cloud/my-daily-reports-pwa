import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { BlobReader, BlobWriter, ZipReader, ZipWriter, TextWriter } from "https://deno.land/x/zipjs@v2.7.32/index.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Generate a filled DOCX report by editing the template's XML.
 *
 * Strategy: Parse the XML structurally (tables → rows → cells → paragraphs → runs → text).
 * For each field label found, locate the value cell and replace ALL its text with the new value.
 * This prevents overlay issues where old text remains visible under new text.
 */
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

    const { docx_base64, field_values } = await req.json();

    if (!docx_base64) {
      return new Response(JSON.stringify({ error: "No docx_base64 provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Decode the DOCX
    const raw = Uint8Array.from(atob(docx_base64), c => c.charCodeAt(0));
    const blob = new Blob([raw]);
    const reader = new ZipReader(new BlobReader(blob));
    const entries = await reader.getEntries();

    // Read document.xml
    let documentXml = "";
    const otherEntries: { filename: string; data: Uint8Array }[] = [];

    for (const entry of entries) {
      if (entry.filename === "word/document.xml") {
        const writer = new TextWriter();
        documentXml = await entry.getData!(writer);
      } else {
        const blobWriter = new BlobWriter();
        const entryBlob = await entry.getData!(blobWriter);
        const arrBuf = await entryBlob.arrayBuffer();
        otherEntries.push({
          filename: entry.filename,
          data: new Uint8Array(arrBuf),
        });
      }
    }
    await reader.close();

    if (!documentXml) {
      throw new Error("No document.xml found in DOCX");
    }

    // ── Helper: extract all visible text from an XML chunk ──
    const extractText = (xml: string): string => {
      let text = "";
      let m;
      const re = /<w:t[^>]*>([^<]*)<\/w:t>/g;
      while ((m = re.exec(xml)) !== null) text += m[1];
      return text.trim();
    };

    // ── Helper: clear all <w:t> content in an XML chunk ──
    // Sets every <w:t> to empty string, preserving all formatting/structure
    const clearAllText = (xml: string): string => {
      return xml.replace(/<w:t([^>]*)>[^<]*<\/w:t>/g, '<w:t$1></w:t>');
    };

    // ── Helper: set value in a cell — clears all text, puts new value in first <w:t> ──
    const setCellValue = (cellXml: string, newValue: string): string => {
      // First clear ALL text nodes
      let result = clearAllText(cellXml);
      // Then set the first <w:t> to the new value (with xml:space="preserve" for whitespace)
      let replaced = false;
      result = result.replace(/<w:t([^>]*)><\/w:t>/, (match, attrs) => {
        if (replaced) return match;
        replaced = true;
        return `<w:t xml:space="preserve">${escapeXml(newValue)}</w:t>`;
      });
      // If no <w:t> existed at all, inject a run with text into the first paragraph
      if (!replaced) {
        result = result.replace(
          /(<w:p\b[^>]*>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?)/,
          `$1<w:r><w:t xml:space="preserve">${escapeXml(newValue)}</w:t></w:r>`
        );
      }
      return result;
    };

    // ── Build structured table data for reliable field matching ──
    // Extract all tables with their rows and cells
    const tableRegex = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g;
    const rowRegex = /<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g;
    const cellRegex = /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g;

    // Normalize a label for matching: lowercase, trim, remove trailing colon/spaces
    const normalizeLabel = (s: string): string =>
      s.toLowerCase().replace(/[\s:]+$/g, "").replace(/\s+/g, " ").trim();

    // ── Process each field value ──
    for (const [fieldName, newValue] of Object.entries(field_values)) {
      if (newValue === undefined || newValue === null) continue;
      const val = String(newValue);
      const normalizedField = normalizeLabel(fieldName);

      let matched = false;

      // ── Strategy 1: Table cell replacement ──
      // Walk through every table → row → cell looking for the label
      // When found, replace content in the ADJACENT cell (next cell in same row)
      // or in the SAME cell after the label text

      // We need to work on the full document XML and do replacements in-place
      // Use a function that finds and replaces within specific table structures

      // Extract all table blocks
      let tableMatch;
      const tblRe = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g;

      // Reset regex
      tblRe.lastIndex = 0;
      while (!matched && (tableMatch = tblRe.exec(documentXml)) !== null) {
        const tableXml = tableMatch[0];
        const tableStart = tableMatch.index;

        // Extract rows from this table
        let rowMatch;
        const rRe = /<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g;
        rRe.lastIndex = 0;

        while (!matched && (rowMatch = rRe.exec(tableXml)) !== null) {
          const rowXml = rowMatch[0];

          // Extract cells from this row
          const cells: { xml: string; text: string; start: number }[] = [];
          let cellMatch;
          const cRe = /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g;
          cRe.lastIndex = 0;

          while ((cellMatch = cRe.exec(rowXml)) !== null) {
            cells.push({
              xml: cellMatch[0],
              text: extractText(cellMatch[0]),
              start: cellMatch.index,
            });
          }

          // Look for label cell
          for (let i = 0; i < cells.length; i++) {
            const cellText = normalizeLabel(cells[i].text);

            // Check if this cell contains our field label
            if (cellText === normalizedField ||
                cellText === normalizedField + ":" ||
                cellText.endsWith(normalizedField) ||
                cellText.endsWith(normalizedField + ":")) {

              // ── Adjacent cell: value is in the NEXT cell ──
              if (i + 1 < cells.length) {
                const oldValueCell = cells[i + 1].xml;
                const newValueCell = setCellValue(oldValueCell, val);

                // Replace in the row
                const newRowXml = rowXml.replace(oldValueCell, newValueCell);
                // Replace the row in the table
                const newTableXml = tableXml.replace(rowXml, newRowXml);
                // Replace the table in the document
                documentXml = documentXml.replace(tableXml, newTableXml);
                matched = true;
                break;
              }

              // ── Same cell: label and value in one cell (e.g. "Date: Jan 31, 2026") ──
              // The label is part of the cell text; we need to keep the label but replace the value
              // Find the label text runs and the value text runs
              const cellXml = cells[i].xml;

              // Find all <w:r> runs in this cell
              const runs: { xml: string; text: string }[] = [];
              let runMatch;
              const runRe = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
              runRe.lastIndex = 0;
              while ((runMatch = runRe.exec(cellXml)) !== null) {
                runs.push({ xml: runMatch[0], text: extractText(runMatch[0]) });
              }

              // Find where the label ends and value begins
              let accText = "";
              let labelEndIdx = -1;
              for (let r = 0; r < runs.length; r++) {
                accText += runs[r].text;
                const accNorm = normalizeLabel(accText);
                if (accNorm === normalizedField || accNorm.endsWith(normalizedField)) {
                  labelEndIdx = r;
                  break;
                }
              }

              if (labelEndIdx >= 0 && labelEndIdx < runs.length - 1) {
                // Clear all runs after the label, put value in the first one after label
                let newCellXml = cellXml;
                for (let r = labelEndIdx + 1; r < runs.length; r++) {
                  if (r === labelEndIdx + 1) {
                    // First value run: set to new value
                    const cleaned = clearAllText(runs[r].xml);
                    const withValue = cleaned.replace(
                      /<w:t([^>]*)><\/w:t>/,
                      `<w:t xml:space="preserve"> ${escapeXml(val)}</w:t>`
                    );
                    newCellXml = newCellXml.replace(runs[r].xml, withValue);
                  } else {
                    // Subsequent value runs: clear them
                    newCellXml = newCellXml.replace(runs[r].xml, clearAllText(runs[r].xml));
                  }
                }
                const newRowXml = rowXml.replace(cellXml, newCellXml);
                const newTableXml = tableXml.replace(rowXml, newRowXml);
                documentXml = documentXml.replace(tableXml, newTableXml);
                matched = true;
                break;
              }
            }
          }
        }
      }

      // ── Strategy 2: Standalone paragraphs (outside tables) ──
      // Look for paragraphs with label text followed by value text
      if (!matched) {
        // Try to find the label in standalone paragraphs
        const labelVariants = [
          fieldName + ":",
          fieldName,
          fieldName.replace(/\s+/g, " "),
        ];

        for (const label of labelVariants) {
          const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

          // Find a paragraph containing this label, then replace text in next run
          const paraWithLabel = new RegExp(
            `(<w:p\\b[^>]*>(?:(?!<\\/w:p>)[\\s\\S])*?<w:t[^>]*>[^<]*${escaped}[^<]*<\\/w:t>)` +
            `((?:(?!<\\/w:p>)[\\s\\S])*?)(<\\/w:p>)`,
            "i"
          );

          if (paraWithLabel.test(documentXml)) {
            documentXml = documentXml.replace(paraWithLabel, (fullMatch, beforeLabel, afterLabel, closeP) => {
              // Clear all <w:t> in the after-label portion and set first one to value
              let cleared = clearAllText(afterLabel);
              let set = false;
              cleared = cleared.replace(/<w:t([^>]*)><\/w:t>/, (m: string, attrs: string) => {
                if (set) return m;
                set = true;
                return `<w:t xml:space="preserve"> ${escapeXml(val)}</w:t>`;
              });
              // If no <w:t> existed in after portion, append a run
              if (!set) {
                cleared += `<w:r><w:t xml:space="preserve"> ${escapeXml(val)}</w:t></w:r>`;
              }
              return beforeLabel + cleared + closeP;
            });
            matched = true;
            break;
          }
        }
      }

      // ── Strategy 3: Fallback — broad text replacement ──
      // If structured approaches failed, try a simple find-and-replace of the old value
      // This handles edge cases where the label isn't in a standard position
      if (!matched) {
        // Try to find the field label anywhere and replace the next <w:t> content
        const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const broadRegex = new RegExp(
          `(${escaped}[:\\s]*<\\/w:t>(?:[\\s\\S]*?)<w:t[^>]*>)([^<]*)(<\\/w:t>)`,
          "i"
        );
        if (broadRegex.test(documentXml)) {
          documentXml = documentXml.replace(broadRegex, `$1${escapeXml(val)}$3`);
        }
      }
    }

    // ── Repack the DOCX ──
    const outBlobWriter = new BlobWriter("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const zipWriter = new ZipWriter(outBlobWriter);

    // Add modified document.xml
    const docBlob = new Blob([documentXml], { type: "text/xml" });
    await zipWriter.add("word/document.xml", new BlobReader(docBlob));

    // Add all other files unchanged
    for (const entry of otherEntries) {
      const entryBlob = new Blob([entry.data]);
      await zipWriter.add(entry.filename, new BlobReader(entryBlob));
    }

    await zipWriter.close();
    const outBlob = await outBlobWriter.getData();
    const outBuf = await outBlob.arrayBuffer();
    const outBytes = new Uint8Array(outBuf);

    // Convert to base64
    let binary = "";
    for (let i = 0; i < outBytes.length; i++) binary += String.fromCharCode(outBytes[i]);
    const outBase64 = btoa(binary);

    return new Response(JSON.stringify({ docx_base64: outBase64 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
