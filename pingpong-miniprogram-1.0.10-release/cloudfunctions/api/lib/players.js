const { COLLECTIONS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const presenters = require('./presenters')
const { stableId, getDocument } = require('./database')

async function get(context, payload) {
  const playerId = validate.id(payload.playerId, '球友 ID')
  const result = await context.db.collection(COLLECTIONS.users)
    .where({ publicId: playerId, status: 'active' })
    .limit(1)
    .get()
  const target = result.data[0]
  assert(target, 'NOT_FOUND', '球友资料不存在或已停止公开')

  if (context.openid && target._id !== context.openid) {
    const [outgoing, incoming] = await Promise.all([
      getDocument(context.db.collection(COLLECTIONS.userBlocks).doc(stableId('user-block', context.openid, target._id))),
      getDocument(context.db.collection(COLLECTIONS.userBlocks).doc(stableId('user-block', target._id, context.openid)))
    ])
    assert(!(outgoing && outgoing.active) && !(incoming && incoming.active), 'NOT_FOUND', '球友资料不存在或不可见')
  }

  const profile = presenters.userProfile(target)
  return {
    player: {
      playerId: target.publicId,
      displayName: profile.nickname,
      avatarFileId: profile.avatarFileId,
      city: profile.city,
      district: profile.district,
      ballAge: profile.ballAge,
      skills: profile.skills,
      ratingPlatform: profile.ratingPlatform,
      ratingValue: profile.ratingValue
    },
    // Compatibility for older clients without exposing retained legacy media.
    videos: [],
    isSelf: Boolean(!context.publicRead && context.openid && target._id === context.openid)
  }
}

module.exports = { get }
