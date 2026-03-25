import { SB_URL, SB_KEY } from '../constants/supabase'
import { getAuthToken, refreshAuthToken, authFetch } from './auth'

// ─────────────────────────────────────────────────────────────────────
// STORAGE NAMING CONVENTION  (DO NOT CHANGE without updating ALL paths)
// ─────────────────────────────────────────────────────────────────────
// Bucket: "company-templates"
//   Folder naming:  <Company Name>/   (human-readable, NOT the UUID)
//     e.g.  company-templates/TYR Engineering/TYR_Daily_Report_v5.pdf
//           company-templates/TYR Engineering/logo.png
//
// The company_templates DB table stores:
//   storage_path = "company-templates/<Company Name>/<filename>"
//
// Download logic (downloadTemplateBytes) strips the "company-templates/"
// prefix and fetches from the bucket.  It also has fallbacks for legacy
// paths that used UUIDs — but ALL new uploads MUST use the company name.
//
// Job-level assets use:  jobs/<jobId>/<file>   (still in company-templates bucket)
//
// Report outputs use bucket "report-source-docs":
//   <userId>/<jobId>/reports/<filename>
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the storage folder name for a company.
 * ALWAYS use this when constructing paths in the company-templates bucket.
 * @param {string} companyName - The company's display name (e.g. "TYR Engineering")
 * @returns {string} Sanitised folder name safe for Supabase storage
 */
function companyFolder(companyName) {
  if (!companyName) throw new Error("companyFolder: companyName is required")
  // Trim whitespace, collapse multiple spaces, keep letters/numbers/spaces/hyphens
  return companyName.trim().replace(/\s+/g, " ")
}

class Database {
  _h() {
    const token = getAuthToken()
    if (!token) console.warn("[DB] No auth token — request may fail")
    return {
      "Content-Type": "application/json",
      apikey: SB_KEY,
      Authorization: `Bearer ${token}`,
      Prefer: "return=representation"
    }
  }

  // Ensure token is fresh before critical writes (save, submit, upload)
  // Now force-refreshes when token is missing and throws if refresh fails
  async _ensureFresh() {
    const token = getAuthToken()
    if (!token) {
      console.warn("[DB] _ensureFresh: no token, attempting refresh")
      const refreshed = await refreshAuthToken()
      if (!refreshed) throw new Error("Session expired — please log in again.")
      console.log("[DB] _ensureFresh: refresh succeeded, token restored")
      return
    }
    try {
      const payload = JSON.parse(atob(token.split('.')[1]))
      const expiresIn = (payload.exp * 1000) - Date.now()
      if (expiresIn < 5 * 60 * 1000) {
        console.warn(`[DB] _ensureFresh: token expires in ${Math.round(expiresIn/1000)}s — refreshing`)
        const refreshed = await refreshAuthToken()
        if (!refreshed) throw new Error("Session expired — please log in again.")
        console.log("[DB] _ensureFresh: proactive refresh succeeded")
      }
    } catch (e) {
      if (e.message.includes("Session expired")) throw e
    }
  }

