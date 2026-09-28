const validate = require('./validate')
const { assert } = require('./errors')
const { COLLECTIONS } = require('./constants')
const { getDocument } = require('./database')

function input(value, now = Date.now()) {
  validate.plainObject(value, '约球状态')
  const available = validate.boolean(value.available, '是否可约')
  const note = validate.text(value.note, '状态说明', { required: false, max: 100 })
  if (!available) return { available: false, note }
  const date = validate.date(value.date)
  const startTime = validate.time(value.startTime, '开始时间')
  const endTime = validate.time(value.endTime, '结束时间')
  const start = Date.parse(`${date}T${startTime}:00+08:00`)
  const end = Date.parse(`${date}T${endTime}:00+08:00`)
  assert(end > start, 'INVALID_ARGUMENT', '结束时间须晚于开始时间，跨天请分开设置')
  assert(end > now, 'INVALID_ARGUMENT', '这个时段已经结束，请选择新的时间')
  assert(start <= now + 30 * 86400000, 'INVALID_ARGUMENT', '请选择未来 30 天内的时间')
  return { available: true, date, startTime, endTime,
    venueId: validate.id(value.venueId, '约球球馆'),
    note,
    endAt: end }
}

async function prepare(context, value) {
  if (!value.available) return { available: false, note: value.note }
  const venue = await getDocument(context.db.collection(COLLECTIONS.venues).doc(value.venueId))
  assert(venue && venue.active === true && venue.verificationStatus === 'verified',
    'NOT_FOUND', '所选球馆已停止公开，请重新选择')
  return Object.assign({}, value, { venueName: venue.name, district: venue.district || '' })
}

function present(value, now = Date.now()) {
  if (value && value.available === false) return { available: false, note: value.note || '' }
  if (!value || value.available !== true || !Number.isFinite(value.endAt) || value.endAt <= now) return { available: false }
  return { available: true, date: value.date, startTime: value.startTime, endTime: value.endTime,
    venueId: value.venueId, venueName: value.venueName || '', district: value.district || '',
    note: value.note || '', endAt: value.endAt }
}
module.exports = { input, prepare, present }
