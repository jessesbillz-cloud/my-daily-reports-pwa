import { SB_URL, SB_KEY } from '../constants/supabase'
import { ensurePdfLib as _ensurePdfLib, ensurePdfJs as _ensurePdfJs, ensureMammoth as _ensureMammoth } from './pdf'

export let AUTH_TOKEN = null

export const getAuthToken = () => AUTH_TOKEN
export const setAuthToken = (token) => { AUTH_TOKEN = token }

// ── Startup validation ──
// Catches key migration issues immediately instead of letting users discover them mid-workflow
export function validateConfig() {
  const issues = []
  // SB_KEY format check — old HS256 JWTs start with "eyJ", new publishable keys start with "sb_"
  if (SB_KEY && SB_KEY.startsWith("eyJ")) {
    issues.push("API key appears to be a legacy JWT format. Check Supabase dashboard for updated keys.")
  }
  if (!SB_KEY || SB_KEY.length < 10) {
    issues.push("API key is missing or too short.")
  }
  if (!SB_URL || !SB_URL.includes("supabase")) {
    issues.push("Supabase URL is missing or invalid.")
  }
  return issues
}

// ── Auth health check ──
// Actually verifies the current token works against a real endpoint.
// Call after login/refresh to catch issues before the user hits them mid-workflow.
export async function authHealthCheck() {
  if (!AUTH_TOKEN) return { ok: false, error: "No token" }
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${AUTH_TOKEN}` }
    })
    if (r.ok) {
      const d = await r.json()
      if (d.id) return { ok: true, userId: d.id, email: d.email }
      return { ok: false, error: "No user in response" }
    }
    const body = await r.text().catch(() => "")
    return { ok: false, error: `Auth check failed (${r.status}): ${body.slice(0, 100)}` }
  } catch (e) {
    return { ok: false, error: `Network error: ${e.message}` }
  }
}

// ── Pre-flight check for edge functions ──
// Verifies auth + edge function reachability BEFORE attempting the real call.
// Returns { ok: true } or { ok: false, error: "..." }
export async function preflightCheck(fnName = "send-report") {
  // 1. Token exists?
  if (!AUTH_TOKEN) {
    const refreshed = await refreshAuthToken()
    if (!refreshed) return { ok: false, error: "Not logged in. Please log out and log back in." }
  }
  // 2. Token valid? (quick decode check — not a server round-trip)
  try {
    const p = JSON.parse(atob(AUTH_TOKEN.split('.')[1]))
    const remaining = (p.exp * 1000 - Date.now()) / 1000
    if (remaining < 30) {
      const refreshed = await refreshAuthToken()
      if (!refreshed) return { ok: false, error: "Session expired. Please log out and log back in." }
    }
  } catch (e) {
    return { ok: false, error: "Corrupted auth token. Please log out and log back in." }
  }
  // 3. Edge function reachable? (OPTIONS preflight — no auth required, very fast)
  try {
    const r = await fetch(`${SB_URL}/functions/v1/${fnName}`, { method: "OPTIONS" })
    // CORS preflight should return 200 or 204
    if (r.status >= 400 && r.status !== 404) {
      return { ok: false, error: `Edge function '${fnName}' is not responding (${r.status}). It may need to be redeployed.` }
    }
  } catch (e) {
    return { ok: false, error: "Cannot reach server. Check your internet connection." }
  }
  return { ok: true }
}

// Returns a short diagnostic string about the current token — safe to show in UI
export function authDiag() {
  if (!AUTH_TOKEN) return "[token=NULL]"
  try {
    const p = JSON.parse(atob(AUTH_TOKEN.split('.')[1]))
    const rem = Math.round((p.exp * 1000 - Date.now()) / 1000)
    return `[role=${p.role} exp=${rem}s sub=${(p.sub||'').slice(0,8)}]`
  } catch (e) { return "[token=MALFORMED]" }
}

// Extract real text positions from PDF using pdf.js getTextContent()
// Returns array of {str, x, y, w, h, page, fontSize} in top-left origin coordinates
export async function extractPdfTextStructure(pdfData) {
  const pdfjsLib = await ensurePdfJs()
  if (!pdfjsLib) throw new Error("pdf.js not loaded")

  const safeCopy = new Uint8Array(
    pdfData instanceof ArrayBuffer ? new Uint8Array(pdfData) : pdfData
  )
  const doc = await pdfjsLib.getDocument({ data: safeCopy }).promise
  const rawItems = []

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const vp = page.getViewport({ scale: 1 })
    const pageH = vp.height
    const tc = await page.getTextContent()

    tc.items.forEach(item => {
      if (!item.str || !item.str.trim()) return
      const tx = item.transform
      const x = tx[4]
      const yBottom = tx[5]
      const fontSize = Math.round(Math.max(Math.abs(tx[0]), Math.abs(tx[3])) * 10) / 10 || 10
      const y = pageH - yBottom - fontSize
      const w = item.width || (item.str.length * fontSize * 0.6)
      const h = item.height || fontSize
      rawItems.push({
        str: item.str.trim(),
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        w: Math.round(w * 100) / 100,
        h: Math.round(h * 100) / 100,
        page: p,
        fontSize: Math.round(fontSize * 10) / 10
      })
    })
  }

  // Merge adjacent text items on the same line
  rawItems.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
  const merged = []

  for (let i = 0; i < rawItems.length; i++) {
    const cur = { ...rawItems[i] }

    while (i + 1 < rawItems.length) {
      const nxt = rawItems[i + 1]
      if (nxt.page !== cur.page) break
      if (Math.abs(nxt.y - cur.y) > 3) break
      const gap = nxt.x - (cur.x + cur.w)
      if (gap > cur.fontSize * 1.2) break

      cur.str = cur.str + " " + nxt.str
      cur.w = Math.round(((nxt.x + nxt.w) - cur.x) * 100) / 100
      cur.h = Math.max(cur.h, nxt.h)
      i++
    }

    cur.str = cur.str.trim()
    if (cur.str) merged.push(cur)
  }

  return merged
}

// Read AcroForm fields from fillable PDFs (client-side with pdf-lib)
export async function readAcroFormFields(pdfData) {
  const PDFLib = await ensurePdfLib()
  if (!PDFLib) throw new Error("pdf-lib not loaded")

  const bytes = pdfData instanceof ArrayBuffer ? new Uint8Array(pdfData) : pdfData
  const pdfDoc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true })

  let form
  try {
    form = pdfDoc.getForm()
  } catch (e) {
    return null
  }

  const fields = form.getFields()
  if (!fields || fields.length === 0) return null

  const result = []
  for (const f of fields) {
    const name = f.getName()
    const typeName = f.constructor.name
    let type = "text", value = ""

    if (typeName === "PDFTextField" || typeName.includes("Text")) {
      type = "text"
      try { value = f.getText() || "" } catch (e) { value = "" }
    } else if (typeName === "PDFCheckBox" || typeName.includes("Check")) {
      type = "checkbox"
      try { value = f.isChecked() ? "on" : "off" } catch (e) { value = "off" }
    } else if (typeName === "PDFDropdown" || typeName.includes("Dropdown")) {
      type = "dropdown"
      try { value = (f.getSelected() || [])[0] || "" } catch (e) { value = "" }
    } else if (typeName === "PDFRadioGroup" || typeName.includes("Radio")) {
      type = "radio"
      try { value = f.getSelected() || "" } catch (e) { value = "" }
    } else if (typeName === "PDFSignature" || typeName.includes("Signature")) {
      type = "signature"
      value = ""
    }

    const nl = name.toLowerCase()
    let autoFill = null, multiline = false, category = "editable"

    if (/\bdate\b/.test(nl) && !/re.?inspect/.test(nl)) autoFill = "date"
    else if (/inspector|prepared.?by|ior\b/.test(nl)) autoFill = "inspector_name"
    else if (/project.?name|job.?name|site.?name/.test(nl)) autoFill = "job_name"
    else if (/address|location/.test(nl) && !/item/.test(nl)) autoFill = "job_address"
    else if (/general.?contractor/.test(nl)) autoFill = "general_contractor"
    else if (/subcontractor/.test(nl)) autoFill = "subcontractor"
    else if (/weather|temp/.test(nl)) autoFill = "weather"
    else if (/\b(ir|number|no\.?|#)\b/.test(nl) && !/phone/.test(nl)) autoFill = "ir_number"
    else if (/duration/.test(nl)) autoFill = "duration"

    if (/notes|observation|comment|item.*location|description/.test(nl)) multiline = true
    if (type === "signature") category = "signature"
    else if (autoFill) category = "auto"

    let fontSize = null
    try {
      const daStr = f.acroField.getDefaultAppearance()
      if (daStr) {
        const szMatch = daStr.match(/(\d+(?:\.\d+)?)\s+Tf/)
        if (szMatch) fontSize = parseFloat(szMatch[1])
      }
    } catch (e) { }

    try {
      if (!fontSize) {
        const widgets = f.acroField.getWidgets()
        if (widgets.length > 0) {
          const r = widgets[0].getRectangle()
          if (r.height > 0 && r.height < 50) fontSize = Math.min(12, Math.max(8, r.height * 0.65))
        }
      }
    } catch (e) { }

    let displayName = name.replace(/-\d+$/, "").replace(/^Textfield-?\d*$/i, "Notes/Description")

    result.push({
      pdfFieldName: name,
      displayName,
      type,
      value,
      autoFill,
      multiline,
      category,
      fontSize: fontSize || null
    })
  }

  return result
}

// Build auto-fill data from all available sources
export function buildAutoFillData(job, user, reportDate) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = reportDate ? new Date(reportDate + "T12:00:00") : new Date()
  const dateUS = now.toLocaleDateString("en-US", { timeZone: tz })
  const meta = user?.user_metadata || {}

  return {
    date: dateUS,
    inspector_name: meta.full_name || "",
    job_name: job?.name || "",
    job_address: job?.site_address || "",
    general_contractor: "",
    subcontractor: "",
    weather: "",
    ir_number: "",
    duration: "",
    company_name: meta.company_name || ""
  }
}

// Auth helper — check for existing session (refresh token in Supabase cookie/localStorage)
export async function authGetSession() {
  const stored = localStorage.getItem("mdr_session")
  if (!stored) return null

  try {
    const session = JSON.parse(stored)
    // Try to refresh the token
    const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SB_KEY },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    })

    if (r.ok) {
      const d = await r.json()
      if (d.access_token) {
        AUTH_TOKEN = d.access_token
        const u = {
          id: d.user.id,
          email: d.user.email,
          user_metadata: d.user.user_metadata || {}
        }
        authSaveSession(d.refresh_token, u, d.access_token)
        return u
      }
    }

    if (r.status === 400 || r.status === 401) {
      localStorage.removeItem("mdr_session")
      return null
    }

    if (session.user) {
      AUTH_TOKEN = session.access_token || null
      return session.user
    }
  } catch (e) {
    try {
      const session = JSON.parse(stored)
      if (session.user) return session.user
    } catch (_) { }
  }

  return null
}

// Save session for persistence (includes access_token so it survives page reload)
export function authSaveSession(refreshToken, user, accessToken) {
  const data = { refresh_token: refreshToken }
  if (user) data.user = user
  if (accessToken) data.access_token = accessToken
  localStorage.setItem("mdr_session", JSON.stringify(data))
}

// Sign in and save session
export async function authSignInAndSave(email, password) {
  const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SB_KEY },
    body: JSON.stringify({ email, password })
  })

  const d = await r.json()
  if (d.access_token) {
    AUTH_TOKEN = d.access_token
    const u = {
      id: d.user.id,
      email: d.user.email,
      user_metadata: d.user.user_metadata || {}
    }
    authSaveSession(d.refresh_token, u, d.access_token)
    return u
  }

  throw new Error(d.error_description || d.msg || d.error || "Invalid email or password")
}

// Sign up and save session
export async function authSignUpAndSave(email, password, fullName) {
  const r = await fetch(`${SB_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SB_KEY },
    body: JSON.stringify({ email, password, data: { full_name: fullName } })
  })

  const d = await r.json()
  if (d.access_token) {
    AUTH_TOKEN = d.access_token
    const u = {
      id: d.user.id,
      email: d.user.email,
      user_metadata: d.user.user_metadata || { full_name: fullName }
    }
    authSaveSession(d.refresh_token, u, d.access_token)
    return u
  }

  if (d.id && !d.access_token) {
    throw new Error("CHECK_EMAIL")
  }

  throw new Error(d.error_description || d.msg || d.error || "Signup failed")
}

