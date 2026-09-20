const { COLLECTIONS, MEMBER_ACTIVE_STATUSES } = require('./constants')
const { assert } = require('./errors')
const { getDocument, stableId } = require('./database')

function memberDocumentId(matchId, userId) {
  return stableId('match-member', matchId, userId)
}

async function getMatch(context, matchId, transaction) {
  const database = transaction || context.db
  return getDocument(database.collection(COLLECTIONS.matches).doc(matchId))
}

async function requireMatch(context, matchId, transaction) {
  const match = await getMatch(context, matchId, transaction)
  assert(match, 'NOT_FOUND', '球局不存在或已被删除')
  return match
}

async function getMembership(context, matchId, userId, transaction) {
  const database = transaction || context.db
  return getDocument(database.collection(COLLECTIONS.matchMembers).doc(memberDocumentId(matchId, userId)))
}

async function requireAcceptedMember(context, matchId) {
  const match = await requireMatch(context, matchId)
  const membership = await getMembership(context, matchId, context.openid)
  const active = membership && MEMBER_ACTIVE_STATUSES.includes(membership.status)
  assert(active || match.hostId === context.openid, 'FORBIDDEN', '加入球局后才可进行此操作')
  return { match, membership }
}

module.exports = {
  memberDocumentId,
  getMatch,
  requireMatch,
  getMembership,
  requireAcceptedMember
}
