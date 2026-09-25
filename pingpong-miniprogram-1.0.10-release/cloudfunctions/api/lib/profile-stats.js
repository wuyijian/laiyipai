const { COLLECTIONS, MATCH_ACTIVE_STATUSES } = require('./constants')
const { ApiError } = require('./errors')

const PAGE_SIZE = 100
const MATCH_BATCH_SIZE = 20
const COUNTABLE_STATUSES = new Set(MATCH_ACTIVE_STATUSES.concat(['started', 'completed']))
const MEMBER_FIELDS = { matchId: true, status: true, confirmedScheduleVersion: true }
const MATCH_FIELDS = {
  _id: true, hostId: true, status: true, startAt: true, endAt: true,
  participantCount: true, scheduleVersion: true
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return NaN
  return new Date(value).getTime()
}

function chinaMonth(value) {
  return new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, 7)
}

function countable(match, membership, now) {
  if (!match || !['host', 'joined'].includes(membership.status)) return false
  if (!COUNTABLE_STATUSES.has(match.status) || Number(match.participantCount) < 2 || !Number.isFinite(Number(match.participantCount))) return false
  const start = timestamp(match.startAt)
  const end = timestamp(match.endAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > now) return false
  // Older memberships predate schedule confirmation. They remain valid only
  // for an unchanged first schedule; unconfirmed reschedules must not count.
  const scheduleVersion = Number(match.scheduleVersion || 1)
  const confirmedVersion = membership.confirmedScheduleVersion === undefined
    ? 1 : Number(membership.confirmedScheduleVersion)
  return Number.isFinite(confirmedVersion) && confirmedVersion >= scheduleVersion
}

async function get(context) {
  if (!context.openid || !context.user || context.publicRead) {
    throw new ApiError('UNAUTHENTICATED', '请先登录后查看约球统计')
  }
  const now = Date.now()
  const month = chinaMonth(now)
  const result = { historyCount: 0, monthCount: 0, hostedCount: 0, month, asOf: new Date(now).toISOString(), basis: 'ended_confirmed_registration_v1' }
  const seen = new Set()

  // Reuse the existing user_updated index. Read only this caller's small
  // membership projection, not appointments.list's latest-50 window and not
  // the whole matches collection. At most five batched match reads at a time.
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await context.db.collection(COLLECTIONS.matchMembers)
      .where({ userId: context.openid }).orderBy('updatedAt', 'desc')
      .skip(offset).limit(PAGE_SIZE).field(MEMBER_FIELDS).get()
    const memberships = []
    for (const member of page.data) {
      if (!member.matchId || seen.has(member.matchId)) continue
      seen.add(member.matchId)
      if (['host', 'joined'].includes(member.status)) memberships.push(member)
    }
    const batches = []
    for (let index = 0; index < memberships.length; index += MATCH_BATCH_SIZE) {
      batches.push(memberships.slice(index, index + MATCH_BATCH_SIZE))
    }
    const matchResults = await Promise.all(batches.map(batch => context.db.collection(COLLECTIONS.matches)
      .where({ _id: context.command.in(batch.map(member => member.matchId)) })
      .field(MATCH_FIELDS).limit(MATCH_BATCH_SIZE).get()))
    const matches = new Map(matchResults.flatMap(page => page.data).map(match => [match._id, match]))
    for (const member of memberships) {
      const match = matches.get(member.matchId)
      if (!countable(match, member, now)) continue
      result.historyCount += 1
      if (chinaMonth(timestamp(match.startAt)) === month) result.monthCount += 1
      if (match.hostId === context.openid) result.hostedCount += 1
    }
    if (page.data.length < PAGE_SIZE) break
  }
  return result
}

module.exports = { get, _private: { countable, chinaMonth } }
