/**
 * Ninyo & Moore LOR Inspector's Daily Report — PDF Generator
 * Built with pdf-lib, runs 100% client-side in the browser.
 * 
 * CDN: https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js
 * 
 * Usage:
 *   const pdfBytes = await generateNMLOR(reportData, jobData, profileData, logoBytes, signatureBytes, photoList);
 *   // pdfBytes is a Uint8Array — download it or upload to Supabase Storage
 */

// pdf-lib uses bottom-left origin (same as reportlab), but our coordinates
// were extracted in pdfplumber's top-left system. This helper converts.
// Page height = 792 (letter)
const PH = 792;
const PW = 612;
const Y = (t) => PH - t; // convert pdfplumber top-down to pdf-lib bottom-up

// Colors (RGB 0-1 from pdfplumber extraction)
const NAVY    = { r: 0.0,      g: 0.203922, b: 0.427451 };
const GREEN   = { r: 0.443137, g: 0.686275, b: 0.266667 };
const LT_BLUE = { r: 0.172549, g: 0.545098, b: 0.796078 };
const BLACK   = { r: 0, g: 0, b: 0 };
const WHITE   = { r: 1, g: 1, b: 1 };
const LGRAY   = { r: 0.75, g: 0.75, b: 0.75 };

// Margins
const ML = 35.5;
const MR = 575.5;
const PWIDTH = MR - ML; // 540
const MID = 305.0;

// All 18 inspection types with their checkbox coordinates
const INSPECTION_TYPES = [
  // Row 1 (y=254)
  { name: "Batch Plant",           x: 155, y: 254, row: 1 },
  { name: "Shotcrete",             x: 262, y: 254, row: 1 },
  { name: "Welding",               x: 355, y: 254, row: 1 },
  { name: "Epoxy",                 x: 433, y: 254, row: 1 },
  { name: "Structural Steel",      x: 498, y: 254, row: 1 },
  // Row 2 (y=264)
  { name: "Engineered Fill",       x: 38,  y: 264, row: 2 },
  { name: "Reinforced Concrete",   x: 155, y: 264, row: 2 },
  { name: "Masonry",               x: 262, y: 264, row: 2 },
  { name: "Fireproofing",          x: 355, y: 264, row: 2 },
  { name: "Firestopping",          x: 433, y: 264, row: 2 },
  { name: "Other",                 x: 498, y: 264, row: 2 },
  // Row 3 (y=274)
  { name: "Deep Foundation",       x: 38,  y: 274, row: 3 },
  { name: "Pre-Stressed Concrete", x: 155, y: 274, row: 3 },
  { name: "High Strength Bolting", x: 262, y: 274, row: 3 },
  { name: "ACI",                   x: 355, y: 274, row: 3 },
  { name: "CBI",                   x: 433, y: 274, row: 3 },
];

/**
 * Generate the Ninyo & Moore LOR PDF
 * 
 * @param {Object} report - report_data from reports table
 *   {
 *     inspection_types: string[],
 *     other_type: string,
 *     code_entries: [{code, block, notes}],
 *     weather: string,
 *     start_time: string,
 *     stop_time: string,
 *     regular_hours: number,
 *     overtime_hours: number,
 *     test_specimens: number,
 *     compliance: { work_inspected: bool, work_met_requirements: bool, material_sampling: "was"|"was_not"|"na" },
 *     photos: [{dataUrl: string, caption: string}]
 *   }
 * @param {Object} job - job record
 *   { name, site_address, field_config: { project_number, school_district, dsa_file_no, 
 *     dsa_app_no, general_contractor, building_no, lea_no, dsa_card_no, 
 *     dsa_approved_docs, section_no, client_name } }
 * @param {Object} profile - { full_name, certification_number, signature_path }
 * @param {Uint8Array} logoBytes - PNG bytes of the Ninyo & Moore logo
 * @param {Uint8Array|null} signatureBytes - PNG bytes of inspector's signature (or null)
 * @param {string} reportDate - "MM/DD/YYYY" format
 * @returns {Uint8Array} PDF bytes
 */
