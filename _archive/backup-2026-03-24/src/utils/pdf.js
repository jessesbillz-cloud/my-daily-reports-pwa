export async function ensurePdfLib() {
  if (window.PDFLib) return window.PDFLib
  // CDN script tag loads to window.PDFLib — wait briefly for it
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (window.PDFLib) return window.PDFLib
  }
  // Fallback: try dynamic import (may fail on mobile due to chunk loading)
  try {
    const pdfLib = await import('pdf-lib')
    window.PDFLib = pdfLib
    return window.PDFLib
  } catch (e) {
    console.error("pdf-lib import failed:", e)
    throw new Error("Could not load PDF library. Check your internet connection and try again.")
  }
}

export async function ensurePdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib
  // CDN script tag loads to window.pdfjsLib — wait briefly for it
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (window.pdfjsLib) return window.pdfjsLib
  }
  // Fallback: try dynamic import
  try {
    const pdfjsLib = await import('pdfjs-dist')
    const pdfVer = pdfjsLib.version || '3.11.174'
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfVer}/pdf.worker.min.js`
    window.pdfjsLib = pdfjsLib
    return pdfjsLib
  } catch (e) {
    console.error("pdfjs-dist import failed:", e)
    throw new Error("Could not load PDF viewer. Check your internet connection and try again.")
  }
}

export async function ensureMammoth() {
  if (window.mammoth) return window.mammoth
  try {
    const mammoth = await import('mammoth')
    window.mammoth = mammoth
    return mammoth
  } catch (e) {
    console.error("mammoth import failed:", e)
    throw e
  }
}
