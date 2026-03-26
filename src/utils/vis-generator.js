/**
 * VIS (Vital Inspection Services) Daily Report — PDF Generator
 * Built with pdf-lib, runs 100% client-side.
 * Coordinates from VIS_template.pdf via pdfplumber.
 * Page: 612 x 792 (Letter)
 */

import { ensurePdfLib } from './pdf.js';

const VIS_PH = 792, VIS_PW = 612;
const VY = (t) => VIS_PH - t;

/**
 * Generate the VIS Inspector's Daily Report PDF
 *
 * @param {Object} reportData - { vals: { field_key: value }, photos: [{ imageBytes, caption }] }
 * @param {Object} job - job record
 * @param {Object} profile - { full_name }
 * @param {Uint8Array} logoBytes - PNG bytes of the VIS logo (or null)
 * @param {Uint8Array|null} signatureBytes - PNG bytes of inspector's signature (or null)
 * @param {string} reportDate - "MM/DD/YYYY" format
 * @returns {Uint8Array} PDF bytes
 */
export async function generateVIS(reportData, job, profile, logoBytes, signatureBytes, reportDate) {
  const { PDFDocument, rgb, StandardFonts } = await ensurePdfLib();

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await doc.embedFont(StandardFonts.TimesRomanBold);

  let logoImage = null;
  if (logoBytes) {
    try { logoImage = await doc.embedPng(logoBytes); } catch(e) {
      try { logoImage = await doc.embedJpg(logoBytes); } catch(e2) {}
    }
  }
  let sigImage = null;
  if (signatureBytes) {
    try { sigImage = await doc.embedPng(signatureBytes); } catch(e) {
      try { sigImage = await doc.embedJpg(signatureBytes); } catch(e2) {}
    }
  }

  // ── Map reportData.vals to the VIS field names via fuzzy matching ──
  const vals = reportData.vals || {};
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

  const r = {
    date_str:             reportDate || "",
    project_name:         getValue(["project_name", "project name"]) || job.name || "",
    project_no:           getValue(["project_no", "project number", "project #"]),
    jurisdiction:         getValue(["jurisdiction"]),
    dsa_app:              getValue(["dsa_app", "dsa app"]),
    dsa_file:             getValue(["dsa_file", "dsa file"]),
    ior:                  getValue(["ior"]),
    project_manager:      getValue(["project_manager", "project manager"]),
    architect:            getValue(["architect"]),
    contractor:           getValue(["contractor"]),
    correction_notices:   getValue(["correction_notice", "correction"]),
    observation_letters:  getValue(["observation_letter", "observation"]),
    irs_received:         getValue(["ir", "irs_received", "irs received"]),
    contractor_activity:  getValue(["contractor_activity", "contractor activity"]),
    ior_notes:            getValue(["ior_notes", "ior notes", "notes", "observations", "comments"]),
    inspector_name:       profile.full_name || "",
  };

  const BLK = { r:0, g:0, b:0 };
  const photos = reportData.photos || [];

  // ── Calculate total pages for footer ──
  const photoPageCount = photos.length > 0 ? Math.ceil(photos.length / 4) : 0;
  const totalPages = 1 + photoPageCount;

  // ═══════════════ PAGE 1 ═══════════════
  const p = doc.addPage([VIS_PW, VIS_PH]);

  const dT = (text, x, yt, sz, f, color) => {
    if (!text) return;
    p.drawText(String(text).replace(/[\n\r]/g," "), { x, y: VY(yt+sz), size: sz, font: f||font, color: rgb(color?.r??0, color?.g??0, color?.b??0) });
  };
  const dR = (x, yt, w, h) => {
    p.drawRectangle({ x, y: VY(yt+h), width: w, height: h, borderColor: rgb(0,0,0), borderWidth: 0.5 });
  };
  const dL = (x1, yt1, x2, yt2, lw) => {
    p.drawLine({ start:{x:x1,y:VY(yt1)}, end:{x:x2,y:VY(yt2)}, thickness: lw||0.5, color: rgb(0,0,0) });
  };

  // Logo
  if (logoImage) {
    p.drawImage(logoImage, { x: 36.34, y: VY(77.76), width: 128.2, height: 55.44 });
  }

  // Title bar
  dR(36, 85.76, 540, 26);
  dT("2026 Project Inspector\u2019s Daily Report", 185.3, 93.9, 14, fontBold, BLK);

  // Row heights and positions from extraction
  const LM = 36, RM = 576, MID = 256.03, RH = 20;
  const rows = [
    { y: 111.76, h: RH, left: "Date:", leftVal: r.date_str, right: "Project Name:", rightVal: r.project_name },
    { y: 131.76, h: RH, left: "Project No:", leftVal: r.project_no, right: "Jurisdiction:", rightVal: r.jurisdiction },
    { y: 151.76, h: RH, left: "DSA App:", leftVal: r.dsa_app, right: "DSA File #:", rightVal: r.dsa_file },
    { y: 171.76, h: RH, left: "IOR:", leftVal: r.ior, right: "Project Manager:", rightVal: r.project_manager },
    { y: 191.76, h: RH, left: "Architect:", leftVal: r.architect, right: "Contractor:", rightVal: r.contractor },
    { y: 211.76, h: RH, left: "Correction Notices Issued:", leftVal: r.correction_notices, right: "Observation Letters Issued:", rightVal: r.observation_letters },
  ];

  for (const row of rows) {
    dR(LM, row.y, 540, row.h);
    dL(MID, row.y, MID, row.y + row.h, 0.5);
    dT(row.left, 39, row.y + 6, 10, font, BLK);
    if (row.leftVal) {
      const lblW = font.widthOfTextAtSize(row.left, 10) + 4;
      dT(row.leftVal, 39 + lblW, row.y + 6, 10, font, BLK);
    }
    dT(row.right, 259, row.y + 6, 10, font, BLK);
    if (row.rightVal) {
      const rLblW = font.widthOfTextAtSize(row.right, 10) + 4;
      dT(row.rightVal, 259 + rLblW, row.y + 6, 10, font, BLK);
    }
  }

  // IR's Received or Reviewed (full width)
  dR(LM, 237.76, 540, 20);
  dT("IR\u2019s Received or Reviewed:", 39, 244, 10, font, BLK);
  if (r.irs_received) {
    const irLblW = font.widthOfTextAtSize("IR\u2019s Received or Reviewed:", 10) + 4;
    dT(r.irs_received, 39 + irLblW, 244, 10, font, BLK);
  }

  // Contractor Activity (bold label, full width)
  dR(LM, 259.76, 540, 22);
  dT("Contractor Activity", 39, 267, 10, fontBold, BLK);
  if (r.contractor_activity) {
    const caLblW = fontBold.widthOfTextAtSize("Contractor Activity", 10) + 8;
    dT(r.contractor_activity, 39 + caLblW, 267, 10, font, BLK);
  }

  // IOR Notes label
  dT("IOR Notes:", 39, 291, 10, fontBold, BLK);

  // IOR Notes box (large)
  dR(LM, 303.76, 540, 372.24);

  // IOR Notes text — word wrap inside the box
  const notesText = r.ior_notes || "";
  const notesFontSize = 10;
  const notesLineH = 14;
  const notesMaxW = 530;
  const notesX = 42;
  let notesY = 312;

  const paragraphs = notesText.split("\n");
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) { notesY += notesLineH; continue; }
    const words = trimmed.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(test, notesFontSize) > notesMaxW && line) {
        dT(line, notesX, notesY, notesFontSize, font, BLK);
        notesY += notesLineH;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) {
      dT(line, notesX, notesY, notesFontSize, font, BLK);
      notesY += notesLineH;
    }
  }

  // Signature area
  dT("x", 36, 700.2, 10, font, BLK);
  dL(44, 710, 216, 710, 0.75);

  // Signature image
  if (sigImage) {
    p.drawImage(sigImage, { x: 50, y: VY(708), width: 160, height: 30 });
  }

  dT("Project Inspector:", 38, 716.2, 10, font, BLK);
  if (r.inspector_name) {
    dT(r.inspector_name, 116, 716.2, 10, font, BLK);
  }

  // Footer
  dT("5505 E. Santa Ana Canyon Rd. #18771 Anaheim, CA  92817", 183.1, 738.2, 10, font, BLK);
  dT("Office/ Fax \u2013 888.613.7227 | vinspection.net", 216.7, 752.2, 10, font, BLK);

  // Page number on page 1
  if (totalPages > 1) {
    const pgText = `Page 1 of ${totalPages}`;
    dT(pgText, RM - font.widthOfTextAtSize(pgText, 7), 760, 7, font, BLK);
  }

  // ═══════════════ PHOTO PAGES ═══════════════
  if (photos.length > 0) {
    const photoSlots = [
      { x: 50, y: 160, w: 250, h: 200 },    // top left
      { x: 312, y: 160, w: 250, h: 200 },   // top right
      { x: 50, y: 400, w: 250, h: 200 },    // bottom left
      { x: 312, y: 400, w: 250, h: 200 },   // bottom right
    ];

    for (let pp = 0; pp < photoPageCount; pp++) {
      const page = doc.addPage([VIS_PW, VIS_PH]);
      const pageNum = 2 + pp;

      // Photo page header
      if (logoImage) {
        page.drawImage(logoImage, { x: 36.34, y: VY(77.76), width: 128.2, height: 55.44 });
      }
      page.drawRectangle({ x: 36, y: VY(85.76 + 26), width: 540, height: 26, borderColor: rgb(0,0,0), borderWidth: 0.5 });
      page.drawText("Site Photos", { x: 250, y: VY(93.9 + 14), size: 14, font: fontBold, color: rgb(0,0,0) });

      // Project info line
      page.drawText(`${r.project_name}  |  ${r.date_str}`, { x: 39, y: VY(125 + 10), size: 10, font, color: rgb(0,0,0) });

      // Place up to 4 photos per page
      for (let slot = 0; slot < 4; slot++) {
        const photoIdx = pp * 4 + slot;
        if (photoIdx >= photos.length) break;
        const photo = photos[photoIdx];
        if (!photo.imageBytes) continue;

        const pos = photoSlots[slot];
        let img;
        try {
          if (photo.imageBytes[0] === 0x89 && photo.imageBytes[1] === 0x50) {
            img = await doc.embedPng(photo.imageBytes);
          } else {
            img = await doc.embedJpg(photo.imageBytes);
          }
        } catch(e) { continue; }

        const scale = Math.min(pos.w / img.width, pos.h / img.height);
        const scaledW = img.width * scale;
        const scaledH = img.height * scale;
        const offsetX = pos.x + (pos.w - scaledW) / 2;
        const offsetY = VY(pos.y + pos.h) + (pos.h - scaledH) / 2;
        page.drawImage(img, { x: offsetX, y: offsetY, width: scaledW, height: scaledH });

        if (photo.caption) {
          const capWidth = font.widthOfTextAtSize(photo.caption, 9);
          const capX = pos.x + (pos.w - capWidth) / 2;
          const clean = String(photo.caption).replace(/[\n\r]/g, " ");
          page.drawText(clean, { x: capX, y: VY(pos.y + pos.h + 8 + 9), size: 9, font, color: rgb(0,0,0) });
        }
      }

      // Photo page footer
      const pgText = `Page ${pageNum} of ${totalPages}`;
      page.drawText(pgText, { x: RM - font.widthOfTextAtSize(pgText, 7), y: VY(760 + 7), size: 7, font, color: rgb(0,0,0) });
    }
  }

  return await doc.save();
}
