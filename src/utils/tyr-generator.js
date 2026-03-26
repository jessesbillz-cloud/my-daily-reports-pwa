/**
 * TYR Engineering Daily Report — PDF Generator
 * Built with pdf-lib, runs 100% client-side in the browser.
 *
 * Usage:
 *   const pdfBytes = await generateTYR(reportData, jobData, profileData, logoBytes, signatureBytes, reportDate);
 *   // pdfBytes is a Uint8Array — download it or upload to Supabase Storage
 */

import { ensurePdfLib } from './pdf.js';

// pdf-lib uses bottom-left origin, but our coordinates were extracted in
// pdfplumber's top-left system. This helper converts.
// Page height = 792 (letter)
const PH = 792;
const PW = 612;
const Y = (t) => PH - t; // convert pdfplumber top-down to pdf-lib bottom-up

// ═══ COLORS (from TYR template extraction, RGB 0-1 normalized) ═══
const LIGHT_BLUE_BG = { r: 0.745, g: 0.824, b: 0.89 };    // header background
const BLUE_BAR      = { r: 0.329, g: 0.541, b: 0.718 };    // "DAILY REPORT" bars
const TEAL_DIVIDER  = { r: 0.0549, g: 0.333, b: 0.388 };   // teal line
const ORANGE_LABEL  = { r: 1.0, g: 0.859, b: 0.427 };      // orange label boxes
const GRAY_VALUE    = { r: 0.949, g: 0.949, b: 0.949 };    // gray value boxes
const PEACH_ZONE    = { r: 1.0, g: 0.953, b: 0.808 };      // peach content areas
const BLUE_HEADER   = { r: 0.831, g: 0.882, b: 0.929 };    // blue contractor headers
const GOLD_ACCENT   = { r: 1.0, g: 0.769, b: 0.0471 };     // gold lines
const BLACK         = { r: 0, g: 0, b: 0 };
const WHITE         = { r: 1, g: 1, b: 1 };

/**
 * Generate the TYR Engineering Daily Report PDF
 *
 * @param {Object} reportData - report data
 *   {
 *     vals: { field_key: value, ... },
 *     contractors: [{ company_name, manpower, equipment, trade }, ...],
 *     photos: [{ src, caption }, ...]
 *   }
 * @param {Object} job - job record
 *   { name, site_address, field_config: { ... } }
 * @param {Object} profile - { full_name, ... }
 * @param {Uint8Array} logoBytes - PNG bytes of TYR logo (or null)
 * @param {Uint8Array|null} signatureBytes - PNG bytes of signature (or null)
 * @param {string} reportDate - "MM/DD/YYYY" format
 * @returns {Uint8Array} PDF bytes
 */
