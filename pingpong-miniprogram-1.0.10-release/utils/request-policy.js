// Explicit allowlist: a newly added route is a write until classified here.
const READS = new Set([
  'venues.list', 'venues.nearby', 'venues.get', 'venues.submissions.list', 'venues.submissions.get', 'venuePhotos.list',
  'matches.list', 'matches.get', 'matches.pending', 'coaches.list', 'coaches.get',
  'coachApplications.get', 'appointments.list', 'favorites.list', 'favorites.status',
  'profile.get', 'players.get', 'friends.list', 'messages.list', 'messages.inbox',
  'safety.blocks.list', 'files.resolve', 'admin.venueSubmissions.pending', 'admin.venueSubmissions.get', 'admin.venuePhotos.pending',
  'admin.coachApplications.pending', 'admin.coachApplications.get', 'admin.venues.list', 'admin.coaches.list'
])
const REPLAYABLE = new Set(['bootstrap', 'matches.update', 'messages.send'])
function isRead(action) { return READS.has(action) }
function canRetry(action) { return isRead(action) || REPLAYABLE.has(action) }
function timeoutMs(action, options) {
  const value = Number(options.timeoutMs)
  if (Number.isFinite(value) && value > 0) return Math.min(60000, value)
  return isRead(action) ? 8000 : action === 'bootstrap' ? 12000 : 25000
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => { result[key] = canonical(value[key]); return result }, {})
  return value
}
function key(action, payload, options) {
  // The same route can return a deliberately reduced guest response or a
  // signed-in response with membership/personalization. Never coalesce them.
  return JSON.stringify([action, canonical(payload), options.publicRead === true, options.retry !== false, timeoutMs(action, options)])
}
module.exports = { isRead, canRetry, timeoutMs, key }
