// Local, bounded timing samples only. Never record payloads, identities or URLs.
const samples = []
const LIMIT = 80

function record(value) {
  samples.push({
    action: String(value.action || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60),
    durationMs: Math.max(0, Math.round(Number(value.durationMs) || 0)),
    attempts: Math.max(0, Number(value.attempts) || 0),
    code: String(value.code || 'OK').replace(/[^A-Z0-9_]/g, '').slice(0, 40),
    at: Date.now()
  })
  if (samples.length > LIMIT) samples.splice(0, samples.length - LIMIT)
}

function snapshot() {
  const groups = {}
  for (const sample of samples) {
    const group = groups[sample.action] || (groups[sample.action] = [])
    group.push(sample)
  }
  const summary = Object.entries(groups).map(([action, values]) => {
    const durations = values.map(value => value.durationMs).sort((a, b) => a - b)
    const percentile = p => durations[Math.max(0, Math.ceil(durations.length * p) - 1)]
    return { action, count: values.length, failed: values.filter(value => value.code !== 'OK').length, p50Ms: percentile(.5), p95Ms: percentile(.95) }
  })
  return { samples: samples.map(value => Object.assign({}, value)), summary }
}

function clear() { samples.length = 0 }
module.exports = { record, snapshot, clear }
