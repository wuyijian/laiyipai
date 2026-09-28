const validate = require('./validate')
const { assert } = require('./errors')
const DAY = 86400000
function point(value) {
  validate.plainObject(value, '模糊位置')
  for (const key of ['latitude', 'longitude']) assert(typeof value[key] === 'number' && Number.isFinite(value[key]), 'INVALID_ARGUMENT', '模糊位置无效')
  const latitude = validate.number(value.latitude, '纬度', { min: -90, max: 90 })
  const longitude = validate.number(value.longitude, '经度', { min: -180, max: 180 })
  // Further reduce precision to a coarse grid, even if a client sends exact GPS.
  return { latitude: Math.round(latitude * 100) / 100, longitude: Math.round(longitude * 100) / 100 }
}
function input(value, now = Date.now()) {
  validate.plainObject(value, '附近展示')
  if (!validate.boolean(value.enabled, '在附近展示')) return { enabled: false, point: null, expiresAt: 0 }
  return { enabled: true, point: point(value), expiresAt: now + DAY }
}
function visible(value, now = Date.now()) {
  return Boolean(value && value.enabled === true && Number.isFinite(value.expiresAt) &&
    value.expiresAt > now && value.expiresAt <= now + DAY && value.point &&
    Number.isFinite(value.point.latitude) && Number.isFinite(value.point.longitude))
}
function status(value) { return visible(value) ? { enabled: true, expiresAt: value.expiresAt } : { enabled: false } }
function query(value) {
  const location = point(value)
  const radiusMeters = validate.oneOf(value.radiusMeters === undefined ? 20000 : value.radiusMeters, [5000, 10000, 20000, 50000], '附近范围')
  return Object.assign(location, { radiusMeters })
}
function distance(from, to) {
  const rad = degrees => degrees * Math.PI / 180
  const a = Math.sin(rad(to.latitude - from.latitude) / 2) ** 2 +
    Math.cos(rad(from.latitude)) * Math.cos(rad(to.latitude)) * Math.sin(rad(to.longitude - from.longitude) / 2) ** 2
  return 6371000 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)))
}
function match(query, value) {
  if (!visible(value)) return ''
  const meters = distance(query, value.point)
  if (meters > query.radiusMeters) return ''
  return meters < 1000 ? '约 1 公里内' : '约 ' + Math.round(meters / 1000) + ' 公里'
}
module.exports = { input, status, query, match, point }
