const storage = require('./storage')
const matchOptions = require('./match-options')
let homeDestination = ''
let joinRequestsDestination = false

function requestJoinRequests() { joinRequestsDestination = true }
function consumeJoinRequestsDestination() {
  const value = joinRequestsDestination
  joinRequestsDestination = false
  return value
}

function requestVenueDiscovery() { homeDestination = 'venues' }
function consumeHomeDestination() {
  const value = homeDestination
  homeDestination = ''
  return value
}

const KEYS = Object.freeze({
  homeFilters: 'laiyipai_ui_home_filters_v1',
  publishDraft: 'laiyipai_ui_publish_draft_v2',
  publishPrefill: 'laiyipai_ui_publish_prefill_v2'
})

function readObject(key, fallback = {}) {
  const value = storage.read(key, fallback)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

function getHomeFilters() {
  return readObject(KEYS.homeFilters)
}

function saveHomeFilters(filters) {
  return storage.write(KEYS.homeFilters, Object.assign({}, filters))
}

function getPublishDraft() {
  const value = storage.read(KEYS.publishDraft, null)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function hasPublishDraft() {
  return Boolean(getPublishDraft())
}

function savePublishDraft(draft) {
  return storage.write(KEYS.publishDraft, Object.assign({}, draft, {
    savedAt: new Date().toISOString()
  }))
}

function clearPublishDraft() {
  storage.remove(KEYS.publishDraft)
}

function setPublishPrefill(prefill) {
  const value = Object.assign({}, prefill)
  storage.remove(KEYS.publishPrefill)
  storage.write(KEYS.publishPrefill, value)
  const stored = storage.read(KEYS.publishPrefill, null)
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : false
}

function setRebookPrefill(match = {}) {
  const capacityValue = Number(match.capacity)
  const capacity = Number.isInteger(capacityValue) && capacityValue >= 1
    ? Math.min(8, capacityValue)
    : matchOptions.DEFAULT_CAPACITY
  const feeValue = Number(match.feePerPerson)
  const feePerPerson = Number.isInteger(feeValue) ? Math.min(999, Math.max(0, feeValue)) : 0
  const prefill = {
    kind: 'rebook',
    venueId: typeof match.venueId === 'string' ? match.venueId : '',
    title: typeof match.title === 'string' ? match.title.slice(0, 30) : '',
    capacity,
    expectedBallAge: typeof match.expectedBallAge === 'string' ? match.expectedBallAge : '不限球龄',
    practiceIntent: matchOptions.normalizePracticeIntent(match.practiceIntent, match.skills),
    joinMode: capacity === 1 || match.joinMode !== 'confirm' ? 'direct' : 'confirm',
    feePerPerson
  }
  return setPublishPrefill(prefill)
}

function consumePublishPrefill() {
  const value = storage.read(KEYS.publishPrefill, null)
  storage.remove(KEYS.publishPrefill)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function clear() {
  homeDestination = ''
  joinRequestsDestination = false
  Object.keys(KEYS).forEach((name) => storage.remove(KEYS[name]))
}

module.exports = {
  requestJoinRequests,
  consumeJoinRequestsDestination,
  requestVenueDiscovery,
  consumeHomeDestination,
  getHomeFilters,
  saveHomeFilters,
  getPublishDraft,
  hasPublishDraft,
  savePublishDraft,
  clearPublishDraft,
  setPublishPrefill,
  setRebookPrefill,
  consumePublishPrefill,
  clear
}