// Google OAuth sign-in
export async function authSignInWithGoogle() {
  const redirectTo = window.location.origin + window.location.pathname
  window.location.href = `${SB_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`
}

// Handle OAuth callback — check URL hash for access_token after redirect
export async function authHandleOAuthCallback() {
  const hash = window.location.hash
  if (!hash || !hash.includes("access_token")) return null

  const params = new URLSearchParams(hash.substring(1))
  const accessToken = params.get("access_token")
  const refreshToken = params.get("refresh_token")
  if (!accessToken || !refreshToken) return null

  // Clear hash from URL
  window.history.replaceState(null, "", window.location.pathname + window.location.search)

  // Fetch user info
  AUTH_TOKEN = accessToken
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_KEY, Authorization: "Bearer " + accessToken }
    })
    const d = await r.json()
    if (d.id) {
      const u = { id: d.id, email: d.email, user_metadata: d.user_metadata || {} }
      authSaveSession(refreshToken, u, accessToken)
      return u
    }
  } catch (e) {
    console.error("OAuth callback error:", e)
  }

  return null
}

export function authLogout() {
  AUTH_TOKEN = null
  localStorage.removeItem("mdr_session")
}

// Show a non-blocking auth warning toast (user stays in the app)
function showAuthWarning(msg) {
  console.warn("[AUTH]", msg)
  window.dispatchEvent(new CustomEvent("mdr-auth-warning", { detail: { message: msg } }))
}

