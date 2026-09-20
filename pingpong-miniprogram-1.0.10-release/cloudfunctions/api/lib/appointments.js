const { COLLECTIONS, MATCH_ACTIVE_STATUSES } = require('./constants')
const validate = require('./validate')
const presenters = require('./presenters')

function chunks(items, size) {
  const result = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

function publicMatch(document) {
  return MATCH_ACTIVE_STATUSES.includes(document.status) && new Date(document.startAt).getTime() > Date.now()
}

function retainedMember(document, membership, openid) {
  if (document.hostId === openid) return true
  if (['host', 'joined'].includes(membership.status)) return true
  return membership.status === 'cancelled' && membership.wasAccepted === true
}

function matchForAppointment(document, membership, openid) {
  if (publicMatch(document) || retainedMember(document, membership, openid)) return presenters.match(document)
  return presenters.match(Object.assign({}, document, {
    participants: [],
    participantIds: [],
    hostSnapshot: { playerId: '', displayName: '球友' },
    note: '',
    courtBookingNote: ''
  }))
}

async function fetchMatches(context, ids) {
  const results = await Promise.all(chunks(ids, 20).map((group) => (
    context.db.collection(COLLECTIONS.matches).where({ _id: context.command.in(group) }).get()
  )))
  return results.flatMap((item) => item.data)
}

async function list(context, payload) {
  const pageSize = validate.integer(payload.pageSize === undefined ? 30 : payload.pageSize, '每页数量', { min: 1, max: 50 })
  const [memberResult, bookingResult] = await Promise.all([
    context.db.collection(COLLECTIONS.matchMembers).where({ userId: context.openid }).orderBy('updatedAt', 'desc').limit(pageSize).get(),
    context.db.collection(COLLECTIONS.coachBookings).where({ userId: context.openid }).orderBy('updatedAt', 'desc').limit(pageSize).get()
  ])
  const matchIds = Array.from(new Set(memberResult.data.map((item) => item.matchId)))
  const matchDocuments = matchIds.length ? await fetchMatches(context, matchIds) : []
  const matchesById = Object.fromEntries(matchDocuments.map((item) => [item._id, item]))
  const matchItems = memberResult.data.map((membership) => {
    const document = matchesById[membership.matchId]
    if (!document) return null
    let status = membership.status
    if (document.status === 'cancelled') status = 'cancelled'
    else if (['host', 'joined'].includes(status) && Number(membership.confirmedScheduleVersion || 0) < Number(document.scheduleVersion || 1)) status = 'schedule_confirmation_required'
    return {
      id: `match_${membership._id}`,
      type: 'match',
      status,
      membershipStatus: membership.status,
      confirmedScheduleVersion: Number(membership.confirmedScheduleVersion || 0),
      match: matchForAppointment(document, membership, context.openid),
      updatedAt: membership.updatedAt
    }
  }).filter(Boolean)
  const coachItems = bookingResult.data.map((document) => ({
    id: `coach_${document._id}`,
    type: 'coach',
    status: document.status,
    booking: presenters.booking(document),
    updatedAt: document.updatedAt
  }))
  return { items: matchItems.concat(coachItems).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, pageSize) }
}

module.exports = { list }
