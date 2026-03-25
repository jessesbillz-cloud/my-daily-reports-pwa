import { ensurePdfLib } from './pdf'

/* ── Fuzzy field matching (same pattern as ReportEditor) ── */
const wordMatch = (fn, kw) => new RegExp("(^|[\\s_\\-\\.:#])" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(fn)
function findVal(vals, ...keys) { if (!vals) return ""; for (const k of keys) for (const [fn, fv] of Object.entries(vals)) if (wordMatch(fn, k)) return fv; return "" }
function findVal2(vals, a, b) { if (!vals) return ""; for (const [fn, fv] of Object.entries(vals)) if (wordMatch(fn, a) && wordMatch(fn, b)) return fv; return "" }
function parseHours(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n }

/*
 * ════════════════════════════════════════════════════════════════════════
 *  TYR Consultant Time Card PDF — Template Overlay
 * ════════════════════════════════════════════════════════════════════════
 *  Loads public/tyr-timecard-template.pdf (the ACTUAL TYR template with
 *  logo, grid, formatting) and overlays variable data on top.
 *
 *  ALL coordinates below come from pdfplumber extraction of the real
 *  template — nothing is guessed.
 *
 *  Template page: 792 × 612  (landscape)
 *  pdfplumber coordinate system: top-left origin, y increases downward
 *  pdf-lib coordinate system:    bottom-left origin, y increases upward
 *
 *  Conversion helpers:
 *    rectY(top, h)     → pdf-lib y for a rectangle at pdfplumber top
 *    baseline(top, sz) → pdf-lib y for text baseline at pdfplumber top
 * ════════════════════════════════════════════════════════════════════════
 *
 *  ┌──────────────────── TEMPLATE STRUCTURE ────────────────────┐
 *  │  Logo + Title + Address         (static — don't touch)     │
 *  │                                                            │
 *  │  INFO BOX  (horizontal lines on left at y = 131.7, 143.7, │
 *  │            155.7, 167.7, 179.7, 191.7; right at 131.7,    │
 *  │            155.7, 179.7; verticals at x=103.5, 549.9)     │
 *  │                                                            │
 *  │  Left labels (STATIC):                                     │
 *  │    "Company Name"    x=292.1  top=122.3                    │
 *  │    "Insepctors Name" x=283.5  top=146.3                    │
 *  │    "Position"        x=303.7  top=170.3                    │
 *  │  Left VALUES (OVERLAY):                                    │
 *  │    Company   x=246.0  top=134.3  (row 131.7–143.7)        │
 *  │    Inspector x=286.4  top=158.3  (row 155.7–167.7)        │
 *  │    Position  x=272.0  top=182.3  (row 179.7–191.7)        │
 *  │                                                            │
 *  │  Right labels (STATIC):                                    │
 *  │    "WeekEnding Date:" x=554.0  top=122.3                   │
 *  │    "Project Number:"  x=559.8  top=146.3                   │
 *  │    "Client Name:"     x=577.1  top=170.3                   │
 *  │  Right VALUES (OVERLAY):                                   │
 *  │    WE Date   x=676.3  top=122.8                            │
 *  │    Proj#     x=677.5  top=146.3                            │
 *  │    Client    x=657.4  top=170.3                            │
 *  │                                                            │
 *  │  DATA TABLE                                                │
 *  │    Grey header row: 203.7–215.7  "Date" "Day" (static)    │
 *  │    Column x boundaries:                                    │
 *  │      50.1  103.5  158.7  446.1  506.7  549.9              │
 *  │      610.5  648.3  691.5  741.3                            │
 *  │    Day names in grey col 103.5–158.7 (STATIC)              │
 *  │    Row horiz lines: 215.7 227.7 239.7 251.7 263.7         │
 *  │                     275.7 287.7 ~300                       │
 *  │    Text positions per row (from template):                 │
 *  │      dates  8.8pt Helv   top ≈ rowLine + 3.1              │
 *  │      days   9.6pt HelvB  top ≈ rowLine + 2.6              │
 *  │      data   9.6pt Helv   top ≈ rowLine + 2.6              │
 *  │                                                            │
 *  │  TOTALS ROW: ~300–313                                      │
 *  │    "Total Hrs" x=78.5 top=303.5 (grey bg, STATIC)         │
 *  │    Hours values in white area x=550.2–741.6               │
 *  │                                                            │
 *  │  SIGNATURE:                                                │
 *  │    Name x=310.6 top=340.4  |  Date x=625.1 top=341.3     │
 *  │    Signature line at y=350.7                               │
 *  └────────────────────────────────────────────────────────────┘
 */

export async function generateTimeCardPDF({ job, user, reports, weekEndingDate, mondayDate }) {
  const PDFLib = await ensurePdfLib()
  const { PDFDocument, rgb, StandardFonts } = PDFLib

  // ── Load the actual TYR template ──
  const basePath = (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/"
  const tplResp = await fetch(basePath + "tyr-timecard-template.pdf")
  if (!tplResp.ok) throw new Error("Could not load time card template")
  const pdfDoc = await PDFDocument.load(await tplResp.arrayBuffer(), { ignoreEncryption: true })
  const page = pdfDoc.getPages()[0]

  // Fonts
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const helvB = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const courier = await pdfDoc.embedFont(StandardFonts.Courier)

  const PH = 612
  const black = rgb(0, 0, 0)
  const white = rgb(1, 1, 1)

  // ── Coordinate helpers ──
  // White rect: pdfplumber (top, height) → pdf-lib bottom-left (x, y, w, h)
  const wr = (x, top, w, h) => page.drawRectangle({ x, y: PH - top - h, width: w, height: h, color: white })
  // Text baseline: pdfplumber top → pdf-lib y (baseline ≈ top + ascender)
  const bl = (top, sz) => PH - top - sz * 0.72

  // ════════════════════════════════════════════════════════════
  //  1. WHITE OUT sample values (preserve labels & grid lines)
  // ════════════════════════════════════════════════════════════

  // ── Info box LEFT values (between verticals x=103.5 and x=549.9) ──
  // Company Name value row (131.7 → 143.7), inset from grid lines
  wr(104, 132.2, 445, 11)
  // Inspector Name value row (155.7 → 167.7)
  wr(104, 156.2, 445, 11)
  // Position value row (179.7 → 191.7)
  wr(104, 180.2, 445, 11)

  // ── Info box RIGHT values (x ≈ 650–741) ──
  // WeekEnding Date value  (in row above 131.7, value at x=676 top=122.8)
  wr(674, 121, 66, 11.5)
  // Project Number value   (row 131.7–155.7, value at x=677 top=146.3)
  wr(674, 144, 66, 12)
  // Client Name value      (row 155.7–179.7, value at x=657 top=170.3)
  wr(655, 169, 86, 11.5)

  // ── Data table cells (skip Day column = grey bg with static Mon–Sun) ──
  // Column x boundaries from template lines
  const colX = [50.1, 103.5, 158.7, 446.1, 506.7, 549.9, 610.5, 648.3, 691.5, 741.3]
  // Row-dividing horizontal lines
  const rowLines = [215.7, 227.7, 239.7, 251.7, 263.7, 275.7, 287.7, 300.3]

  for (let r = 0; r < 7; r++) {
    const top = rowLines[r] + 0.4
    const h = (rowLines[r + 1] || 300.3) - rowLines[r] - 0.8
    // Date column (col 0: 50.1–103.5)
    wr(colX[0] + 0.5, top, colX[1] - colX[0] - 1, h)
    // Skip Day column (col 1: 103.5–158.7) — grey bg + static day names
    // Project desc (col 2: 158.7–446.1)
    wr(colX[2] + 0.5, top, colX[3] - colX[2] - 1, h)
    // DSA (col 3: 446.1–506.7)
    wr(colX[3] + 0.5, top, colX[4] - colX[3] - 1, h)
    // Gap column (col 4: 506.7–549.9)
    wr(colX[4] + 0.5, top, colX[5] - colX[4] - 1, h)
    // Reg hours (col 5: 549.9–610.5)
    wr(colX[5] + 0.5, top, colX[6] - colX[5] - 1, h)
    // OT hours (col 6: 610.5–648.3)
    wr(colX[6] + 0.5, top, colX[7] - colX[6] - 1, h)
    // DT hours (col 7: 648.3–691.5)
    wr(colX[7] + 0.5, top, colX[8] - colX[7] - 1, h)
    // 4th column (col 8: 691.5–741.3)
    wr(colX[8] + 0.5, top, colX[9] - colX[8] - 1, h)
  }

  // ── Totals row hours (white area x=550.2–741.6, y≈300.6–313.2) ──
  wr(550.5, 301, 190, 11.5)

  // ── Signature name + date (above line at y=350.7) ──
  wr(160, 338, 530, 13)

  // ════════════════════════════════════════════════════════════
  //  2. OVERLAY: Info box values
  // ════════════════════════════════════════════════════════════
  const userName = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "Inspector"
  const weekEnd = new Date(weekEndingDate + "T12:00:00")
  const weStr = (weekEnd.getMonth() + 1) + "/" + weekEnd.getDate() + "/" + String(weekEnd.getFullYear()).slice(2)

  // Left values — centered in the row (x=103.5 to 549.9, midpoint ~326)
  const centerText = (text, top, font, sz) => {
    const w = font.widthOfTextAtSize(text, sz)
    const mid = (103.5 + 549.9) / 2
    page.drawText(text, { x: mid - w / 2, y: bl(top, sz), size: sz, font, color: black })
  }
  centerText(job.timecard_company_name || "", 134.3, courier, 9.6)
  centerText(userName, 158.3, courier, 9.6)
  centerText(job.timecard_position || "Inspector Of Record", 182.3, courier, 9.6)

  // Right values — positioned at exact pdfplumber x
  page.drawText(weStr, { x: 676.3, y: bl(122.8, 9.6), size: 9.6, font: courier, color: black })
  page.drawText(job.timecard_project_number || "", { x: 677.5, y: bl(146.3, 9.6), size: 9.6, font: courier, color: black })
  page.drawText(job.timecard_client_name || "", { x: 657.4, y: bl(170.3, 9.6), size: 9.6, font: courier, color: black })

  // ════════════════════════════════════════════════════════════
  //  3. OVERLAY: Data table rows (Mon–Sun)
  // ════════════════════════════════════════════════════════════
  const reportsByDate = {}
  reports.forEach(r => {
    if (!reportsByDate[r.report_date] || r.id > reportsByDate[r.report_date].id)
      reportsByDate[r.report_date] = r
  })

  // Text top offsets within each row (from pdfplumber measurements)
  // Dates: row_line + 3.1px at 8.8pt Helvetica
  // Day names: row_line + 2.6px at 9.6pt Helvetica-Bold (STATIC — already in template)
  // Data: row_line + 2.6px at 9.6pt Helvetica
  const dateTextTops = [218.8, 230.8, 242.8, 254.8, 266.8, 278.8, 291.4]
  const dataTextTops = [218.3, 230.3, 242.3, 254.3, 266.3, 278.3, 289.7]

  const startDate = new Date(mondayDate + "T12:00:00")
  let totalReg = 0, totalOT = 0, totalDT = 0

  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate)
    d.setDate(d.getDate() + i)
    const iso = d.toLocaleDateString("en-CA")
    const dateStr = (d.getMonth() + 1) + "/" + d.getDate() + "/" + String(d.getFullYear()).slice(2)

    // Date column — match template x positions (3/9/26 at x=69.7, others at x=64.5)
    const dateX = dateStr.length <= 6 ? 69.7 : 64.5
    page.drawText(dateStr, { x: dateX, y: bl(dateTextTops[i], 8.8), size: 8.8, font: helv, color: black })

    // Day names already in template — don't redraw

    const rpt = reportsByDate[iso]
    if (rpt && rpt.content) {
      // Merge BOTH vals and lockVals — hours may be in either depending on field mode
      const vals = { ...(rpt.content.lockVals || {}), ...(rpt.content.vals || {}) }
      const projName = findVal2(vals, "project", "name") || findVal(vals, "district") || ""
      const dsa = findVal(vals, "dsa") || ""
      const reg = parseHours(findVal(vals, "reg"))
      const ot = parseHours(findVal(vals, "ot"))
      const dt = parseHours(findVal(vals, "dt"))

      totalReg += reg; totalOT += ot; totalDT += dt
      const datY = bl(dataTextTops[i], 9.6)

      // Project description — x=160.8, auto-shrink to fit column (158.7–446.1)
      if (projName) {
        let sz = 9.6
        const maxW = colX[3] - colX[2] - 6
        const tw = helv.widthOfTextAtSize(projName, sz)
        if (tw > maxW && maxW > 0) sz = Math.max(5, sz * maxW / tw)
        page.drawText(projName, { x: 160.8, y: bl(dataTextTops[i], sz), size: sz, font: helv, color: black })
      }
      // DSA number — x=448.2
      if (dsa) page.drawText(dsa, { x: 448.2, y: datY, size: 9.6, font: helv, color: black })
      // Reg hours — right-align in column 549.9–610.5
      if (reg > 0) {
        const t = reg.toFixed(2)
        const tw = helv.widthOfTextAtSize(t, 9.6)
        page.drawText(t, { x: 608 - tw, y: datY, size: 9.6, font: helv, color: black })
      }
      // OT hours — right-align in column 610.5–648.3
      if (ot > 0) {
        const t = ot.toFixed(2)
        const tw = helv.widthOfTextAtSize(t, 9.6)
        page.drawText(t, { x: 646 - tw, y: datY, size: 9.6, font: helv, color: black })
      }
      // DT hours — right-align in column 648.3–691.5
      if (dt > 0) {
        const t = dt.toFixed(2)
        const tw = helv.widthOfTextAtSize(t, 9.6)
        page.drawText(t, { x: 689 - tw, y: datY, size: 9.6, font: helv, color: black })
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  //  4. OVERLAY: Totals row
  // ════════════════════════════════════════════════════════════
  const totY = bl(303.5, 9.6)
  // Reg total — right-align in column 549.9–610.5
  { const t = totalReg.toFixed(2); const tw = helvB.widthOfTextAtSize(t, 9.6); page.drawText(t, { x: 608 - tw, y: totY, size: 9.6, font: helvB, color: black }) }
  // OT total
  { const t = totalOT > 0 ? totalOT.toFixed(2) : "-"; const tw = helvB.widthOfTextAtSize(t, 9.6); page.drawText(t, { x: 646 - tw, y: totY, size: 9.6, font: helvB, color: black }) }
  // DT total
  { const t = totalDT > 0 ? totalDT.toFixed(2) : "-"; const tw = helvB.widthOfTextAtSize(t, 9.6); page.drawText(t, { x: 689 - tw, y: totY, size: 9.6, font: helvB, color: black }) }
  // 4th column dash
  { const t = "-"; const tw = helvB.widthOfTextAtSize(t, 9.6); page.drawText(t, { x: 739 - tw, y: totY, size: 9.6, font: helvB, color: black }) }

  // ════════════════════════════════════════════════════════════
  //  5. OVERLAY: Signature area
  // ════════════════════════════════════════════════════════════
  // Inspector name — x=310.6, top=340.4 (exact from template)
  page.drawText(userName, { x: 310.6, y: bl(340.4, 9.6), size: 9.6, font: courier, color: black })
  // Date — x=625.1, top=341.3
  const sigDate = (weekEnd.getMonth() + 1) + "/" + weekEnd.getDate() + "/" + weekEnd.getFullYear()
  page.drawText(sigDate, { x: 625.1, y: bl(341.3, 9.6), size: 9.6, font: courier, color: black })

  return await pdfDoc.save()
}