// Refresh auth token — returns true on success, false on failure
// NEVER kicks the user out; callers decide what to do on failure
export async function refreshAuthToken() {
  try {
    const stored = localStorage.getItem("mdr_session")
    if (!stored) return false

    const session = JSON.parse(stored)
    if (!session.refresh_token) return false

    const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SB_KEY },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    })

    if (r.ok) {
      const d = await r.json()
      if (d.access_token) {
        AUTH_TOKEN = d.access_token
        authSaveSession(d.refresh_token, session.user, d.access_token)
        return true
      }
    }

    // 400/401 means refresh_token itself is expired — warn but don't logout
    if (r.status === 400 || r.status === 401) {
      console.warn("[AUTH] Refresh token rejected (status", r.status, ")")
      return false
    }
  } catch (e) {
    console.error("Token refresh failed:", e)
  }

  return false
}

// Debug helper: log JWT state without exposing the full token
function _jwtInfo(label) {
  if (!AUTH_TOKEN) { console.warn(`[AUTH:${label}] token=NULL`); return }
  try {
    const parts = AUTH_TOKEN.split('.')
    if (parts.length !== 3) { console.warn(`[AUTH:${label}] token malformed (${parts.length} parts)`); return }
    const p = JSON.parse(atob(parts[1]))
    const exp = new Date(p.exp * 1000)
    const remaining = Math.round((p.exp * 1000 - Date.now()) / 1000)
    console.log(`[AUTH:${label}] role=${p.role} sub=${(p.sub||'').slice(0,8)}… exp=${exp.toISOString()} remaining=${remaining}s`)
  } catch (e) { console.warn(`[AUTH:${label}] decode failed:`, e.message) }
}

