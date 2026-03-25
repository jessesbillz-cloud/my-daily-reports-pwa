/**
 * api.js — Typed API client for all Supabase edge function calls.
 *
 * RULES:
 * 1. ALL edge function calls go through this module. No exceptions.
 * 2. Each function validates its inputs before sending.
 * 3. Every response is checked — no silent failures.
 * 4. Raw fetch() to edge functions is BANNED outside this file.
 *
 * Usage:
 *   import { api } from '../utils/api'
 *   const result = await api.updateInspection.edit({ request_id, new_date, new_time })
 */

import { SB_URL } from '../constants/supabase'
import { authFetch, authStorageUpload } from './auth'

// ── Helpers ──────────────────────────────────────────────────────

function required(val, name) {
  if (val === undefined || val === null || val === '') {
    throw new Error(`api: missing required field "${name}"`)
  }
  return val
}

// ── Response Guards ──────────────────────────────────────────────
// Validate shape of data coming BACK from the server.
// Catches "bad data entering the system" before it silently propagates.

function assertJob(row) {
  if (!row || typeof row !== 'object') throw new Error('Invalid job: not an object')
  if (!row.id) throw new Error('Invalid job: missing id')
  // Normalize is_archived to strict boolean — handles null, "false", "true", 0, 1
  if (row.is_archived !== undefined) {
    row.is_archived = row.is_archived === true || row.is_archived === 'true' || row.is_archived === 't'
  }
  return row
}

function assertProfile(row) {
  if (!row || typeof row !== 'object') throw new Error('Invalid profile: not an object')
  if (!row.id) throw new Error('Invalid profile: missing id')
  return row
}

function assertRequest(row) {
  if (!row || typeof row !== 'object') throw new Error('Invalid request: not an object')
  if (!row.id) throw new Error('Invalid request: missing id')
  return row
}

function assertTemplate(row) {
  if (!row || typeof row !== 'object') throw new Error('Invalid template: not an object')
  if (!row.id) throw new Error('Invalid template: missing id')
  return row
}

// Map table name → guard function
const guards = {
  jobs: assertJob,
  profiles: assertProfile,
  inspection_requests: assertRequest,
  templates: assertTemplate
}

// ── Logging ──────────────────────────────────────────────────────

function logAPI(tag, detail) {
  console.log(`[API] ${tag}`, detail)
}

// ── Core fetch wrappers ─────────────────────────────────────────

async function postEdge(fnName, body, opts = {}) {
  const url = `${SB_URL}/functions/v1/${fnName}`
  const isFormData = body instanceof FormData
  logAPI(fnName, isFormData ? '(FormData)' : body)
  const fetchOpts = {
    method: 'POST',
    ...(isFormData
      ? { body }
      : { body: JSON.stringify(body) }),
    ...opts
  }
  const r = await authFetch(url, fetchOpts)
  // Always parse response — no silent failures
  const data = await r.json().catch(() => ({ _parseError: true }))
  if (!r.ok) {
    const msg = data?.error || data?.message || `${fnName} failed (${r.status})`
    console.error(`[API] ${fnName} FAILED`, r.status, data)
    throw new Error(msg)
  }
  return data
}

async function patchRest(table, filter, updates, opts = {}) {
  const url = `${SB_URL}/rest/v1/${table}?${filter}`
  logAPI(`PATCH ${table}`, { filter, updates })
  const r = await authFetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...(opts.headers || {})
    },
    body: JSON.stringify(updates)
  })
  const text = await r.text().catch(() => '')
  logAPI(`PATCH ${table} response`, { status: r.status, body: text.substring(0, 500) })
  let data
  try { data = JSON.parse(text) } catch (e) { data = [] }
  if (!r.ok) {
    console.error(`[API] PATCH ${table} FAILED`, r.status, data)
    throw new Error(`PATCH ${table} failed (${r.status}): ${text.substring(0, 200)}`)
  }
  // Supabase returns array with Prefer: return=representation
  // If we got a non-array or empty array, the filter matched nothing (possible RLS issue)
  if (!Array.isArray(data) || data.length === 0) {
    console.warn(`[API] PATCH ${table} — empty response`, { filter, updates, status: r.status, text })
    throw new Error(`PATCH ${table}: no rows matched filter "${filter}" (got ${text.substring(0, 100)})`)
  }
  // Run response guard if one exists for this table
  const guard = guards[table]
  if (guard) {
    data.forEach(row => guard(row))
  }
  return data
}