  async jobs(userId) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/jobs?user_id=eq.${userId}&select=*&order=created_at.asc`, {
      headers: this._h()
    })
    if (!r.ok) throw new Error("Failed")
    return await r.json()
  }

  async todayRpts(ids) {
    await this._ensureFresh()
    if (!ids.length) return []
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const t = new Date().toLocaleDateString("en-CA", { timeZone: tz })
    const q = ids.map(i => `"${i}"`).join(",")
    const r = await fetch(`${SB_URL}/rest/v1/reports?select=id,job_id,status,report_date&report_date=eq.${t}&job_id=in.(${q})`, {
      headers: this._h()
    })
    if (!r.ok) return []
    return await r.json()
  }

  async mkJob(d) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/jobs`, {
      method: "POST",
      headers: this._h(),
      body: JSON.stringify(d)
    })
    if (!r.ok) {
      const e = await r.json()
      throw new Error(e.message || "Failed")
    }
    return (await r.json())[0]
  }

  async ulTpl(uid, jid, blob, ext) {
    await this._ensureFresh()
    const p = `${uid}/${jid}/template.${ext || "pdf"}`
    const ct = blob.type || "application/octet-stream"
    const h = {
      apikey: SB_KEY,
      Authorization: `Bearer ${getAuthToken()}`,
      "Content-Type": ct,
      "x-upsert": "true"
    }
    console.log("[ulTpl] uploading", p, "size:", blob.size, "type:", ct)

    // Try POST with upsert
    let r = await fetch(`${SB_URL}/storage/v1/object/report-source-docs/${p}`, {
      method: "POST", headers: h, body: blob
    })

    // If POST fails (duplicate/policy), fall back to PUT (update)
    if (!r.ok) {
      const postErr = await r.text().catch(() => "")
      console.log("[ulTpl] POST failed:", r.status, postErr, "— trying PUT")
      r = await fetch(`${SB_URL}/storage/v1/object/report-source-docs/${p}`, {
        method: "PUT", headers: h, body: blob
      })
    }

    if (!r.ok) {
      const errBody = await r.text().catch(() => "")
      console.error("[ulTpl] both POST+PUT failed:", r.status, errBody)
      throw new Error(
        "Template upload failed" +
        (r.status === 401 ? " — session expired, please sign out and back in" : "") +
        (r.status === 413 ? " — file too large" : ": " + r.status + " " + (errBody || ""))
      )
    }

    console.log("[ulTpl] success:", p)
    return p
  }

  async mkTpl(d) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/templates`, {
      method: "POST",
      headers: this._h(),
      body: JSON.stringify(d)
    })
    if (r.ok) {
      const txt = await r.text()
      try { return JSON.parse(txt)[0] } catch (_) { return null }
    }
    const err = await r.json().catch(() => ({}))
    throw new Error(err.message || "Template save failed")
  }

  _profileCache = {}

  async getProfile(userId) {
    if (this._profileCache[userId]) return this._profileCache[userId]
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${userId}&select=*`, {
      headers: this._h()
    })
    if (!r.ok) return null
    const d = await r.json()
    const p = d[0] || null
    if (p) this._profileCache[userId] = p
    return p
  }

  clearProfileCache() {
    this._profileCache = {}
  }

  async upsertProfile(d) {
    await this._ensureFresh()
    this._profileCache = {}
    const id = d.id
    const payload = { ...d }
    delete payload.id

    let r = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${id}`, {
      method: "PATCH",
      headers: this._h(),
      body: JSON.stringify(payload)
    })

    if (r.ok) {
      const txt = await r.text()
      try {
        const arr = JSON.parse(txt)
        if (arr && arr.length > 0) return arr[0]
      } catch (_) { }
    }

    if (r.ok) {
      r = await fetch(`${SB_URL}/rest/v1/profiles`, {
        method: "POST",
        headers: this._h(),
        body: JSON.stringify(d)
      })
      if (r.ok) {
        const txt = await r.text()
        try { return JSON.parse(txt)[0] } catch (_) { return null }
      }
    }

    const err = await r.json().catch(() => ({}))
    const msg = err.message || ""

    if (msg.includes("schema cache") || msg.includes("column")) {
      const safe = { id }
      if (d.full_name) safe.full_name = d.full_name
      if (d.slug) safe.slug = d.slug

      r = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${id}`, {
        method: "PATCH",
        headers: this._h(),
        body: JSON.stringify({ full_name: safe.full_name, slug: safe.slug })
      })

      if (!r.ok) {
        r = await fetch(`${SB_URL}/rest/v1/profiles`, {
          method: "POST",
          headers: this._h(),
          body: JSON.stringify(safe)
        })
      }

      if (r.ok) {
        const txt = await r.text()
        try { return JSON.parse(txt)[0] } catch (_) { return null }
      }

      const e2 = await r.json().catch(() => ({}))
      throw new Error(e2.message || "Profile save failed")
    }

    throw new Error(msg || "Profile save failed")
  }

  async deleteJob(jobId) {
    await this._ensureFresh()
    const h = this._h()
    const del = async (tbl, col) => {
      const r = await fetch(`${SB_URL}/rest/v1/${tbl}?${col}=eq.${jobId}`, {
        method: "DELETE",
        headers: h
      })
      if (!r.ok) {
        const t = await r.text().catch(() => "")
        console.error(`Delete ${tbl} failed:`, r.status, t)
      }
    }

    await del("templates", "job_id")
    await del("reports", "job_id")

    const r = await fetch(`${SB_URL}/rest/v1/jobs?id=eq.${jobId}`, {
      method: "DELETE",
      headers: h
    })

    if (!r.ok) {
      const t = await r.text().catch(() => "")
      throw new Error("Delete job failed: " + r.status + " " + (t || ""))
    }

    return true
  }

  async deleteAccount(userId) {
    await this._ensureFresh()
    const r = await authFetch(`${SB_URL}/functions/v1/delete-account`, {
      method: "POST",
      body: JSON.stringify({})
    })

    if (!r.ok) {
      const err = await r.json().catch(() => ({}))
      throw new Error(err.error || "Delete failed (" + r.status + ")")
    }

    return await r.json()
  }

  _reportIdCache = {}
  _tplBytesCache = {}

  async saveReport(d) {
    // Proactively refresh token before save — prevents 401 on long editing sessions
    await this._ensureFresh()

    const cacheKey = d.job_id + "_" + d.report_date
    const cachedId = this._reportIdCache[cacheKey]
    d.updated_at = new Date().toISOString()

    // Helper: retry a fetch once after token refresh on 401
    const fetchRetry = async (url, opts) => {
      let r = await fetch(url, opts)
      if (r.status === 401 || r.status === 403) {
        const refreshed = await refreshAuthToken()
        if (refreshed) {
          opts.headers = this._h()
          r = await fetch(url, opts)
        }
      }
      return r
    }

    if (cachedId) {
      const r = await fetchRetry(`${SB_URL}/rest/v1/reports?id=eq.${cachedId}`, {
        method: "PATCH",
        headers: this._h(),
        body: JSON.stringify(d)
      })
      if (r.ok) {
        const j = await r.json()
        return j[0]
      }
    }

    const chk = await fetchRetry(
      `${SB_URL}/rest/v1/reports?select=id,status&job_id=eq.${d.job_id}&report_date=eq.${d.report_date}&limit=1`,
      { headers: this._h() }
    )
    const existing = chk.ok ? await chk.json() : []

    if (existing.length > 0) {
      this._reportIdCache[cacheKey] = existing[0].id
      const r = await fetchRetry(`${SB_URL}/rest/v1/reports?id=eq.${existing[0].id}`, {
        method: "PATCH",
        headers: this._h(),
        body: JSON.stringify(d)
      })
      if (!r.ok) {
        const e = await r.json()
        throw new Error(e.message || "Save failed")
      }
      return (await r.json())[0]
    } else {
      const cntR = await fetchRetry(
        `${SB_URL}/rest/v1/reports?select=report_number&job_id=eq.${d.job_id}&order=report_number.desc&limit=1`,
        { headers: this._h() }
      )
      const topRpt = cntR.ok ? await cntR.json() : []

      if (topRpt[0]?.report_number) {
        d.report_number = topRpt[0].report_number + 1
      } else {
        const countR = await fetch(
          `${SB_URL}/rest/v1/reports?select=id&job_id=eq.${d.job_id}&limit=0`,
          { headers: { ...this._h(), Prefer: "count=exact" } }
        )
        const total = parseInt(countR.headers.get("content-range")?.split("/")[1] || "0")
        d.report_number = total + 1
      }

      const r = await fetchRetry(`${SB_URL}/rest/v1/reports`, {
        method: "POST",
        headers: this._h(),
        body: JSON.stringify(d)
      })
      if (!r.ok) {
        const e = await r.json()
        throw new Error(e.message || "Save failed")
      }

      const created = (await r.json())[0]
      if (created?.id) this._reportIdCache[cacheKey] = created.id
      return created
    }
  }

  async getReport(jobId, date) {
    await this._ensureFresh()
    const r = await fetch(
      `${SB_URL}/rest/v1/reports?select=*&job_id=eq.${jobId}&report_date=eq.${date}&limit=1`,
      { headers: this._h() }
    )
    if (!r.ok) return null
    const d = await r.json()
    return d[0] || null
  }

  async getLatestReport(jobId, beforeDate) {
    await this._ensureFresh()
    const r = await fetch(
      `${SB_URL}/rest/v1/reports?select=*&job_id=eq.${jobId}&report_date=lt.${beforeDate}&order=report_date.desc&limit=1`,
      { headers: this._h() }
    )
    if (!r.ok) return null
    const d = await r.json()
    return d[0] || null
  }

  async getJobPhotos(jobId) {
    await this._ensureFresh()
    try {
      // Fetch reports in batches to avoid loading all content at once
      // Only content column contains photos — limit to 20 most recent reports
      const r = await fetch(
        `${SB_URL}/rest/v1/reports?select=id,report_date,report_number,content&job_id=eq.${jobId}&order=report_date.desc&limit=20`,
        { headers: this._h() }
      )
      if (!r.ok) return []
      const reports = await r.json()
      const photos = []
      for (const rpt of reports) {
        try {
          const c = typeof rpt.content === "string" ? JSON.parse(rpt.content) : rpt.content
          if (c && Array.isArray(c.photos)) {
            for (const p of c.photos) {
              if (p.src) photos.push({ id: p.id || Date.now() + Math.random(), src: p.src, name: p.name || "", report_date: rpt.report_date, report_number: rpt.report_number })
            }
          }
        } catch (e) { /* skip unparseable content */ }
      }
      return photos
    } catch (e) { console.error("getJobPhotos:", e); return [] }
  }

  async deleteReport(reportId, jobId, reportDate) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/reports?id=eq.${reportId}`, {
      method: "DELETE",
      headers: this._h()
    })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw new Error(e.message || "Delete failed")
    }

    if (jobId && reportDate) delete this._reportIdCache[jobId + "_" + reportDate]
  }

  async updateJobFieldConfig(jobId, fieldConfig) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/jobs?id=eq.${jobId}`, {
      method: "PATCH",
      headers: this._h(),
      body: JSON.stringify({ field_config: fieldConfig })
    })
    if (!r.ok) throw new Error("Field config update failed")
    return (await r.json())[0]
  }

  async getTemplate(jobId) {
    await this._ensureFresh()
    let r = await fetch(`${SB_URL}/rest/v1/templates?job_id=eq.${jobId}&select=*&limit=1`, {
      headers: this._h()
    })
    if (!r.ok) {
      console.error("getTemplate failed:", r.status, await r.text().catch(() => ""))
      if (r.status === 401 || r.status === 403) {
        const refreshed = await refreshAuthToken()
        if (refreshed) {
          r = await fetch(`${SB_URL}/rest/v1/templates?job_id=eq.${jobId}&select=*&limit=1`, {
            headers: this._h()
          })
          if (r.ok) {
            const d = await r.json()
            return d[0] || null
          }
        }
      }
      return null
    }
    const d = await r.json()
    return d[0] || null
  }

  // Search a storage bucket for a file by name (searches all folders)
  // Matches exact name OR files ending with _fileName (timestamp prefix convention)
  async findFileInBucket(bucket, fileName) {
    const authH = { apikey: SB_KEY, Authorization: `Bearer ${getAuthToken()}`, "Content-Type": "application/json" }
    const matchesFile = (f) => f.name === fileName || f.name.endsWith("_" + fileName)
    // List root folders first
    const foldersR = await fetch(`${SB_URL}/storage/v1/object/list/${bucket}`, {
      method: "POST", headers: authH, body: JSON.stringify({ prefix: "", limit: 200 })
    })
    if (!foldersR.ok) return null
    const items = await foldersR.json()
    console.log("[findFile] bucket:", bucket, "looking for:", fileName, "root items:", items.length)
    // Check root level files
    const rootMatch = items.find(i => matchesFile(i) && i.metadata !== null)
    if (rootMatch) return rootMatch.name
    // Search inside each folder
    for (const item of items) {
      if (item.id === null || item.metadata === null) {
        // This is a folder — search inside it
        const subR = await fetch(`${SB_URL}/storage/v1/object/list/${bucket}`, {
          method: "POST", headers: authH, body: JSON.stringify({ prefix: item.name + "/", limit: 200 })
        })
        if (!subR.ok) continue
        const subItems = await subR.json()
        console.log("[findFile] folder:", item.name, "files:", subItems.map(f => f.name))
        const match = subItems.find(f => matchesFile(f))
        if (match) return item.name + "/" + match.name
      }
    }
    return null
  }

  async downloadTemplateBytes(storagePath) {
    await this._ensureFresh()
    if (this._tplBytesCache[storagePath]) {
      try { return this._tplBytesCache[storagePath].slice(0).buffer } catch (e) { delete this._tplBytesCache[storagePath] }
    }

    const isCompany = storagePath.startsWith("company-templates/")
    const authH = () => ({ apikey: SB_KEY, Authorization: `Bearer ${getAuthToken()}` })
    let r

    // Build the raw path (strip bucket prefix)
    const rawPath = isCompany ? storagePath.replace("company-templates/", "") : storagePath
    const encodedPath = rawPath.split("/").map(s => encodeURIComponent(s)).join("/")
    console.log("[downloadTpl] storagePath:", storagePath, "rawPath:", rawPath, "encoded:", encodedPath)

    // Try all combinations: company-templates (auth + public) and report-source-docs
    const urls = [
      { url: `${SB_URL}/storage/v1/object/company-templates/${encodedPath}`, auth: true },
      { url: `${SB_URL}/storage/v1/object/public/company-templates/${encodedPath}`, auth: false },
      { url: `${SB_URL}/storage/v1/object/report-source-docs/${encodedPath}`, auth: true }
    ]

    for (const { url, auth } of urls) {
      r = await fetch(url, auth ? { headers: authH() } : {})
      console.log("[downloadTpl]", r.status, url)
      if (r.ok) break
    }

    // If all failed, search the bucket for the file by name
    if (!r || !r.ok) {
      const fileName = rawPath.split("/").pop()
      console.log("[downloadTpl] direct paths failed — searching bucket for:", fileName)
      const found = await this.findFileInBucket("company-templates", fileName)
      if (found) {
        const foundEncoded = found.split("/").map(s => encodeURIComponent(s)).join("/")
        console.log("[downloadTpl] found file at:", found)
        r = await fetch(`${SB_URL}/storage/v1/object/company-templates/${foundEncoded}`, { headers: authH() })
        if (!r.ok) r = await fetch(`${SB_URL}/storage/v1/object/public/company-templates/${foundEncoded}`)
      }
    }

    if (!r || !r.ok) throw new Error("Could not download template (" + (r ? r.status : "no response") + "). File may be missing from storage.")

    const buf = await r.arrayBuffer()
    this._tplBytesCache[storagePath] = new Uint8Array(buf)
    return buf
  }

  async saveTemplatePages(userId, jobId, pageImages) {
    await this._ensureFresh()
    const paths = []
    for (let i = 0; i < pageImages.length; i++) {
      const blob = await (await fetch(pageImages[i])).blob()
      const p = `${userId}/${jobId}/template_page_${i}.jpg`

      let r = await fetch(`${SB_URL}/storage/v1/object/report-source-docs/${p}`, {
        method: "POST",
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${getAuthToken()}`,
          "Content-Type": "image/jpeg"
        },
        body: blob
      })

      if (!r.ok) {
        r = await fetch(`${SB_URL}/storage/v1/object/report-source-docs/${p}`, {
          method: "PUT",
          headers: {
            apikey: SB_KEY,
            Authorization: `Bearer ${getAuthToken()}`,
            "Content-Type": "image/jpeg"
          },
          body: blob
        })
      }

      paths.push(p)
    }
    return paths
  }

  getTemplatePageUrl(path) {
    return `${SB_URL}/storage/v1/object/report-source-docs/${path}`
  }

  async getRequests(userId, startDate, endDate) {
    await this._ensureFresh()
    const r = await fetch(
      `${SB_URL}/rest/v1/inspection_requests?user_id=eq.${userId}&requested_date=gte.${startDate}&requested_date=lte.${endDate}&status=not.in.(deleted,cancelled)&select=*,jobs(name,site_address)&order=requested_date.asc`,
      { headers: this._h() }
    )
    if (!r.ok) return []
    return await r.json()
  }

  async updateRequest(id, d) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/inspection_requests?id=eq.${id}`, {
      method: "PATCH",
      headers: this._h(),
      body: JSON.stringify({ ...d, updated_at: new Date().toISOString() })
    })
    if (!r.ok) {
      const e = await r.json()
      throw new Error(e.message || "Update failed")
    }
    return (await r.json())[0]
  }

  async deleteRequest(id) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/inspection_requests?id=eq.${id}`, {
      method: "DELETE",
      headers: this._h()
    })
    if (!r.ok) throw new Error("Delete failed")
    return true
  }

  async getSavedTemplates(userId) {
    await this._ensureFresh()
    const r = await fetch(
      `${SB_URL}/rest/v1/saved_templates?user_id=eq.${userId}&select=*&order=created_at.desc`,
      { headers: this._h() }
    )
    if (!r.ok) return []

    const all = await r.json()
    const seen = new Set()
    return all.filter(t => {
      if (!t.storage_path) return true
      if (seen.has(t.storage_path)) return false
      seen.add(t.storage_path)
      return true
    })
  }

  async saveParsedTemplate(d) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/saved_templates`, {
      method: "POST",
      headers: this._h(),
      body: JSON.stringify(d)
    })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw new Error(e.message || "Save template failed")
    }
    const txt = await r.text()
    try { return JSON.parse(txt)[0] } catch (_) { return null }
  }

  async deleteSavedTemplate(id) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/saved_templates?id=eq.${id}`, {
      method: "DELETE",
      headers: this._h()
    })
    if (!r.ok) throw new Error("Delete failed")
    return true
  }

  async searchCompanies(query) {
    await this._ensureFresh()
    if (!query || query.trim().length < 2) return []
    const enc = encodeURIComponent(query.trim())
    const r = await fetch(
      `${SB_URL}/rest/v1/companies?name=ilike.*${enc}*&select=id,name,created_by&limit=5`,
      { headers: this._h() }
    )
    if (!r.ok) return []
    return await r.json()
  }

  async createCompany(name, createdBy) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/companies`, {
      method: "POST",
      headers: this._h(),
      body: JSON.stringify({ name: name.trim(), created_by: createdBy })
    })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw new Error(e.message || "Company creation failed")
    }
    const txt = await r.text()
    try { return JSON.parse(txt)[0] } catch (_) { return null }
  }

  async uploadCompanyTemplate(companyId, file, companyName) {
    await this._ensureFresh()
    // Resolve folder name: use company name (human-readable) — see STORAGE NAMING CONVENTION above
    let folder = companyName ? companyFolder(companyName) : null
    if (!folder) {
      // Fallback: look up company name from DB so we never use UUID as folder
      const co = await this.getCompany(companyId)
      folder = co?.name ? companyFolder(co.name) : companyId // last-resort: UUID
      console.warn("[db] uploadCompanyTemplate: companyName not provided, looked up:", folder)
    }
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
    const storagePath = `${folder}/${safeName}`

    let upR = await fetch(`${SB_URL}/storage/v1/object/company-templates/${storagePath}`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${getAuthToken()}`,
        "Content-Type": file.type || "application/pdf"
      },
      body: file
    })

    if (!upR.ok) {
      upR = await fetch(`${SB_URL}/storage/v1/object/company-templates/${storagePath}`, {
        method: "PUT",
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${getAuthToken()}`,
          "Content-Type": file.type || "application/pdf"
        },
        body: file
      })
    }

    if (!upR.ok) {
      const e = await upR.text()
      throw new Error("Storage upload failed: " + e)
    }

    const tplName = file.name.replace(/\.[^.]+$/, "").replace(/_/g, " ")
    const r = await fetch(`${SB_URL}/rest/v1/company_templates`, {
      method: "POST",
      headers: { ...this._h(), Prefer: "return=representation" },
      body: JSON.stringify({
        company_id: companyId,
        template_name: tplName,
        file_name: file.name,
        file_type: file.name.split(".").pop() || "pdf",
        storage_path: `company-templates/${storagePath}`,
        mode: "template"
      })
    })

    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw new Error(e.message || "Failed to save template record")
    }

    return (await r.json())[0]
  }

  async deleteCompanyTemplate(templateId) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/company_templates?id=eq.${templateId}`, {
      method: "DELETE",
      headers: this._h()
    })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw new Error(e.message || "Delete failed")
    }
  }

  async getCompanyTemplates(companyId) {
    await this._ensureFresh()
    const r = await fetch(
      `${SB_URL}/rest/v1/company_templates?company_id=eq.${companyId}&select=*&order=created_at.desc`,
      { headers: this._h() }
    )
    if (!r.ok) return []

    const all = await r.json()
    const seen = new Set()
    return all.filter(t => {
      const k = t.storage_path || t.id
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }

  async copyCompanyTemplatesToUser(companyTemplates, userId) {
    const existing = await this.getSavedTemplates(userId)
    const existingPaths = new Set(existing.map(t => t.storage_path).filter(Boolean))
    const results = []

    for (const ct of companyTemplates) {
      if (ct.storage_path && existingPaths.has(ct.storage_path)) {
        console.log("Skip duplicate template:", ct.storage_path)
        continue
      }

      const d = {
        user_id: userId,
        template_name: ct.template_name,
        file_name: ct.file_name,
        file_type: ct.file_type,
        storage_path: ct.storage_path,
        field_config: ct.field_config,
        mode: ct.mode || "template"
      }

      try {
        const saved = await this.saveParsedTemplate(d)
        results.push(saved)
      } catch (e) {
        console.error("Copy template failed:", e)
      }
    }

    return results
  }

  async assignCompany(userId, companyName) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/rpc/assign_company`, {
      method: "POST",
      headers: this._h(),
      body: JSON.stringify({ p_user_id: userId, p_company_name: companyName })
    })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw new Error(e.message || "assign_company failed")
    }
    const id = await r.json()
    return id
  }

  async copyCompanyTemplatesDB(userId, companyId, jobId) {
    await this._ensureFresh()
    const params = { p_user_id: userId, p_company_id: companyId }
    if (jobId) params.p_job_id = jobId

    const r = await fetch(`${SB_URL}/rest/v1/rpc/copy_company_templates_to_user`, {
      method: "POST",
      headers: this._h(),
      body: JSON.stringify(params)
    })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw new Error(e.message || "copy_company_templates failed")
    }
    return await r.json()
  }

  async uploadCompanyLogo(companyId, file, companyName) {
    await this._ensureFresh()
    // Resolve folder name: use company name — see STORAGE NAMING CONVENTION above
    let folder = companyName ? companyFolder(companyName) : null
    if (!folder) {
      const co = await this.getCompany(companyId)
      folder = co?.name ? companyFolder(co.name) : companyId
      console.warn("[db] uploadCompanyLogo: companyName not provided, looked up:", folder)
    }
    const ext = file.name.split(".").pop() || "png"
    const storagePath = `${folder}/logo.${ext}`

    let upR = await fetch(`${SB_URL}/storage/v1/object/company-templates/${storagePath}`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${getAuthToken()}`,
        "Content-Type": file.type
      },
      body: file
    })

    if (!upR.ok) {
      upR = await fetch(`${SB_URL}/storage/v1/object/company-templates/${storagePath}`, {
        method: "PUT",
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${getAuthToken()}`,
          "Content-Type": file.type
        },
        body: file
      })
    }

    if (!upR.ok) throw new Error("Logo upload failed (" + upR.status + ")")

    const logoUrl = `${SB_URL}/storage/v1/object/public/company-templates/${storagePath}`
    await fetch(`${SB_URL}/rest/v1/companies?id=eq.${companyId}`, {
      method: "PATCH",
      headers: this._h(),
      body: JSON.stringify({ logo_url: logoUrl })
    })

    try { localStorage.setItem("mdr_logo_" + companyId, logoUrl) } catch (e) { }
    return logoUrl
  }

  getCompanyLogo(companyId) {
    try { return localStorage.getItem("mdr_logo_" + companyId) || null } catch (e) { return null }
  }

  async getCompanyLogoUrl(companyId) {
    const cached = this.getCompanyLogo(companyId)
    if (cached) return cached

    await this._ensureFresh()
    try {
      const r = await fetch(`${SB_URL}/rest/v1/companies?id=eq.${companyId}&select=logo_url&limit=1`, {
        headers: this._h()
      })
      if (r.ok) {
        const d = await r.json()
        const url = d[0]?.logo_url
        if (url) {
          try { localStorage.setItem("mdr_logo_" + companyId, url) } catch (e) { }
          return url
        }
      }
    } catch (e) { }

    return null
  }

  async getCompany(companyId) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/companies?id=eq.${companyId}&select=id,name,logo_url&limit=1`, {
      headers: this._h()
    })
    if (!r.ok) return null
    const d = await r.json()
    return d[0] || null
  }

  async uploadJobLogo(jobId, file) {
    await this._ensureFresh()
    if (file.size > 2 * 1024 * 1024) throw new Error("Logo must be under 2MB")
    if (!file.type.startsWith("image/")) throw new Error("Logo must be an image")

    const ext = file.name.split(".").pop() || "png"
    const storagePath = `jobs/${jobId}/logo.${ext}`

    let upR = await fetch(`${SB_URL}/storage/v1/object/company-templates/${storagePath}`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${getAuthToken()}`,
        "Content-Type": file.type
      },
      body: file
    })

    if (!upR.ok) {
      upR = await fetch(`${SB_URL}/storage/v1/object/company-templates/${storagePath}`, {
        method: "PUT",
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${getAuthToken()}`,
          "Content-Type": file.type
        },
        body: file
      })
    }

    if (!upR.ok) throw new Error("Logo upload failed (" + upR.status + ")")

    const logoUrl = `${SB_URL}/storage/v1/object/public/company-templates/${storagePath}`
    await fetch(`${SB_URL}/rest/v1/jobs?id=eq.${jobId}`, {
      method: "PATCH",
      headers: this._h(),
      body: JSON.stringify({ logo_url: logoUrl })
    })

    try { localStorage.setItem("mdr_logo_job_" + jobId, logoUrl) } catch (e) { }
    return logoUrl
  }

  async getJobLogoUrl(jobId) {
    if (!jobId) return null
    try {
      const cached = localStorage.getItem("mdr_logo_job_" + jobId)
      if (cached) return cached
    } catch (e) { }

    await this._ensureFresh()
    try {
      const r = await fetch(`${SB_URL}/rest/v1/jobs?id=eq.${jobId}&select=logo_url&limit=1`, {
        headers: this._h()
      })
      if (r.ok) {
        const d = await r.json()
        const url = d[0]?.logo_url
        if (url) {
          try { localStorage.setItem("mdr_logo_job_" + jobId, url) } catch (e) { }
          return url
        }
      }
    } catch (e) { }

    return null
  }

  async removeJobLogo(jobId) {
    await this._ensureFresh()
    await fetch(`${SB_URL}/rest/v1/jobs?id=eq.${jobId}`, {
      method: "PATCH",
      headers: this._h(),
      body: JSON.stringify({ logo_url: null })
    })
    try { localStorage.removeItem("mdr_logo_job_" + jobId) } catch (e) { }
  }

  // ── TYR v3: Job Contractors ──────────────────────────────────────
  async getJobContractors(jobId) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/job_contractors?job_id=eq.${jobId}&is_active=eq.true&select=*&order=sort_order.asc,created_at.asc`, {
      headers: this._h()
    })
    if (!r.ok) return []
    return await r.json()
  }

  async addJobContractor(jobId, userId, companyName, trade) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/job_contractors`, {
      method: "POST",
      headers: this._h(),
      body: JSON.stringify({ job_id: jobId, user_id: userId, company_name: companyName, trade: trade || null })
    })
    if (!r.ok) { const e = await r.text(); throw new Error(e) }
    const rows = await r.json()
    return rows[0]
  }

  async removeJobContractor(id) {
    await this._ensureFresh()
    // Soft delete — set is_active = false to preserve report history
    await fetch(`${SB_URL}/rest/v1/job_contractors?id=eq.${id}`, {
      method: "PATCH",
      headers: this._h(),
      body: JSON.stringify({ is_active: false })
    })
  }

  // ── TYR v3: Report Contractors ───────────────────────────────────
  async getReportContractors(reportId) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/report_contractors?report_id=eq.${reportId}&select=*`, {
      headers: this._h()
    })
    if (!r.ok) return []
    return await r.json()
  }

  async saveReportContractors(reportId, jobId, userId, contractors) {
    await this._ensureFresh()
    // Delete existing, then insert fresh
    await fetch(`${SB_URL}/rest/v1/report_contractors?report_id=eq.${reportId}`, {
      method: "DELETE",
      headers: this._h()
    })
    if (!contractors || contractors.length === 0) return
    const rows = contractors.map(c => ({
      report_id: reportId,
      job_id: jobId,
      user_id: userId,
      contractor_name: c.company_name,
      manpower: c.manpower || 0,
      hours_regular: c.hours_regular || 0,
      hours_overtime: c.hours_overtime || 0
    }))
    await fetch(`${SB_URL}/rest/v1/report_contractors`, {
      method: "POST",
      headers: this._h(),
      body: JSON.stringify(rows)
    })
  }

  async updateJobGeneralStatement(jobId, statement) {
    await this._ensureFresh()
    await fetch(`${SB_URL}/rest/v1/jobs?id=eq.${jobId}`, {
      method: "PATCH",
      headers: this._h(),
      body: JSON.stringify({ general_statement: statement })
    })
  }

  async updateJobWeatherEnabled(jobId, enabled) {
    await this._ensureFresh()
    await fetch(`${SB_URL}/rest/v1/jobs?id=eq.${jobId}`, {
      method: "PATCH",
      headers: this._h(),
      body: JSON.stringify({ weather_enabled: enabled })
    })
  }

  // ── Time Card ──────────────────────────────────────────────
  async fetchReportsForWeek(jobId, mondayDate, sundayDate) {
    await this._ensureFresh()
    // Include all reports for the date range (submitted, resubmitted, saved)
    // so that resubmissions always show up on the time card
    const r = await fetch(
      `${SB_URL}/rest/v1/reports?job_id=eq.${jobId}&report_date=gte.${mondayDate}&report_date=lte.${sundayDate}&select=id,report_date,content,status,updated_at&order=report_date.asc`,
      { headers: this._h() }
    )
    if (!r.ok) return []
    const data = await r.json()
    return data.map(rpt => ({
      ...rpt,
      content: typeof rpt.content === "string" ? JSON.parse(rpt.content) : rpt.content
    }))
  }

  async updateTimeCardSettings(jobId, settings) {
    await this._ensureFresh()
    const r = await fetch(`${SB_URL}/rest/v1/jobs?id=eq.${jobId}`, {
      method: "PATCH",
      headers: this._h(),
      body: JSON.stringify({
        timecard_enabled: settings.timecard_enabled,
        timecard_company_name: settings.timecard_company_name || null,
        timecard_project_number: settings.timecard_project_number || null,
        timecard_client_name: settings.timecard_client_name || null,
        timecard_position: settings.timecard_position || null
      })
    })
    if (!r.ok) { const e = await r.text(); throw new Error(e) }
  }

}

export const db = new Database()