// Universal auth-aware fetch — automatically refreshes token and retries on 401
// Use this for ALL Supabase edge function calls instead of raw fetch()
export async function authFetch(url, options = {}) {
  const fnName = url.split('/').pop()
  // Proactively refresh if token is missing
  if (!AUTH_TOKEN) {
    console.warn(`[AUTH] authFetch(${fnName}): no token, attempting refresh`)
    const refreshed = await refreshAuthToken()
    if (!refreshed) {
      showAuthWarning("Your session needs to be refreshed. Please save your work and log in again when convenient.")
      throw new Error("No active session — please log in again.")
    }
  }

  _jwtInfo(`authFetch:${fnName}`)

  const makeHeaders = () => {
    const h = {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      apikey: SB_KEY,
      ...(options.headers || {})
    }
    if (!(options.body instanceof FormData) && !h["Content-Type"]) {
      h["Content-Type"] = "application/json"
    }
    return h
  }

  let r = await fetch(url, { ...options, headers: makeHeaders() })

  // On 401, refresh token and retry ONCE
  if (r.status === 401) {
    const peek = await r.clone().text().catch(() => "")
    console.error(`[AUTH] authFetch(${fnName}): GOT 401 — response: ${peek.slice(0, 200)}`)
    _jwtInfo(`401:${fnName}`)
    // Only retry if it's a gateway/auth 401, not an app-level 401 (e.g. Resend API key)
    const isAppLevel = peek.includes("Resend") || peek.includes("Unauthorized — invalid")
    if (!isAppLevel) {
      const refreshed = await refreshAuthToken()
      if (refreshed && AUTH_TOKEN) {
        _jwtInfo(`retry:${fnName}`)
        r = await fetch(url, { ...options, headers: makeHeaders() })
        if (r.status === 401) {
          const peek2 = await r.clone().text().catch(() => "")
          console.error(`[AUTH] authFetch(${fnName}): RETRY ALSO 401 — response: ${peek2.slice(0, 200)}`)
        }
      } else {
        showAuthWarning("Your session expired. Please save your work and log in again when convenient.")
        throw new Error("Session expired — please log in again.")
      }
    }
  }

  return r
}