// ── Edge Function APIs ───────────────────────────────────────────

export const api = {

  // ── update-inspection ──
  updateInspection: {
    schedule({ request_id }) {
      required(request_id, 'request_id')
      return postEdge('update-inspection', { request_id, action: 'schedule' })
    },

    cancel({ request_id, action_by, reason }) {
      required(request_id, 'request_id')
      required(action_by, 'action_by')
      return postEdge('update-inspection', {
        request_id, action: 'cancel', action_by, reason: reason || ''
      })
    },

    edit({ request_id, action_by, new_date, new_time, new_duration, new_notes }) {
      required(request_id, 'request_id')
      required(action_by, 'action_by')
      if (!new_date && !new_time && !new_duration && new_notes === undefined) {
        throw new Error('api.updateInspection.edit: must provide at least one of new_date, new_time, new_duration, new_notes')
      }
      const body = { request_id, action: 'edit', action_by }
      if (new_date) body.new_date = new_date
      if (new_time) body.new_time = new_time
      if (new_duration) body.new_duration = new_duration
      if (new_notes !== undefined) body.new_notes = new_notes
      return postEdge('update-inspection', body)
    },

    delete({ request_id, action_by }) {
      required(request_id, 'request_id')
      return postEdge('update-inspection', {
        request_id, action: 'delete', action_by: action_by || 'Admin'
      })
    }
  },

  // ── submit-inspection ──
  submitInspection(formData) {
    if (!(formData instanceof FormData)) {
      throw new Error('api.submitInspection: expected FormData')
    }
    return postEdge('submit-inspection', formData)
  },

  // ── send-report ──
  sendReport(body) {
    required(body.to, 'to')
    required(body.subject, 'subject')
    return postEdge('send-report', body)
  },

  // ── describe-photo ──
  describePhoto(body) {
    if (!body || typeof body !== 'object') {
      throw new Error('api.describePhoto: expected object with image_base64')
    }
    // Accept both FormData and plain objects; edge function expects JSON
    if (body instanceof FormData) {
      // Convert FormData to plain object for JSON edge function
      const obj = {}
      for (const [k, v] of body.entries()) obj[k] = v
      return postEdge('describe-photo', obj)
    }
    return postEdge('describe-photo', body)
  },

  // ── generate-docx ──
  async generateDocx(body) {
    // This returns a raw Response (not JSON) — caller handles .json()
    const url = `${SB_URL}/functions/v1/generate-docx`
    logAPI('generate-docx', { keys: Object.keys(body) })
    const r = await authFetch(url, {
      method: 'POST',
      body: JSON.stringify(body)
    })
    if (!r.ok) {
      const err = await r.text().catch(() => 'Unknown error')
      console.error('[API] generate-docx FAILED', r.status, err)
      throw new Error(`generate-docx failed (${r.status})`)
    }
    return r
  },

  // ── parse-template ──
  parseTemplate(body) {
    if (!body || typeof body !== 'object') {
      throw new Error('api.parseTemplate: expected object with text_items or docx_base64')
    }
    return postEdge('parse-template', body)
  },

  // ── create-checkout ──
  createCheckout(body) {
    return postEdge('create-checkout', body)
  },

  // ── manage-subscription ──
  manageSubscription(body) {
    return postEdge('manage-subscription', body)
  },

  // ── delete-account ──
  deleteAccount(body) {
    return postEdge('delete-account', body)
  },

  // ── Storage uploads ──
  uploadStorage(storagePath, blob, contentType) {
    required(storagePath, 'storagePath')
    logAPI('uploadStorage', { storagePath, contentType, size: blob?.size })
    return authStorageUpload(storagePath, blob, contentType)
  },

  // ── REST API (direct table ops) ──
  rest: {
    patchJob(jobId, updates) {
      required(jobId, 'jobId')
      return patchRest('jobs', `id=eq.${jobId}`, updates)
    },

    patchProfile(userId, updates) {
      required(userId, 'userId')
      return patchRest('profiles', `id=eq.${userId}`, updates)
    },

    patchRequest(requestId, updates) {
      required(requestId, 'requestId')
      return patchRest('inspection_requests', `id=eq.${requestId}`, updates)
    },

    patchTemplate(templateId, updates) {
      required(templateId, 'templateId')
      return patchRest('templates', `id=eq.${templateId}`, updates)
    },

    patchTemplateByJob(jobId, updates) {
      required(jobId, 'jobId')
      return patchRest('templates', `job_id=eq.${jobId}`, updates)
    }
  }
}
