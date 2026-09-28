const { COLLECTIONS } = require('./constants')
const validate = require('./validate')
const presenters = require('./presenters')
const { getDocument } = require('./database')
const { assert } = require('./errors')

const COACH_LIST_FIELDS = {
  _id: true, name: true, avatarFileId: true, city: true, district: true,
  venueIds: true, specialty: true, introduction: true, experienceYears: true,
  qualification: true, rating: true, completedSessions: true,
  verificationStatus: true, verificationDate: true
}
const COACH_SLOT_FIELDS = {
  _id: true, coachId: true, venueId: true, startAt: true, endAt: true,
  price: true, bookedCount: true, capacity: true, version: true
}

function selectFields(query, fields) {
  return query && typeof query.field === 'function' ? query.field(fields) : query
}

async function list(context, payload) {
  const paging = validate.pagination(payload)
  const condition = {
    active: true,
    verificationStatus: 'verified',
    city: payload.city ? validate.text(payload.city, '城市', { max: 20 }) : '杭州'
  }
  if (payload.district) condition.district = validate.text(payload.district, '地区', { max: 20 })
  if (payload.venueId) condition.venueIds = validate.id(payload.venueId, '球馆 ID')
  const coachQuery = context.db.collection(COLLECTIONS.coaches)
    .where(condition)
    .orderBy('featuredRank', 'asc')
    .skip((paging.page - 1) * paging.pageSize)
    .limit(paging.pageSize)
  const result = await selectFields(coachQuery, COACH_LIST_FIELDS).get()
  const coachIds = result.data.map((item) => item._id)
  let slots = []
  if (coachIds.length) {
    const groups = []
    for (let index = 0; index < coachIds.length; index += 20) groups.push(coachIds.slice(index, index + 20))
    const slotResults = await Promise.all(groups.map((group) => {
      const slotQuery = context.db.collection(COLLECTIONS.coachSlots).where({
        coachId: context.command.in(group),
        status: 'open',
        startAt: context.command.gte(new Date())
      }).orderBy('startAt', 'asc').limit(100)
      return selectFields(slotQuery, COACH_SLOT_FIELDS).get()
    }))
    slots = slotResults.flatMap((item) => item.data)
  }
  const items = result.data.map((item) => Object.assign(presenters.coach(item), {
      nextSlots: slots.filter((slot) => slot.coachId === item._id && Number(slot.bookedCount || 0) < Number(slot.capacity || 1)).slice(0, 6).map((slot) => ({
        id: slot._id,
        venueId: slot.venueId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        price: Number(slot.price || 0),
        remaining: Math.max(0, Number(slot.capacity || 1) - Number(slot.bookedCount || 0)),
        version: Number(slot.version || 1)
      }))
    })).filter((item) => item.nextSlots.length)
  return {
    items,
    page: paging.page,
    pageSize: paging.pageSize
  }
}

async function get(context, payload) {
  const coachId = validate.id(payload.coachId, '教练 ID')
  const coach = await getDocument(context.db.collection(COLLECTIONS.coaches).doc(coachId))
  assert(coach && coach.active && coach.verificationStatus === 'verified', 'NOT_FOUND', '教练不存在或暂不可约')
  const slotResult = await context.db.collection(COLLECTIONS.coachSlots).where({
    coachId,
    status: 'open',
    startAt: context.command.gte(new Date())
  }).orderBy('startAt', 'asc').limit(100).get()
  return {
    coach: presenters.coach(coach),
    slots: slotResult.data.filter((slot) => Number(slot.bookedCount || 0) < Number(slot.capacity || 1)).map((slot) => ({
      id: slot._id,
      venueId: slot.venueId,
      startAt: slot.startAt,
      endAt: slot.endAt,
      price: Number(slot.price || 0),
      remaining: Math.max(0, Number(slot.capacity || 1) - Number(slot.bookedCount || 0)),
      version: Number(slot.version || 1)
    }))
  }
}

module.exports = { list, get }