// Auth-aware storage upload — POST, then PUT on conflict, with 401 retry
export async function authStorageUpload(storagePath, blob, contentType) {
  // Proactively refresh if token is missing
  if (!AUTH_TOKEN) {
    const refreshed = await refreshAuthToken()
    if (!refreshed) {
      showAuthWarning("Your session needs to be refreshed before uploading. Please log in again when convenient.")
      throw new Error("No active session — please log in again.")
    }
  }

  const makeHeaders = () => ({
    apikey: SB_KEY,
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "Content-Type": contentType || "application/octet-stream"
  })

  let r = await fetch(`${SB_URL}/storage/v1/object/report-source-docs/${storagePath}`, {
    method: "POST", headers: makeHeaders(), body: blob
  })
  // Retry POST on 401
  if (r.status === 401) {
    const refreshed = await refreshAuthToken()
    if (refreshed && AUTH_TOKEN) {
      r = await fetch(`${SB_URL}/storage/v1/object/report-source-docs/${storagePath}`, {
        method: "POST", headers: makeHeaders(), body: blob
      })
    } else {
      showAuthWarning("Upload failed — session expired. Please log in again when convenient.")
      throw new Error("Session expired — please log in again.")
    }
  }
  // Conflict (file exists) → PUT to overwrite
  if (!r.ok) {
    r = await fetch(`${SB_URL}/storage/v1/object/report-source-docs/${storagePath}`, {
      method: "PUT", headers: makeHeaders(), body: blob
    })
    if (r.status === 401) {
      const refreshed = await refreshAuthToken()
      if (refreshed && AUTH_TOKEN) {
        r = await fetch(`${SB_URL}/storage/v1/object/report-source-docs/${storagePath}`, {
          method: "PUT", headers: makeHeaders(), body: blob
        })
      } else {
        showAuthWarning("Upload failed — session expired. Please log in again when convenient.")
        throw new Error("Session expired — please log in again.")
      }
    }
  }
  return r
}

// Use the proper lazy-loaders from utils/pdf.js (not duplicates)
const ensurePdfLib = _ensurePdfLib
const ensurePdfJs = _ensurePdfJs
const ensureMammoth = _ensureMammoth