async function generateNMLOR(report, job, profile, logoBytes, signatureBytes, reportDate) {
  const { PDFDocument, rgb, StandardFonts } = PDFLib;
  
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
  
  // HEADER
  drawText("LOR INSPECTOR'S DAILY REPORT", 36, 36.9, 14, fontBold, NAVY);
  drawText("Inspection Date:", 36, 52.9, 9, fontBold, NAVY);
  drawText(reportDate || "", 122, 52.9, 9, font, BLACK);
  
  // Logo
  if (logoImage) {
    p1.drawImage(logoImage, { x: 445, y: Y(66.8), width: 130, height: 32.6 });
  }
  
  // Company address
  const addrX = MR;
  drawText("5710 Ruffin Road", addrX - font.widthOfTextAtSize("5710 Ruffin Road", 7), 72.4, 7, font, BLACK);
  drawText("San Diego CA 92123", addrX - font.widthOfTextAtSize("San Diego CA 92123", 7), 80.4, 7, font, BLACK);
  drawText("858.576.1000 | www.ninyoandmoore.com", addrX - font.widthOfTextAtSize("858.576.1000 | www.ninyoandmoore.com", 7), 88.4, 7, font, BLACK);
  
  // TRI-COLOR BAR
  drawRect(ML, 103, 42, 7, GREEN);
  drawRect(77.5, 103, 6, 7, NAVY);
  drawRect(83.5, 103, 24, 7, LT_BLUE);
  drawRect(110.5, 103, 465, 7, NAVY);
  
  // Navy top line
  drawLine(ML, 112, MR, 112, NAVY, 1.0);
  
  // ═══ PROJECT INFO — clean dynamic layout ═══
  const LBL = 38;       // left label x
  const VAL = 148;      // left value x (matched to RECREATION_8)
  const LMAX = MID - 15; // left column max x (word wrap boundary)
  const RLBL = MID + 5;  // right label x
  const RVAL = MID + 95; // right value x
  const RMAX = MR - 5;   // right column max x
  
  let iy = 118;
  const rowGap = 14;
  
  // Word-wrap helper: draws text within maxWidth, returns number of lines used
  const wrapText = (text, x, startY, fontSize, f, color, maxW) => {
    const clean = (text || "").replace(/[\n\r]/g, " ").trim();
    if (!clean) return 0;
    const words = clean.split(" ");
    let line = "";
    let lines = 0;
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if ((f || font).widthOfTextAtSize(test, fontSize) > maxW && line) {
        drawText(line, x, startY + (lines * (fontSize + 2)), fontSize, f, color);
        lines++;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) {
      drawText(line, x, startY + (lines * (fontSize + 2)), fontSize, f, color);
      lines++;
    }
    return lines;
  };
  
  // Row 1: Project Name / Project Number
  drawText("Project Name:", LBL, iy, 10, fontBold, BLACK);
  const nameLines = wrapText(job.name, VAL, iy, 9, font, BLACK, LMAX - VAL);
  drawText("Project Number:", RLBL, iy, 10, fontBold, BLACK);
  drawText(fc.project_number || "", RVAL, iy, 9, font, BLACK);
  iy += Math.max(nameLines * 11, rowGap) + 4;
  
  drawLine(ML, iy, MR, iy, LGRAY, 0.5);
  iy += 4;
  
  // Row 2: School District / DSA File No. + DSA App No.
  drawText("School District:", LBL, iy, 9, fontBold, BLACK);
  wrapText(fc.school_district, VAL, iy, 9, font, BLACK, LMAX - VAL);
  drawText("DSA File No.:", RLBL, iy, 9, fontBold, BLACK);
  drawText(fc.dsa_file_no || "", RVAL, iy, 9, font, BLACK);
  iy += rowGap;
  drawText("DSA App No.:", RLBL, iy, 9, fontBold, BLACK);
  drawText(fc.dsa_app_no || "", RVAL, iy, 9, font, BLACK);
  iy += rowGap - 2;
  
  drawLine(ML, iy, MR, iy, LGRAY, 0.5);
  iy += 4;
  
  // Row 3: Project Address / General Contractor + Building No.
  drawText("Project Address:", LBL, iy, 9, fontBold, BLACK);
  const addrLines = wrapText(job.site_address, VAL, iy, 9, font, BLACK, LMAX - VAL);
  drawText("General Contractor:", RLBL, iy, 9, fontBold, BLACK);
  wrapText(fc.general_contractor, RVAL, iy, 9, font, BLACK, RMAX - RVAL);
  const addrHeight = Math.max(addrLines, 1) * 11;
  iy += addrHeight + 2;
  drawText("Building No.:", RLBL, iy, 9, fontBold, BLACK);
  drawText(fc.building_no || "", RVAL, iy, 9, font, BLACK);
  iy += rowGap - 2;
  
  drawLine(ML, iy, MR, iy, LGRAY, 0.5);
  iy += 4;
  
  // Row 4: LEA / DSA Card
  drawText("LEA No.:", LBL, iy, 9, fontBold, BLACK);
  drawText(fc.lea_no || "", VAL, iy, 9, font, BLACK);
  drawText("DSA Card No.:", RLBL, iy, 9, fontBold, BLACK);
  drawText(fc.dsa_card_no || "", RVAL, iy, 9, font, BLACK);
  iy += rowGap;
  
  drawLine(ML, iy, MR, iy, LGRAY, 0.5);
  iy += 4;
  
  // Row 5: DSA Approved Docs / Section No.
  drawText("DSA Approved", LBL, iy, 8, fontBold, BLACK);
  drawText("Documents:", LBL, iy + 9, 8, fontBold, BLACK);
  drawText("Section No.:", RLBL, iy + 4, 9, fontBold, BLACK);
  drawText(fc.section_no || "", RVAL, iy + 4, 9, font, BLACK);
  
  // DSA Approved Docs value — word wrap within left column
  const dsaDocs = (fc.dsa_approved_docs || "").replace(/[\n\r]/g, " ");
  if (dsaDocs) {
    const dsaMaxW = MID - VAL - 10;
    const dsaWords = dsaDocs.split(" ");
    let dsaLine = "";
    let dsaY = iy;
    for (const word of dsaWords) {
      const test = dsaLine ? dsaLine + " " + word : word;
      if (font.widthOfTextAtSize(test, 8) > dsaMaxW && dsaLine) {
        drawText(dsaLine, VAL, dsaY, 8, font, BLACK);
        dsaY += 10;
        dsaLine = word;
      } else {
        dsaLine = test;
      }
    }
    if (dsaLine) drawText(dsaLine, VAL, dsaY, 8, font, BLACK);
  }
  iy += 22;
  
  drawLine(ML, iy, MR, iy, LGRAY, 0.5);
  iy += 2;
  
  // NAVY DIVIDER before inspection type — flows from iy
  drawRect(ML, iy, PWIDTH, 2, NAVY);
  iy += 6;
  
  // TYPE OF INSPECTION/TEST — all positions relative to iy
  drawText("TYPE OF INSPECTION/TEST:", 38, iy, 8.5, fontBold, BLACK);
  
  // Checkbox columns
  const C1=38, C2=155, C3=262, C4=355, C5=433, C6=498;
  const cbRow1Y = iy + 2;
  const cbRow2Y = cbRow1Y + 10;
  const cbRow3Y = cbRow2Y + 10;
  
  const selectedTypes = report.inspection_types || [];
  
  const drawCB = (x, cbY, name, label) => {
    p1.drawRectangle({
      x, y: Y(cbY + 7), width: 7, height: 7,
      borderColor: rgb(0, 0, 0), borderWidth: 0.5, color: rgb(1, 1, 1)
    });
    drawText(label || name, x + 9, cbY, 8, font, BLACK);
    if (selectedTypes.includes(name)) {
      const cx = x + 1.5, cy = Y(cbY + 3.5);
      p1.drawLine({ start: {x: cx, y: cy}, end: {x: cx+2, y: cy-2.5}, thickness: 1.2, color: rgb(0,0,0) });
      p1.drawLine({ start: {x: cx+2, y: cy-2.5}, end: {x: cx+5.5, y: cy+3}, thickness: 1.2, color: rgb(0,0,0) });
    }
  };
  
  // Row 1
  drawCB(C2, cbRow1Y, "Batch Plant");
  drawCB(C3, cbRow1Y, "Shotcrete");
  drawCB(C4, cbRow1Y, "Welding");
  drawCB(C5, cbRow1Y, "Epoxy");
  drawCB(C6, cbRow1Y, "Structural Steel");
  // Row 2
  drawCB(C1, cbRow2Y, "Engineered Fill");
  drawCB(C2, cbRow2Y, "Reinforced Concrete");
  drawCB(C3, cbRow2Y, "Masonry");
  drawCB(C4, cbRow2Y, "Fireproofing");
  drawCB(C5, cbRow2Y, "Firestopping");
  drawCB(C6, cbRow2Y, "Other", `Other: ${report.other_type || ""}`);
  // Row 3
  drawCB(C1, cbRow3Y, "Deep Foundation");
  drawCB(C2, cbRow3Y, "Pre-Stressed Concrete");
  drawCB(C3, cbRow3Y, "High Strength Bolting");
  drawCB(C4, cbRow3Y, "ACI");
  drawCB(C5, cbRow3Y, "CBI");
  
  iy = cbRow3Y + 14;
  
  // NAVY DIVIDER
  drawRect(ML, iy, PWIDTH, 2, NAVY);
  iy += 8;
  
  // CODE BLOCK HEADER
  drawRect(ML, iy, PWIDTH, 20, NAVY);
  drawLine(67.5, iy, 67.5, iy + 20, WHITE, 0.5);
  drawLine(107.5, iy, 107.5, iy + 20, WHITE, 0.5);
  drawText("CODE", 38.5, iy + 7, 9, fontBold, WHITE);
  drawText("BLOCK", 71.5, iy + 7, 9, fontBold, WHITE);
  drawText("DESCRIPTIONS OF WORK INSPECTED, TEST SAMPLES TAKEN, WORK REJECTED, JOB PROBLEMS, PROGRESS, REMARKS, ETC.", 185.5, iy + 4, 5, font, WHITE);
  drawText("SEPARATE REPORTS SHALL BE PREPARED FOR EACH TYPE OF INSPECTION/TEST ON A DAILY BASIS.", 216.7, iy + 11, 5, font, WHITE);
  
  const codeBlockTop = iy;
  iy += 20;
  
  // NOTES AREA — dynamic height based on content
  const codeEntries = report.code_entries || [];
  const notesFontSize = 7.8;
  const notesLineHeight = 9;
  const notesStartY = iy + 5;
  const notesColCode = ML;
  const notesColBlock = 68;
  const notesColText = 110.5;
  const notesMaxWidth = MR - notesColText - 5;
  
  let cursor = notesStartY;
  
  for (const entry of codeEntries) {
    // Code number
    if (entry.code) {
      drawText(entry.code, notesColCode + 10, cursor, 9, font, BLACK);
    }
    // Block
    if (entry.block) {
      drawText(entry.block, notesColText, cursor + 1, notesFontSize, font, BLACK);
      cursor += notesLineHeight + 8;
    }
    
    // Notes text — split on newlines first, then word wrap each paragraph
    if (entry.notes) {
      const paragraphs = entry.notes.split("\n");
      for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed) { cursor += notesLineHeight; continue; }
        const words = trimmed.split(" ");
        let line = "";
        for (const word of words) {
          const test = line ? line + " " + word : word;
          const testWidth = font.widthOfTextAtSize(test, notesFontSize);
          if (testWidth > notesMaxWidth && line) {
            drawText(line, notesColText, cursor, notesFontSize, font, BLACK);
            cursor += notesLineHeight;
            line = word;
          } else {
            line = test;
          }
        }
        if (line) {
          drawText(line, notesColText, cursor, notesFontSize, font, BLACK);
          cursor += notesLineHeight;
        }
      }
      cursor += 8; // gap between entries
    }
  }
  
  // Notes box bottom — at least y=550, or further if content is long
  const notesBottom = Math.max(550, cursor + 10);
  
  // Draw notes box border (from top of code block header to bottom of notes)
  const notesBoxTop = codeBlockTop + 20; // below the header bar
  p1.drawRectangle({
    x: ML, y: Y(notesBottom), width: PWIDTH, height: notesBottom - notesBoxTop,
    borderColor: rgb(0, 0, 0), borderWidth: 0.5
  });
  drawLine(67.5, notesBoxTop, 67.5, notesBottom, BLACK, 0.5);
  drawLine(107.5, notesBoxTop, 107.5, notesBottom, BLACK, 0.5);
  
  // Everything below floats based on notesBottom
  let fy = notesBottom + 3; // float Y cursor
  
  // WEATHER
  p1.drawRectangle({
    x: 36, y: Y(fy + 12), width: 540, height: 12,
    borderColor: rgb(0, 0, 0), borderWidth: 0.5
  });
  drawText("Weather:", 38, fy, 9, fontBold, BLACK);
  drawText(report.weather || "", 90, fy, 8.5, font, BLACK);
  fy += 15;
  
  // SIGNATURES BANNER
  drawRect(36, fy, 540, 12, NAVY);
  drawText("SIGNATURES", 38, fy + 2, 8, fontBold, WHITE);
  fy += 15;
  
  // TIME TABLE
  const tableTop = fy;
  const tableHeaderH = 18;
  const tableDataH = 22;
  
  // Horizontal lines
  drawLine(36, fy, 576, fy, BLACK, 0.5);
  drawLine(36, fy + tableHeaderH, 302, fy + tableHeaderH, BLACK, 0.5);
  drawLine(36, fy + tableHeaderH + tableDataH, 576, fy + tableHeaderH + tableDataH, BLACK, 0.5);
  
  // Vertical lines
  for (const x of [36, 90, 144, 198, 252, 302, 576]) {
    drawLine(x, fy, x, fy + tableHeaderH + tableDataH, BLACK, 0.5);
  }
  
  // Column headers
  drawText("Start Time", 47, fy + 4, 7, font, BLACK);
  drawText("Stop Time", 101, fy + 4, 7, font, BLACK);
  drawText("Regular Hours", 148, fy + 4, 7, font, BLACK);
  drawText("Overtime Hours", 200, fy + 4, 7, font, BLACK);
  drawText("No. of Test", 260, fy + 1, 7, font, BLACK);
  drawText("Specimens", 260, fy + 9, 7, font, BLACK);
  
  // Time values
  const dataY = fy + tableHeaderH + 6;
  drawText(report.start_time || "", 52, dataY, 9, font, BLACK);
  drawText(report.stop_time || "", 106, dataY, 9, font, BLACK);
  drawText(String(report.regular_hours ?? ""), 168, dataY, 9, font, BLACK);
  drawText(String(report.overtime_hours ?? "-"), 224, dataY, 9, font, BLACK);
  drawText(String(report.test_specimens ?? "0"), 274, dataY, 9, font, BLACK);
  
  // Inspector name (Print)
  drawText(`${profile.full_name || ""} (Print)`, 388, fy + 5, 9, font, BLACK);
  
  fy += tableHeaderH + tableDataH + 5;
  
  // CODE LEGEND
  drawText("CODE:", 65, fy, 7, fontBold, BLACK);
  drawText("RW = Rework  NIC = Not In Contract  ST = Standby", 93, fy, 7, font, BLACK);
  drawText("WC = Work Cancelled    Code - (No. of hours)", 84, fy + 9, 7, font, BLACK);
  
  // Signature of Inspector
  drawText("Signature of Inspector", 416, fy, 7, font, BLACK);
  
  // Signature image
  if (sigImage) {
    p1.drawImage(sigImage, { x: 380, y: Y(fy + 35), width: 140, height: 30 });
  }
  
  // Date / Cert
  drawText(reportDate || "", 335, fy + 20, 7, font, BLACK);
  drawText(profile.certification_number || "", 470, fy + 20, 7, font, BLACK);
  drawText("Date", 353, fy + 28, 7, font, BLACK);
  drawText("Certification Number", 468, fy + 28, 7, font, BLACK);
  
  fy += 32;
  
  // COMPLIANCE CHECKBOXES
  const comp = report.compliance || {};
  
  drawText("THE WORK", 36, fy, 8, fontBold, BLACK);
  drawText("was /     was not inspected in accordance with the", 97, fy, 8, font, BLACK);
  drawText("approved documents", 36, fy + 11, 8, font, BLACK);
  
  // Checkboxes
  p1.drawRectangle({ x: 87, y: Y(fy + 8), width: 8, height: 8, borderColor: rgb(0,0,0), borderWidth: 0.5, color: rgb(1,1,1) });
  p1.drawRectangle({ x: 120, y: Y(fy + 8), width: 8, height: 8, borderColor: rgb(0,0,0), borderWidth: 0.5, color: rgb(1,1,1) });
  if (comp.work_inspected === true) { const cx=88.5,cy=Y(fy+4.5); p1.drawLine({start:{x:cx,y:cy},end:{x:cx+2,y:cy-2.5},thickness:1.2,color:rgb(0,0,0)}); p1.drawLine({start:{x:cx+2,y:cy-2.5},end:{x:cx+5.5,y:cy+3},thickness:1.2,color:rgb(0,0,0)}); }
  if (comp.work_inspected === false) { const cx=121.5,cy=Y(fy+4.5); p1.drawLine({start:{x:cx,y:cy},end:{x:cx+2,y:cy-2.5},thickness:1.2,color:rgb(0,0,0)}); p1.drawLine({start:{x:cx+2,y:cy-2.5},end:{x:cx+5.5,y:cy+3},thickness:1.2,color:rgb(0,0,0)}); }
  
  fy += 22;
  
  drawText("THE WORK INSPECTED", 36, fy, 8, fontBold, BLACK);
  drawText("met /     did not meet the requirements", 151, fy, 8, font, BLACK);
  drawText("of the approved documents", 36, fy + 11, 8, font, BLACK);
  
  p1.drawRectangle({ x: 141, y: Y(fy + 8), width: 8, height: 8, borderColor: rgb(0,0,0), borderWidth: 0.5, color: rgb(1,1,1) });
  p1.drawRectangle({ x: 173, y: Y(fy + 8), width: 8, height: 8, borderColor: rgb(0,0,0), borderWidth: 0.5, color: rgb(1,1,1) });
  if (comp.work_met_requirements === true) { const cx=142.5,cy=Y(fy+4.5); p1.drawLine({start:{x:cx,y:cy},end:{x:cx+2,y:cy-2.5},thickness:1.2,color:rgb(0,0,0)}); p1.drawLine({start:{x:cx+2,y:cy-2.5},end:{x:cx+5.5,y:cy+3},thickness:1.2,color:rgb(0,0,0)}); }
  if (comp.work_met_requirements === false) { const cx=174.5,cy=Y(fy+4.5); p1.drawLine({start:{x:cx,y:cy},end:{x:cx+2,y:cy-2.5},thickness:1.2,color:rgb(0,0,0)}); p1.drawLine({start:{x:cx+2,y:cy-2.5},end:{x:cx+5.5,y:cy+3},thickness:1.2,color:rgb(0,0,0)}); }
  
  // JOB SITE CONTACT text
  drawText("JOB SITE CONTACT IS ASKED TO SIGN TO VERIFY INSPECTION HOURS ONLY THE", 310, fy - 16, 5.5, font, BLACK);
  drawText("CONTENT OF THIS REPORT & FEE CHARGES ARE THE RESPONSIBILITY OF OTHERS", 305, fy - 9, 5.5, font, BLACK);
  drawText("Signature of Owner-Authorized Job Site Contact", 375, fy + 10, 7, font, BLACK);
  
  fy += 22;
  
  // MATERIAL SAMPLING
  drawText("MATERIAL SAMPLING", 36, fy, 8, fontBold, BLACK);
  drawText("was      was not      N/A  performed in", 144, fy, 8, font, BLACK);
  drawText("accordance with the approved documents", 36, fy + 11, 8, font, BLACK);
  
  p1.drawRectangle({ x: 134, y: Y(fy + 8), width: 8, height: 8, borderColor: rgb(0,0,0), borderWidth: 0.5, color: rgb(1,1,1) });
  p1.drawRectangle({ x: 163, y: Y(fy + 8), width: 8, height: 8, borderColor: rgb(0,0,0), borderWidth: 0.5, color: rgb(1,1,1) });
  p1.drawRectangle({ x: 207, y: Y(fy + 8), width: 8, height: 8, borderColor: rgb(0,0,0), borderWidth: 0.5, color: rgb(1,1,1) });
  
  if (comp.material_sampling === "was") { const cx=135.5,cy=Y(fy+4.5); p1.drawLine({start:{x:cx,y:cy},end:{x:cx+2,y:cy-2.5},thickness:1.2,color:rgb(0,0,0)}); p1.drawLine({start:{x:cx+2,y:cy-2.5},end:{x:cx+5.5,y:cy+3},thickness:1.2,color:rgb(0,0,0)}); }
  if (comp.material_sampling === "was_not") { const cx=164.5,cy=Y(fy+4.5); p1.drawLine({start:{x:cx,y:cy},end:{x:cx+2,y:cy-2.5},thickness:1.2,color:rgb(0,0,0)}); p1.drawLine({start:{x:cx+2,y:cy-2.5},end:{x:cx+5.5,y:cy+3},thickness:1.2,color:rgb(0,0,0)}); }
  if (comp.material_sampling === "na") { const cx=208.5,cy=Y(fy+4.5); p1.drawLine({start:{x:cx,y:cy},end:{x:cx+2,y:cy-2.5},thickness:1.2,color:rgb(0,0,0)}); p1.drawLine({start:{x:cx+2,y:cy-2.5},end:{x:cx+5.5,y:cy+3},thickness:1.2,color:rgb(0,0,0)}); }
  
  fy += 25;
  
  // DISTRIBUTION
  drawText("Distribution: DSA Regional Office, Project Architect, Structural Engineer, Project Inspector, Contractor", 36, fy, 6.5, font, BLACK);
  // ═══ CALCULATE TOTAL PAGES BEFORE RENDERING ═══
  // We need total page count for "Page X of Y" but we build pages sequentially.
  // Strategy: build all pages, then go back and stamp page numbers at the end.
  
  const photos = report.photos || [];
  const attachmentPdfs = report.attachmentPdfs || []; // array of Uint8Array
  
  // Photo pages: 4 photos per page, minimum 1 photo page
  const photoPageCount = Math.max(1, Math.ceil(photos.length / 4));
  
  // We'll count attachment pages after loading them
  let attachmentPageCount = 0;
  const attachmentDocs = [];
  for (const pdfBytes of attachmentPdfs) {
    const extDoc = await PDFDocument.load(pdfBytes);
    attachmentDocs.push(extDoc);
    attachmentPageCount += extDoc.getPageCount();
  }
  
  const totalPages = 1 + photoPageCount + attachmentPageCount;
  
  // Stamp Page 1 footer with correct total
  const p1PageText = `Page 1 of ${totalPages}`;
  drawText(p1PageText, MR - font.widthOfTextAtSize(p1PageText, 6.5), fy, 6.5, font, BLACK);
  
  fy += 12;
  
  const disclaimer = "This report is related only to the above stated samples, specimens, or conditions tested by Ninyo and Moore and are not to be reproduced without Ninyo and Moore authorization.";
  drawText(disclaimer, 35, fy, 5.5, font, BLACK);
  const printDateText = `Print Date ${reportDate || ""}`;
  drawText(printDateText, MR - font.widthOfTextAtSize(printDateText, 5.5), fy, 5.5, font, BLACK);
  
  
  // ═══ HELPER: Draw photo page header ═══
  const drawPhotoPageHeader = (page, pageNum) => {
    const dpText = (text, x, yt, size, f, color) => {
      if (!text) return;
      const clean = String(text).replace(/[\n\r]/g, " ");
      page.drawText(clean, { x, y: Y(yt + size), size, font: f || font, color: rgb(color?.r ?? 0, color?.g ?? 0, color?.b ?? 0) });
    };
    const dpRect = (x, yt, w, h, color) => {
      page.drawRectangle({ x, y: Y(yt + h), width: w, height: h, color: rgb(color.r, color.g, color.b) });
    };
    
    // Header
    dpText("LOR INSPECTOR'S DAILY REPORT", 38, 56.9, 14, fontBold, NAVY);
    if (logoImage) {
      page.drawImage(logoImage, { x: 445, y: Y(66.8), width: 130, height: 32.6 });
    }
    
    // Tri-color bar
    dpRect(ML, 76, 42, 7, GREEN);
    dpRect(77.5, 76, 6, 7, NAVY);
    dpRect(83.5, 76, 24, 7, LT_BLUE);
    dpRect(110.5, 76, 465, 7, NAVY);
    
    // Project info
    dpText("Inspection Date:", 38, 83.7, 8, fontBold, BLACK);
    dpText(reportDate || "", 110, 83.7, 8, font, BLACK);
    dpText("Client:", 308, 83.7, 8, fontBold, BLACK);
    dpText(fc.client_name || fc.school_district || "", 385, 83.7, 8, font, BLACK);
    dpText("Project Name:", 38, 95.7, 8, fontBold, BLACK);
    const pName = (job.name || "").split("\n").join(" ");
    dpText(pName, 110, 95.7, 8, font, BLACK);
    const pnEndX = 110 + font.widthOfTextAtSize(pName, 8) + 12;
    const pnLblX = Math.max(pnEndX, 380);
    dpText("Project Number:", pnLblX, 95.7, 8, fontBold, BLACK);
    dpText(fc.project_number || "", pnLblX + fontBold.widthOfTextAtSize("Project Number:", 8) + 6, 95.7, 8, font, BLACK);
    
    // Thin navy line
    dpRect(ML, 118, PWIDTH, 2, NAVY);
    
    // LOR INSPECTION PICTURES banner
    dpRect(ML, 122, PWIDTH, 16, NAVY);
    dpText("LOR INSPECTION PICTURES", 40, 127, 10, fontBold, WHITE);
    
    // Footer
    const pgText = `Page ${pageNum} of ${totalPages}`;
    dpText(pgText, MR - font.widthOfTextAtSize(pgText, 7), 738.8, 7, font, BLACK);
    dpText(disclaimer, 35, 750.6, 5.5, font, BLACK);
    const pdText = `Print Date ${reportDate || ""}`;
    dpText(pdText, MR - font.widthOfTextAtSize(pdText, 5.5), 750.6, 5.5, font, BLACK);
    
    return dpText; // return for caption use
  };
  
  // ═══ HELPER: Embed a single photo onto a page ═══
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
  
  // Photo positions on each photo page (4 per page, 2x2 grid)
  const photoSlots = [
    { x: ML, y: 145, w: 264, h: 180 },       // top left
    { x: 307.5, y: 145, w: 264, h: 180 },     // top right
    { x: ML, y: 345, w: 264, h: 180 },        // bottom left
    { x: 307.5, y: 345, w: 264, h: 180 },     // bottom right
  ];
  
  // Recalculate photo page count with 4 per page
  const photosPerPage = 4;
  const actualPhotoPageCount = Math.max(1, Math.ceil(photos.length / photosPerPage));
  // Update totalPages (we already calculated it above with photoPageCount, need to reconcile)
  
  // ═══ BUILD PHOTO PAGES ═══
  for (let pp = 0; pp < actualPhotoPageCount; pp++) {
    const page = pdfDoc.addPage([PW, PH]);
    const pageNum = 2 + pp;
    drawPhotoPageHeader(page, pageNum);
    
    // Place up to 4 photos on this page
    for (let slot = 0; slot < photosPerPage; slot++) {
      const photoIdx = pp * photosPerPage + slot;
      if (photoIdx < photos.length) {
        await embedPhoto(page, photos[photoIdx], photoSlots[slot]);
      }
    }
  }
  
  // ═══ APPEND ATTACHED PDFs ═══
  for (const extDoc of attachmentDocs) {
    const copiedPages = await pdfDoc.copyPages(extDoc, extDoc.getPageIndices());
    for (const copiedPage of copiedPages) {
      pdfDoc.addPage(copiedPage);
    }
  }
  
  // Generate bytes
  return await pdfDoc.save();
}

// Export for use in the app
window.generateNMLOR = generateNMLOR;
