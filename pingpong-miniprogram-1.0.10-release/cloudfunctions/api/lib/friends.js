const { COLLECTIONS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const presenters = require('./presenters')
const { stableId, getDocument } = require('./database')

const FRIEND_BATCH_SIZE = 10
const RECENT_MATCH_LIMIT = 20

function friendshipId(userId, friendId) {
  return stableId('player-friend', userId, friendId)
}

async function upsertDirection(context, transaction, userId, friendId, matchId) {
  const ref = transaction.collection(COLLECTIONS.playerFriends).doc(friendshipId(userId, friendId))
  const existing = await getDocument(ref)
  const recentMatchIds = Array.isArray(existing && existing.recentMatchIds)
    ? existing.recentMatchIds.filter(Boolean)
    : existing && existing.latestMatchId ? [existing.latestMatchId] : []
  const seenMatch = recentMatchIds.includes(matchId)
  const nextMatchIds = seenMatch
    ? recentMatchIds
    : recentMatchIds.concat([matchId]).slice(-RECENT_MATCH_LIMIT)
  await ref.set({ data: {
    userId,
    friendId,
    firstMatchId: existing && existing.firstMatchId || matchId,
    latestMatchId: matchId,
    recentMatchIds: nextMatchIds,
    matchCount: Math.max(1, Number(existing && existing.matchCount || 0) + (seenMatch ? 0 : 1)),
    createdAt: existing && existing.createdAt || context.serverDate(),
    updatedAt: context.serverDate()
  } })
}

async function linkJoinedPlayer(context, transaction, match, userId) {
  const participantIds = Array.isArray(match.participantIds) ? match.participantIds : []
  const unique = Array.from(new Set(participantIds.filter(participantId => participantId && participantId !== userId)))
  for (const participantId of unique) {
    await upsertDirection(context, transaction, userId, participantId, match._id)
    await upsertDirection(context, transaction, participantId, userId, match._id)
  }
}

async function blockedUserIds(context) {
  const [outgoing, incoming] = await Promise.all([
    context.db.collection(COLLECTIONS.userBlocks).where({ userId: context.openid, active: true }).limit(100).get(),
    context.db.collection(COLLECTIONS.userBlocks).where({ targetUserId: context.openid, active: true }).limit(100).get()
  ])
  return new Set(outgoing.data.map(item => item.targetUserId).concat(incoming.data.map(item => item.userId)))
}

async function ids(context, options = {}) {
  assert(context.openid && !context.publicRead && context.user, 'LOGIN_REQUIRED', '登录后才能查看球友局')
  const cap = Math.min(500, Math.max(1, Number(options.limit || 200)))
  const result = await context.db.collection(COLLECTIONS.playerFriends)
    .where({ userId: context.openid })
    .orderBy('updatedAt', 'desc')
    .limit(cap)
    .get()
  const blocked = options.blocked || await blockedUserIds(context)
  return new Set(result.data.map(item => item.friendId).filter(friendId => friendId && !blocked.has(friendId)))
}

async function usersByIds(context, userIds) {
  const users = []
  for (let index = 0; index < userIds.length; index += FRIEND_BATCH_SIZE) {
    const batch = userIds.slice(index, index + FRIEND_BATCH_SIZE)
    const result = await context.db.collection(COLLECTIONS.users)
      .where({ _id: context.command.in(batch), status: 'active' })
      .limit(batch.length)
      .get()
    users.push(...result.data)
  }
  return users
}

async function list(context, payload) {
  const paging = validate.pagination(payload)
  const result = await context.db.collection(COLLECTIONS.playerFriends)
    .where({ userId: context.openid })
    .orderBy('updatedAt', 'desc')
    .skip((paging.page - 1) * paging.pageSize)
    .limit(paging.pageSize + 1)
    .get()
  const blocked = await blockedUserIds(context)
  const visibleRelationships = result.data.filter(item => item.friendId && !blocked.has(item.friendId))
  const visiblePage = visibleRelationships.slice(0, paging.pageSize)
  const users = await usersByIds(context, visiblePage.map(item => item.friendId))
  const usersById = Object.fromEntries(users.map(user => [user._id, user]))
  const items = visiblePage.map(relationship => {
    const user = usersById[relationship.friendId]
    if (!user) return null
    const profile = presenters.userProfile(user)
    return {
      player: {
        playerId: user.publicId,
        displayName: profile.nickname,
        avatarFileId: profile.avatarFileId,
        city: profile.city,
        district: profile.district,
        ballAge: profile.ballAge,
        skills: profile.skills,
        ratingPlatform: profile.ratingPlatform,
        ratingValue: profile.ratingValue
      },
      matchCount: Math.max(1, Number(relationship.matchCount || 1)),
      latestMatchId: relationship.latestMatchId || '',
      becameFriendsAt: relationship.createdAt,
      updatedAt: relationship.updatedAt
    }
  }).filter(Boolean)
  return {
    items,
    page: paging.page,
    pageSize: paging.pageSize,
    hasMore: result.data.length > paging.pageSize
  }
}

module.exports = {
  list,
  ids,
  linkJoinedPlayer,
  _private: { friendshipId, upsertDirection }
}
