import { AI_DESCRIBE_DAILY_LIMIT } from '../constants/labels'
export { AI_DESCRIBE_DAILY_LIMIT }

const _aiUsage = {}

function getAiUsageKey(jobId) {
  const d = new Date().toLocaleDateString("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  })
  return jobId + "_" + d
}

export function checkAiLimit(jobId) {
  const key = getAiUsageKey(jobId)
  return (_aiUsage[key] || 0) < AI_DESCRIBE_DAILY_LIMIT
}

export function getAiUsageCount(jobId) {
  return _aiUsage[getAiUsageKey(jobId)] || 0
}

export function incrementAiUsage(jobId) {
  const key = getAiUsageKey(jobId)
  _aiUsage[key] = (_aiUsage[key] || 0) + 1
  try { localStorage.setItem("mdr_ai_usage", JSON.stringify(_aiUsage)) } catch (e) { }
}

// Restore from localStorage on load
try {
  const stored = localStorage.getItem("mdr_ai_usage")
  if (stored) Object.assign(_aiUsage, JSON.parse(stored))
} catch (e) { }
