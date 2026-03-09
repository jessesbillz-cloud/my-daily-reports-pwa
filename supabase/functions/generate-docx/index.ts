import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { unzipSync, zipSync } from "https://esm.sh/fflate@0.8.2";

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
    const { docx_base64, field_values } = await req.json();

    if (!docx_base64) {
      return new Response(JSON.stringify({ error: "No docx_base64 provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Decode the DOCX and unzip with fflate
    const raw = Uint8Array.from(atob(docx_base64), c => c.charCodeAt(0));
    const unzipped = unzipSync(raw);

    // Read document.xml
    const docEntry = unzipped["word/document.xml"];
    if (!docEntry) {
      throw new Error("No document.xml found in DOCX");
    }
    let documentXml = new TextDecoder().decode(docEntry);

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
      let tableMatch;
      const tblRe = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g;
      tblRe.lastIndex = 0;

      while (!matched && (tableMatch = tblRe.exec(documentXml)) !== null) {
        const tableXml = tableMatch[0];

        let rowMatch;
        const rRe = /<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g;
        rRe.lastIndex = 0;

        while (!matched && (rowMatch = rRe.exec(tableXml)) !== null) {
          const rowXml = rowMatch[0];

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

          for (let i = 0; i < cells.length; i++) {
            const cellText = normalizeLabel(cells[i].text);

            if (cellText === normalizedField ||
                cellText === normalizedField + ":" ||
                cellText.endsWith(normalizedField) ||
                cellText.endsWith(normalizedField + ":")) {

              // ── Adjacent cell: value is in the NEXT cell ──
              if (i + 1 < cells.length) {
                const oldValueCell = cells[i + 1].xml;
                const newValueCell = setCellValue(oldValueCell, val);
                const newRowXml = rowXml.replace(oldValueCell, newValueCell);
                const newTableXml = tableXml.replace(rowXml, newRowXml);
                documentXml = documentXml.replace(tableXml, newTableXml);
                matched = true;
                break;
              }

              // ── Same cell: label and value in one cell ──
              const cellXml = cells[i].xml;
              const runs: { xml: string; text: string }[] = [];
              let runMatch;
              const runRe = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
              runRe.lastIndex = 0;
              while ((runMatch = runRe.exec(cellXml)) !== null) {
                runs.push({ xml: runMatch[0], text: extractText(runMatch[0]) });
              }

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
                let newCellXml = cellXml;
                for (let r = labelEndIdx + 1; r < runs.length; r++) {
                  if (r === labelEndIdx + 1) {
                    const cleaned = clearAllText(runs[r].xml);
                    const withValue = cleaned.replace(
                      /<w:t([^>]*)><\/w:t>/,
                      `<w:t xml:space="preserve"> ${escapeXml(val)}</w:t>`
                    );
                    newCellXml = newCellXml.replace(runs[r].xml, withValue);
                  } else {
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
      if (!matched) {
        const labelVariants = [
          fieldName + ":",
          fieldName,
          fieldName.replace(/\s+/g, " "),
        ];

        for (const label of labelVariants) {
          const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const paraWithLabel = new RegExp(
            `(<w:p\\b[^>]*>(?:(?!<\\/w:p>)[\\s\\S])*?<w:t[^>]*>[^<]*${escaped}[^<]*<\\/w:t>)` +
            `((?:(?!<\\/w:p>)[\\s\\S])*?)(<\\/w:p>)`,
            "i"
          );

          if (paraWithLabel.test(documentXml)) {
            documentXml = documentXml.replace(paraWithLabel, (fullMatch, beforeLabel, afterLabel, closeP) => {
              let cleared = clearAllText(afterLabel);
              let set = false;
              cleared = cleared.replace(/<w:t([^>]*)><\/w:t>/, (m: string, attrs: string) => {
                if (set) return m;
                set = true;
                return `<w:t xml:space="preserve"> ${escapeXml(val)}</w:t>`;
              });
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
      if (!matched) {
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

    // ── Repack the DOCX with fflate ──
    const zipData: Record<string, Uint8Array> = {};

    // Add modified document.xml
    zipData["word/document.xml"] = new TextEncoder().encode(documentXml);

    // Add all other files unchanged
    for (const [filename, data] of Object.entries(unzipped)) {
      if (filename === "word/document.xml") continue;
      zipData[filename] = data as Uint8Array;
    }

    const outBytes = zipSync(zipData);

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
