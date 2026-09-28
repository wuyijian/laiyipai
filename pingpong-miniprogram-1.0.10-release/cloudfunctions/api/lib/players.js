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
      ratingValue: profile.ratingValue,
      playingProfile: profile.playingProfile,
      ratingStatus: profile.ratingStatus,
      ratingUpdatedAt: profile.ratingUpdatedAt,
      availability: profile.availability
    },
    // Compatibility for older clients without exposing retained legacy media.
    videos: [],
    isSelf: Boolean(!context.publicRead && context.openid && target._id === context.openid)
  }
}

// Resolve only candidate block IDs. This stays correct even with >100 blocks.
async function blockedIds(context, users) {
  const blocked = new Set()
  if (!context.openid) return blocked
  const owners = new Map()
  users.filter(user => user._id !== context.openid).forEach(user => {
    owners.set(stableId('user-block', context.openid, user._id), user._id)
    owners.set(stableId('user-block', user._id, context.openid), user._id)
  })
  const ids = Array.from(owners.keys())
  // Five chunks at most for each 50-user batch; avoid five serial round trips.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const requests = []
    for (let index = offset; index < Math.min(offset + 100, ids.length); index += 20) {
      requests.push(context.db.collection(COLLECTIONS.userBlocks)
        .where({ _id: context.command.in(ids.slice(index, index + 20)), active: true })
        .field({ _id: true }).limit(20).get())
    }
    const results = await Promise.all(requests)
    results.forEach(rows => rows.data.forEach(row => blocked.add(owners.get(row._id))))
  }
  return blocked
}

async function list(context, payload) {
  const levels = require('./player-levels')
  const districts = require('./constants').HANGZHOU_DISTRICTS
  const grade = validate.oneOf(payload.grade || '', ['', 'pending'].concat(levels.LEVEL_BANDS.map(item => item.code)), '等级')
  const district = validate.oneOf(payload.district || '', [''].concat(districts), '行政区')
  const availability = validate.oneOf(payload.availability || '', ['', 'available', 'unavailable'], '约球状态')
  const nearbyDiscovery = require('./nearby-discovery')
  const nearby = payload.nearby === undefined ? null : nearbyDiscovery.query(payload.nearby)
  const pageSize = validate.integer(payload.pageSize === undefined ? 20 : payload.pageSize, '每页数量', { min: 1, max: 20 })
  let cursor = payload.cursor ? validate.id(payload.cursor, '分页游标') : ''
  const items = []
  const fields = { _id: true, publicId: true, 'profile.nickname': true, 'profile.avatarFileId': true,
    'profile.city': true, 'profile.district': true, 'profile.ratingPlatform': true, 'profile.ratingValue': true,
    'profile.playingProfile': true, 'profile.availability': true }
  if (nearby) fields['profile.nearbyDiscovery'] = true
  // Existing scores are strings. Scan bounded, stable public-ID pages and derive
  // grades numerically, so legacy profiles work without a risky migration.
  for (let batch = 0; batch < 5; batch++) {
    const condition = { status: 'active', publicId: context.command.gt(cursor) }
    if (district && district !== '全杭州') condition['profile.district'] = district
    const result = await context.db.collection(COLLECTIONS.users).where(condition)
      .orderBy('publicId', 'asc').field(fields).limit(50).get()
    const blocked = await blockedIds(context, result.data)
    for (const user of result.data) {
      cursor = user.publicId
      if (blocked.has(user._id)) continue
      if (nearby && user._id === context.openid) continue
      const distanceText = nearby ? nearbyDiscovery.match(nearby, user.profile && user.profile.nearbyDiscovery) : ''
      if (nearby && !distanceText) continue
      const profile = presenters.userProfile(user)
      const level = levels.resolve(profile)
      if (grade === 'pending' ? Boolean(level.code) : grade && !level.code.startsWith(grade)) continue
      if (availability && profile.availability.available !== (availability === 'available')) continue
      items.push({ playerId: profile.playerId, displayName: profile.nickname,
        avatarFileId: profile.avatarFileId, city: profile.city, district: profile.district,
        ratingPlatform: profile.ratingPlatform, ratingValue: profile.ratingValue, ratingStatus: profile.ratingStatus,
        ratingText: levels.summary(profile).ratingText,
        ...(nearby ? { distanceText } : {}),
        level, availability: profile.availability, traits: levels.summary(profile).traits.slice(0, 3) })
      if (items.length === pageSize) return { items, cursor, hasMore: true }
    }
    if (result.data.length < 50) return { items, cursor, hasMore: false }
  }
  // A sparse filtered page is not proof of exhaustion; continue from the cursor.
  return { items, cursor, hasMore: true }
}

module.exports = { get, list }