export async function generateTYR(reportData, job, profile, logoBytes, signatureBytes, reportDate) {
  // Ensure pdf-lib is loaded
  await ensurePdfLib();
  const { PDFDocument, rgb, StandardFonts } = window.PDFLib;

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Embed logo
  let logoImage = null;
  if (logoBytes) {
    logoImage = await pdfDoc.embedPng(logoBytes);
  }

  // Embed signature
  let sigImage = null;
  if (signatureBytes) {
    sigImage = await pdfDoc.embedPng(signatureBytes);
  }

  const fc = job.field_config || {};
  const vals = reportData.vals || {};
  const contractors = reportData.contractors || [];
  const photos = reportData.photos || [];

  // ═══════════════ PAGE 1 ═══════════════
  const p1 = pdfDoc.addPage([PW, PH]);

  // Helper functions
  const drawText = (text, x, yt, size, f, color) => {
    if (!text) return;
    const clean = String(text).replace(/[\n\r]/g, " ");
    p1.drawText(clean, { x, y: Y(yt + size), size, font: f || font, color: rgb(color?.r ?? 0, color?.g ?? 0, color?.b ?? 0) });
  };

  const drawRect = (x, yt, w, h, color, opts = {}) => {
    p1.drawRectangle({ x, y: Y(yt + h), width: w, height: h, color: rgb(color.r, color.g, color.b), ...opts });
  };

  const drawLine = (x1, yt1, x2, yt2, color, thickness) => {
    p1.drawLine({
      start: { x: x1, y: Y(yt1) },
      end: { x: x2, y: Y(yt2) },
      thickness: thickness || 0.5,
      color: rgb(color?.r ?? 0, color?.g ?? 0, color?.b ?? 0)
    });
  };

  // Helper to get value from vals with fuzzy key matching
  const getValue = (keyPatterns) => {
    if (!Array.isArray(keyPatterns)) keyPatterns = [keyPatterns];
    for (const pattern of keyPatterns) {
      for (const key in vals) {
        if (key.toLowerCase().includes(pattern.toLowerCase())) {
          return vals[key];
        }
      }
    }
    return "";
  };

  // ═══════════════════════════════════════════════════════════════════════════════════
  // HEADER (light blue background)
  // ═══════════════════════════════════════════════════════════════════════════════════
  drawRect(0, 0, 612, 93.1, LIGHT_BLUE_BG);

  // Blue "DAILY REPORT" bars (2 horizontal bars)
  drawRect(16.5, 97, 579.2, 12, BLUE_BAR);
  drawRect(16.5, 109, 579.2, 12, BLUE_BAR);

  // Teal divider below bars
  drawLine(16.5, 121, 595.7, 121, TEAL_DIVIDER, 2.2);

  // "DAILY REPORT" split text (large D, small AILY, large R, small EPORT)
  drawText("D", 256.4, 104.7, 16, fontBold, BLACK);
  drawText("AILY", 268.9, 106.8, 10, font, BLACK);
  drawText("R", 303.1, 104.7, 16, fontBold, BLACK);
  drawText("EPORT", 313.6, 106.8, 10, font, BLACK);

  // Embed logo in header if provided
  if (logoImage) {
    // Position logo in top right of header
    p1.drawImage(logoImage, { x: 480, y: Y(93), width: 100, height: 25 });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // FIELD ROWS (Row 1-4: single height; Row 5: double height for hours)
  // ═══════════════════════════════════════════════════════════════════════════════════

  // ROW 1: District Name / Project Name
  drawRect(20.2, 127.5, 82.3, 14.8, ORANGE_LABEL);
  drawRect(104.5, 127.5, 205.1, 14.8, GRAY_VALUE);
  drawRect(311.6, 127.5, 106.1, 14.8, ORANGE_LABEL);
  drawRect(419.7, 127.5, 173.5, 14.8, GRAY_VALUE);

  drawText("District Name:", 22, 133.2, 9, fontBold, BLACK);
  drawText(getValue(["district"]), 109, 133.2, 9, font, BLACK);
  drawText("Project Name:", 314, 133.2, 9, fontBold, BLACK);
  drawText(getValue(["project_name", "name"]) || job.name || "", 424, 133.2, 9, font, BLACK);

  // ROW 2: Project Address (double height)
  drawRect(20.2, 144.5, 82.3, 27.5, ORANGE_LABEL);
  drawRect(104.5, 144.5, 488.7, 27.5, GRAY_VALUE);

  drawText("Project", 22, 149.8, 9, fontBold, BLACK);
  drawText("Address", 22, 162.6, 9, fontBold, BLACK);
  drawText(getValue(["address"]) || job.site_address || "", 109, 151.5, 9, font, BLACK);

  // ROW 3: DSA Number / TYR Project #
  drawRect(20.2, 174.2, 82.3, 14.8, ORANGE_LABEL);
  drawRect(104.5, 174.2, 205.1, 14.8, GRAY_VALUE);
  drawRect(311.6, 174.2, 106.1, 14.8, ORANGE_LABEL);
  drawRect(419.7, 174.2, 173.5, 14.8, GRAY_VALUE);

  drawText("DSA Number:", 22, 182.0, 9, fontBold, BLACK);
  drawText(getValue(["dsa"]), 109, 182.0, 9, font, BLACK);
  drawText("TYR Project #", 314, 182.0, 9, fontBold, BLACK);
  drawText(getValue(["tyr_project"]), 424, 182.0, 9, font, BLACK);

  // ROW 4: Date / Weather
  drawRect(20.2, 191.2, 82.3, 14.8, ORANGE_LABEL);
  drawRect(104.5, 191.2, 205.1, 14.8, GRAY_VALUE);
  drawRect(311.6, 191.2, 106.1, 14.8, ORANGE_LABEL);
  drawRect(419.7, 191.2, 173.5, 14.8, GRAY_VALUE);

  drawText("Date:", 22, 199.0, 9, fontBold, BLACK);
  drawText(reportDate || "", 109, 199.0, 9, font, BLACK);
  drawText("Weather", 314, 199.0, 9, fontBold, BLACK);
  drawText(getValue(["weather"]), 424, 199.0, 9, font, BLACK);

  // ROW 5: HOURS (double height, 6 cells)
  const hoursY = 208.2;
  const hoursH = 27.5;

  // Left section: Regular Hours label + value
  drawRect(20.2, hoursY, 82.3, hoursH, ORANGE_LABEL);
  drawRect(104.5, hoursY, 115.1, hoursH, GRAY_VALUE);
  drawText("Regular Hours", 22, hoursY + 6, 8, fontBold, BLACK);
  drawText(getValue(["regular_hours"]), 109, hoursY + 8, 10, font, BLACK);

  // Middle section: Overtime Hours label + value
  drawRect(221.6, hoursY, 88.0, hoursH, ORANGE_LABEL);
  drawRect(311.6, hoursY, 106.1, hoursH, GRAY_VALUE);
  drawText("Overtime Hours", 223, hoursY + 6, 8, fontBold, BLACK);
  drawText(getValue(["overtime_hours"]), 316, hoursY + 8, 10, font, BLACK);

  // Right section: Double Time / Hours label + value
  drawRect(419.7, hoursY, 97.0, hoursH, ORANGE_LABEL);
  drawRect(518.7, hoursY, 74.6, hoursH, GRAY_VALUE);
  drawText("Double Time", 422, hoursY + 1, 8, fontBold, BLACK);
  drawText("Hours", 422, hoursY + 13.7, 8, fontBold, BLACK);
  drawText(getValue(["double_time"]), 523, hoursY + 8, 10, font, BLACK);

  // Orange accent line below hours
  drawLine(16.5, 240.0, 595.7, 240.0, GOLD_ACCENT, 2.2);

  // ═══════════════════════════════════════════════════════════════════════════════════
  // INSPECTION NOTES SECTION
  // ═══════════════════════════════════════════════════════════════════════════════════

  drawText("INSPECTION NOTES", 262.1, 246.7, 10, fontBold, BLACK);

  // General box (peach background)
  drawRect(25.2, 258.4, 562, 28, PEACH_ZONE);
  p1.drawRectangle({
    x: 20, y: Y(258.4 + 28), width: 572, height: 28,
    borderColor: rgb(0, 0, 0), borderWidth: 0.5
  });

  drawText("General:", 25.2, 260.6, 9, fontBold, BLACK);
  const generalText = getValue(["general"]);
  if (generalText) {
    drawText(generalText, 70, 265, 8, font, BLACK);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // CONTRACTOR TABLE
  // ═══════════════════════════════════════════════════════════════════════════════════

  const contractorHeaderY = 288.7;
  const contractorHeaderH = 14.8;

  // Blue header row
  drawRect(20.5, contractorHeaderY, 161.8, contractorHeaderH, BLUE_HEADER);
  drawRect(182.3, contractorHeaderY, 152.8, contractorHeaderH, BLUE_HEADER);
  drawRect(335.1, contractorHeaderY, 137.6, contractorHeaderH, BLUE_HEADER);
  drawRect(472.7, contractorHeaderY, 119.3, contractorHeaderH, BLUE_HEADER);

  // Header text
  drawText("Contractor Names:", 22, 296.6, 9, fontBold, BLACK);
  drawText("Manpower:", 184, 296.6, 9, fontBold, BLACK);
  drawText("Equipment:", 337, 296.6, 9, fontBold, BLACK);
  drawText("Trade:", 474, 296.6, 9, fontBold, BLACK);

  // Header dividers
  drawLine(181.2, 288.7, 181.2, 303.5, BLACK, 0.5);
  drawLine(334.0, 288.7, 334.0, 303.5, BLACK, 0.5);
  drawLine(471.6, 288.7, 471.6, 303.5, BLACK, 0.5);

  // Data rows (gray, max 3 rows)
  const contractorRowH = 14.8;
  const contractorRows = [
    { y: 305.7 },
    { y: 322.8 },
    { y: 339.8 }
  ];

  for (let i = 0; i < contractorRows.length; i++) {
    const rowY = contractorRows[i].y;

    // Gray background for each column
    drawRect(20.5, rowY, 161.8, contractorRowH, GRAY_VALUE);
    drawRect(182.3, rowY, 152.8, contractorRowH, GRAY_VALUE);
    drawRect(335.1, rowY, 137.6, contractorRowH, GRAY_VALUE);
    drawRect(472.7, rowY, 119.3, contractorRowH, GRAY_VALUE);

    // Column dividers
    drawLine(181.2, rowY, 181.2, rowY + contractorRowH, BLACK, 0.5);
    drawLine(334.0, rowY, 334.0, rowY + contractorRowH, BLACK, 0.5);
    drawLine(471.6, rowY, 471.6, rowY + contractorRowH, BLACK, 0.5);

    // Fill contractor data if available
    if (i < contractors.length) {
      const c = contractors[i];
      drawText(c.company_name || "", 22, rowY + 7, 8, font, BLACK);
      drawText(c.manpower || "", 184, rowY + 7, 8, font, BLACK);
      drawText(c.equipment || "", 337, rowY + 7, 8, font, BLACK);
      drawText(c.trade || "", 474, rowY + 7, 8, font, BLACK);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // DAILY ACTIVITIES SECTION
  // ═══════════════════════════════════════════════════════════════════════════════════

  // Label row (peach)
  drawRect(20.5, 356.9, 571.5, 13.0, PEACH_ZONE);
  drawText("Daily Activities:", 25.2, 360.6, 9, fontBold, BLACK);

  // Content area (peach)
  drawRect(20.5, 369.9, 571.5, 60.0, PEACH_ZONE);
  p1.drawRectangle({
    x: 20, y: Y(369.9 + 60), width: 572, height: 60,
    borderColor: rgb(0, 0, 0), borderWidth: 0.5
  });

  const dailyActivities = getValue(["daily_activities", "activities"]);
  if (dailyActivities) {
    // Split by newlines and draw as bullet points
    const lines = dailyActivities.split("\n").filter(l => l.trim());
    let actY = 375;
    for (const line of lines) {
      const bullet = "• " + line.trim();
      drawText(bullet, 25.2, actY, 8, font, BLACK);
      actY += 11;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // BOTTOM SECTION (Inspection Requests, RFIs, CCDs, Site Visits, Notes)
  // ═══════════════════════════════════════════════════════════════════════════════════

  // Inspection Requests (peach label row)
  drawRect(20.5, 432.1, 571.5, 13.9, PEACH_ZONE);
  drawText("Inspection Requests:", 25.2, 434.3, 9, fontBold, BLACK);
  p1.drawRectangle({
    x: 20, y: Y(432.1 + 13.9), width: 572, height: 13.8,
    borderColor: rgb(0, 0, 0), borderWidth: 0.5
  });
  drawText(getValue(["inspection_requests"]), 25.2, 443.5, 8, font, BLACK);

  // RFIs | Submittals (gray, split at center)
  drawRect(20.5, 449.2, 284.4, 14.8, GRAY_VALUE);
  drawRect(304.9, 449.2, 287.1, 14.8, GRAY_VALUE);
  drawLine(304.9, 449.2, 304.9, 464.0, BLACK, 0.5);
  drawText("RFIs:", 25.2, 451.4, 8, fontBold, BLACK);
  drawText(getValue(["rfis"]), 50, 451.4, 8, font, BLACK);
  drawText("Submittals:", 311.9, 451.4, 8, fontBold, BLACK);
  drawText(getValue(["submittals"]), 380, 451.4, 8, font, BLACK);

  // CCDs | ASIs (gray, split at center)
  drawRect(20.5, 466.2, 284.4, 14.8, GRAY_VALUE);
  drawRect(304.9, 466.2, 287.1, 14.8, GRAY_VALUE);
  drawLine(304.9, 466.2, 304.9, 481.0, BLACK, 0.5);
  drawText("CCDs:", 25.2, 468.4, 8, fontBold, BLACK);
  drawText(getValue(["ccds"]), 50, 468.4, 8, font, BLACK);
  drawText("ASIs:", 311.9, 468.4, 8, fontBold, BLACK);
  drawText(getValue(["asis"]), 340, 468.4, 8, font, BLACK);

  // Site Visits (peach)
  drawRect(20.5, 483.3, 571.5, 14.8, PEACH_ZONE);
  drawText("Site Visits:", 25.2, 485.5, 8, fontBold, BLACK);
  drawText(getValue(["site_visits"]), 100, 485.5, 8, font, BLACK);

  // Notes and Comments (peach)
  drawRect(20.5, 500.3, 571.5, 14.8, PEACH_ZONE);
  drawText("Notes and Comments:", 25.2, 502.5, 8, fontBold, BLACK);
  drawText(getValue(["notes"]), 150, 502.5, 8, font, BLACK);

  // ═══════════════════════════════════════════════════════════════════════════════════
  // SIGNATURE SECTION
  // ═══════════════════════════════════════════════════════════════════════════════════

  // Orange accent lines
  drawLine(16.5, 525.4, 595.7, 525.4, GOLD_ACCENT, 2.2);
  drawLine(16.5, 547.6, 595.7, 547.6, GOLD_ACCENT, 2.2);

  // Additional docs row (gray)
  drawRect(20.5, 549.8, 571.5, 14.8, GRAY_VALUE);
  drawText("ADDITIONAL DOCUMENTATION AND PHOTOS AS NEEDED", 159.8, 556, 8, font, BLACK);

  // Signature lines (gold)
  drawLine(20.2, 586.8, 421.6, 586.8, GOLD_ACCENT, 2.2);
  drawLine(438.2, 586.8, 592.8, 586.8, GOLD_ACCENT, 2.2);

  // Signature image
  if (sigImage) {
    p1.drawImage(sigImage, { x: 320, y: Y(600), width: 100, height: 25 });
  }

  // Signature labels
  drawText("Inspector Signature", 60, 600, 8, font, BLACK);
  drawText("Date", 480, 600, 8, font, BLACK);

  // ═══════════════════════════════════════════════════════════════════════════════════
  // PHOTO PAGES
  // ═══════════════════════════════════════════════════════════════════════════════════

  // Calculate total pages for footer
  const photoPageCount = Math.max(1, Math.ceil(photos.length / 4));
  const totalPages = 1 + photoPageCount;

  // Helper: Draw photo page header
  const drawPhotoPageHeader = (page, pageNum) => {
    const dpText = (text, x, yt, size, f, color) => {
      if (!text) return;
      const clean = String(text).replace(/[\n\r]/g, " ");
      page.drawText(clean, { x, y: Y(yt + size), size, font: f || font, color: rgb(color?.r ?? 0, color?.g ?? 0, color?.b ?? 0) });
    };
    const dpRect = (x, yt, w, h, color) => {
      page.drawRectangle({ x, y: Y(yt + h), width: w, height: h, color: rgb(color.r, color.g, color.b) });
    };

    // Header background (light blue)
    dpRect(0, 0, 612, 93.1, LIGHT_BLUE_BG);

    // Blue bars
    dpRect(16.5, 97, 579.2, 12, BLUE_BAR);
    dpRect(16.5, 109, 579.2, 12, BLUE_BAR);

    // Teal divider
    dpRect(16.5, 121, 579.2, 2.2, TEAL_DIVIDER);

    // "ATTACHMENT" text
    dpText("ATTACHMENT", 262.1, 105, 16, fontBold, BLACK);

    // Embed logo if available
    if (logoImage) {
      page.drawImage(logoImage, { x: 480, y: Y(93), width: 100, height: 25 });
    }

    // Footer
    const pgText = `Page ${pageNum} of ${totalPages}`;
    dpText(pgText, 550 - font.widthOfTextAtSize(pgText, 7), 738.8, 7, font, BLACK);
  };

  // Helper: Embed a single photo onto a page
  const embedPhoto = async (page, photo, pos) => {
    if (!photo.imageBytes) return;
    let img;
    if (photo.imageBytes[0] === 0x89 && photo.imageBytes[1] === 0x50) {
      img = await pdfDoc.embedPng(photo.imageBytes);
    } else {
      img = await pdfDoc.embedJpg(photo.imageBytes);
    }
    const scale = Math.min(pos.w / img.width, pos.h / img.height);
    const scaledW = img.width * scale;
    const scaledH = img.height * scale;
    const offsetX = pos.x + (pos.w - scaledW) / 2;
    const offsetY = Y(pos.y + pos.h) + (pos.h - scaledH) / 2;
    page.drawImage(img, { x: offsetX, y: offsetY, width: scaledW, height: scaledH });

    if (photo.caption) {
      const capWidth = font.widthOfTextAtSize(photo.caption, 9);
      const capX = pos.x + (pos.w - capWidth) / 2;
      const clean = String(photo.caption).replace(/[\n\r]/g, " ");
      page.drawText(clean, { x: capX, y: Y(pos.y + pos.h + 8 + 9), size: 9, font, color: rgb(0, 0, 0) });
    }
  };

  // Photo positions (4 per page, 2x2 grid)
  const photoSlots = [
    { x: 50, y: 145, w: 250, h: 180 },      // top left
    { x: 312, y: 145, w: 250, h: 180 },     // top right
    { x: 50, y: 345, w: 250, h: 180 },      // bottom left
    { x: 312, y: 345, w: 250, h: 180 },     // bottom right
  ];

  // Build photo pages
  for (let pp = 0; pp < photoPageCount; pp++) {
    const page = pdfDoc.addPage([PW, PH]);
    const pageNum = 2 + pp;
    drawPhotoPageHeader(page, pageNum);

    // Place up to 4 photos on this page
    for (let slot = 0; slot < 4; slot++) {
      const photoIdx = pp * 4 + slot;
      if (photoIdx < photos.length) {
        await embedPhoto(page, photos[photoIdx], photoSlots[slot]);
      }
    }
  }

  // Generate bytes
  return await pdfDoc.save();
}
