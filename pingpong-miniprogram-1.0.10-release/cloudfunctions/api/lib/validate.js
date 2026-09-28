const { ApiError, assert } = require('./errors')
const { RATING_PLATFORMS } = require('./constants')
const playerLevels = require('./player-levels')

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

function plainObject(value, field = 'payload') {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} 格式不正确`)
  return value
}

function text(value, field, options = {}) {
  const { required = true, min = 0, max = 100 } = options
  if (value === undefined || value === null) {
    if (!required) return ''
    throw new ApiError('INVALID_ARGUMENT', `请填写${field}`)
  }
  assert(typeof value === 'string', 'INVALID_ARGUMENT', `${field}格式不正确`)
  const normalized = value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  assert(!required || normalized.length >= Math.max(1, min), 'INVALID_ARGUMENT', `请填写${field}`)
  assert(normalized.length >= min && normalized.length <= max, 'INVALID_ARGUMENT', `${field}长度需为 ${min}—${max} 个字符`)
  return normalized
}

function id(value, field = 'ID') {
  const normalized = text(value, field, { max: 80 })
  assert(ID_PATTERN.test(normalized), 'INVALID_ARGUMENT', `${field}格式不正确`)
  return normalized
}

function oneOf(value, allowed, field) {
  assert(allowed.includes(value), 'INVALID_ARGUMENT', `${field}不在允许范围内`)
  return value
}

function integer(value, field, options = {}) {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options
  const normalized = Number(value)
  assert(Number.isInteger(normalized) && normalized >= min && normalized <= max, 'INVALID_ARGUMENT', `${field}需为 ${min}—${max} 的整数`)
  return normalized
}

function number(value, field, options = {}) {
  const { min = -Infinity, max = Infinity } = options
  const normalized = Number(value)
  assert(Number.isFinite(normalized) && normalized >= min && normalized <= max, 'INVALID_ARGUMENT', `${field}数值不正确`)
  return normalized
}

function boolean(value, field) {
  assert(typeof value === 'boolean', 'INVALID_ARGUMENT', `${field}格式不正确`)
  return value
}

function date(value, field = '日期') {
  const normalized = text(value, field, { min: 10, max: 10 })
  assert(DATE_PATTERN.test(normalized), 'INVALID_ARGUMENT', `${field}格式应为 YYYY-MM-DD`)
  const parsed = new Date(`${normalized}T12:00:00+08:00`)
  assert(!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized, 'INVALID_ARGUMENT', `${field}不是有效日期`)
  return normalized
}

function time(value, field = '时间') {
  const normalized = text(value, field, { min: 5, max: 5 })
  assert(TIME_PATTERN.test(normalized), 'INVALID_ARGUMENT', `${field}格式应为 HH:mm`)
  return normalized
}

function timestamp(value, field = '时间游标') {
  let candidate = value
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (value.$date !== undefined) candidate = value.$date
    else if (Number.isFinite(value._seconds)) candidate = value._seconds * 1000
    else if (Number.isFinite(value.seconds)) candidate = value.seconds * 1000
  }
  const parsed = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate)
  assert(!Number.isNaN(parsed.getTime()), 'INVALID_ARGUMENT', `${field}格式不正确`)
  return parsed
}

function schedule(dateValue, startValue, endValue) {
  const dateText = date(dateValue)
  const startText = time(startValue, '开始时间')
  const endText = time(endValue, '结束时间')
  const startAt = new Date(`${dateText}T${startText}:00+08:00`)
  const endAt = new Date(`${dateText}T${endText}:00+08:00`)
  assert(endAt.getTime() > startAt.getTime(), 'INVALID_ARGUMENT', '结束时间必须晚于开始时间')
  assert(endAt.getTime() - startAt.getTime() >= 30 * 60 * 1000, 'INVALID_ARGUMENT', '球局时长至少需要 30 分钟')
  assert(endAt.getTime() - startAt.getTime() <= 6 * 60 * 60 * 1000, 'INVALID_ARGUMENT', '单场球局不能超过 6 小时')
  assert(startAt.getTime() >= Date.now() + 10 * 60 * 1000, 'INVALID_ARGUMENT', '开始时间至少应晚于当前时间 10 分钟')
  return { date: dateText, startTime: startText, endTime: endText, startAt, endAt }
}

function stringArray(value, field, options = {}) {
  const { required = false, maxItems = 8, itemMax = 20 } = options
  if ((value === undefined || value === null) && !required) return []
  assert(Array.isArray(value), 'INVALID_ARGUMENT', `${field}格式不正确`)
  assert(value.length <= maxItems, 'INVALID_ARGUMENT', `${field}最多 ${maxItems} 项`)
  const normalized = value.map((item) => text(item, field, { max: itemMax })).filter(Boolean)
  return Array.from(new Set(normalized))
}

function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return ''
  return id(value, field)
}

function pagination(payload) {
  return {
    page: integer(payload.page === undefined ? 1 : payload.page, '页码', { min: 1, max: 50 }),
    pageSize: integer(payload.pageSize === undefined ? 20 : payload.pageSize, '每页数量', { min: 1, max: 50 })
  }
}

function playingProfile(value) {
  plainObject(value, '技术档案')
  const allowed = playerLevels.EQUIPMENT.concat(playerLevels.TRAITS).map(item => item.key).concat('abilities')
  assert(Object.keys(value).every(key => allowed.includes(key)), 'INVALID_ARGUMENT', '技术档案包含未知字段')
  const result = {}
  playerLevels.EQUIPMENT.forEach(item => {
    result[item.key] = oneOf(value[item.key] === undefined ? '未填写' : value[item.key], item.options, item.label)
  })
  playerLevels.TRAITS.forEach(item => {
    const selected = value[item.key] === undefined ? [] : value[item.key]
    assert(Array.isArray(selected) && selected.length <= item.limit, 'INVALID_ARGUMENT', `${item.label}最多选择 ${item.limit} 项`)
    result[item.key] = Array.from(new Set(selected.map(option => oneOf(option, item.options, item.label))))
  })
  const abilities = value.abilities === undefined ? {} : plainObject(value.abilities, '能力项')
  const ids = playerLevels.ABILITY_GROUPS.flatMap(group => group.items.map(item => item.id))
  result.abilities = {}
  Object.keys(abilities).forEach(id => {
    assert(ids.includes(id), 'INVALID_ARGUMENT', '未知能力项')
    const state = abilities[id]
    assert(Number.isInteger(state) && state >= 0 && state < playerLevels.ABILITY_STATES.length, 'INVALID_ARGUMENT', '能力熟练度无效')
    if (state > 0) result.abilities[id] = state
  })
  return result
}

function profilePatch(payload) {
  plainObject(payload)
  const patch = {}
  if (payload.nearbyDiscovery !== undefined) patch.nearbyDiscovery = require('./nearby-discovery').input(payload.nearbyDiscovery)
  if (payload.availability !== undefined) patch.availability = require('./availability').input(payload.availability)
  if (payload.nickname !== undefined) patch.nickname = text(payload.nickname, '昵称', { min: 1, max: 20 })
  if (payload.city !== undefined) patch.city = text(payload.city, '城市', { min: 1, max: 20 })
  if (payload.district !== undefined) patch.district = text(payload.district, '地区', { required: false, max: 20 })
  if (payload.ballAge !== undefined) patch.ballAge = text(payload.ballAge, '球龄', { min: 1, max: 30 })
  if (payload.playingProfile !== undefined) patch.playingProfile = playingProfile(payload.playingProfile)
  if (payload.skills !== undefined) patch.skills = stringArray(payload.skills, '擅长技术', { required: true, maxItems: 6, itemMax: 16 })
  if (payload.ratingPlatform !== undefined) patch.ratingPlatform = oneOf(payload.ratingPlatform, RATING_PLATFORMS, '积分平台')
  if (payload.ratingValue !== undefined) {
    const rating = payload.ratingValue === '' ? '' : String(integer(payload.ratingValue, '第三方积分', { min: 1, max: 9999 }))
    patch.ratingValue = rating
  }
  assert(Object.keys(patch).length > 0, 'INVALID_ARGUMENT', '没有可更新的资料')
  if (patch.ratingPlatform === '未填写') patch.ratingValue = ''
  return patch
}

module.exports = {
  plainObject,
  text,
  id,
  optionalId,
  oneOf,
  integer,
  number,
  boolean,
  date,
  time,
  timestamp,
  schedule,
  stringArray,
  pagination,
  profilePatch
}
