import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { BlobReader, BlobWriter, ZipReader, ZipWriter, TextWriter } from "https://deno.land/x/zipjs@v2.7.32/index.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Generate a filled DOCX report by editing the template's XML.
 *
 * Input: { docx_base64, field_values: { "Date": "Mar 8, 2026", "Weather": "Clear", ... } }
 * Output: { docx_base64: "..." } (the modified DOCX as base64)
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
        // Store all other files as-is
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

    // ── Replace field values in the document XML ──
    // Strategy: Find table cells that contain field labels (bold text followed by value),
    // and replace the value text in the adjacent cell or same cell.
    //
    // DOCX table structure: <w:tbl> → <w:tr> (row) → <w:tc> (cell) → <w:p> (paragraph) → <w:r> (run) → <w:t> (text)
    //
    // For each field_value, find the label text in the XML and replace the value
    // that follows it (in the next cell of the same row, or after the label in the same cell)

    for (const [fieldName, newValue] of Object.entries(field_values)) {
      if (newValue === undefined || newValue === null) continue;
      const val = String(newValue);

      // Build possible label patterns to search for
      const labelVariants = [
        fieldName + ":",
        fieldName,
        fieldName.replace(/\s+/g, " "),
      ];

      // Find and replace in table cells
      // Pattern: a row has cells where one contains the label (bold) and the next contains the value
      // We need to find the label cell and replace content in the value cell

      // First try: look for the label text split across w:t elements in the XML
      // The label might be in one cell and the value in the adjacent cell
      for (const label of labelVariants) {
        // Escape for regex
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        // Pattern 1: Label and value in adjacent table cells within the same row
        // Look for <w:tc> containing the label, followed by <w:tc> containing the old value
        const rowRegex = new RegExp(
          `(<w:tc\\b[^>]*>(?:(?!<\\/w:tc>)[\\s\\S])*?${escaped}(?:(?!<\\/w:tc>)[\\s\\S])*?<\\/w:tc>\\s*<w:tc\\b[^>]*>(?:(?!<\\/w:tc>)[\\s\\S])*?)(<w:t[^>]*>)([^<]*?)(<\\/w:t>)`,
          "i"
        );

        if (rowRegex.test(documentXml)) {
          documentXml = documentXml.replace(rowRegex, `$1$2${escapeXml(val)}$4`);
          break;
        }

        // Pattern 2: Label and value in the same cell (label: value format)
        // Look for "Label:" followed by text in the next run
        const sameCellRegex = new RegExp(
          `(${escaped}\\s*<\\/w:t>(?:(?!<\\/w:tc>)[\\s\\S])*?<w:t[^>]*>)([^<]*?)(<\\/w:t>)`,
          "i"
        );

        if (sameCellRegex.test(documentXml)) {
          documentXml = documentXml.replace(sameCellRegex, `$1${escapeXml(val)}$3`);
          break;
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
