const { COLLECTIONS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const presenters = require('./presenters')
const { stableId, getDocument } = require('./database')
const { writeAudit } = require('./audit')

function favoriteId(userId, venueId) {
  return stableId('venue-favorite', userId, venueId)
}

async function status(context, payload) {
  const venueIds = validate.stringArray(payload.venueIds, '球馆 ID', {
    required: true,
    maxItems: 50,
    itemMax: 80
  }).map((venueId) => validate.id(venueId, '球馆 ID'))
  if (!venueIds.length) return { markedIds: [] }

  const requestedIds = new Set(venueIds)
  const favoriteDocumentIds = venueIds.map((venueId) => favoriteId(context.openid, venueId))
  const groups = []
  for (let index = 0; index < favoriteDocumentIds.length; index += 20) {
    groups.push(favoriteDocumentIds.slice(index, index + 20))
  }
  const results = await Promise.all(groups.map((group) => context.db.collection(COLLECTIONS.venueFavorites).where({
    _id: context.command.in(group)
  }).get()))
  const markedIds = results.flatMap((result) => result.data)
    .filter((favorite) => requestedIds.has(favorite.venueId)
      && favorite._id === favoriteId(context.openid, favorite.venueId))
    .map((favorite) => favorite.venueId)
  return { markedIds }
}

async function list(context, payload) {
  const paging = validate.pagination(payload)
  const collection = context.db.collection(COLLECTIONS.venueFavorites)
  const condition = { userId: context.openid }
  const [result, countResult] = await Promise.all([
    collection.where(condition)
      .orderBy('createdAt', 'desc')
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .get(),
    collection.where(condition).count()
  ])
  const venueIds = result.data.map((item) => item.venueId)
  const groups = []
  for (let index = 0; index < venueIds.length; index += 20) groups.push(venueIds.slice(index, index + 20))
  const venueResults = await Promise.all(groups.map((group) => context.db.collection(COLLECTIONS.venues).where({
    _id: context.command.in(group)
  }).get()))
  const byId = Object.fromEntries(venueResults.flatMap((item) => item.data)
    .filter((item) => item.active === true && item.verificationStatus === 'verified')
    .map((item) => [item._id, item]))
  const total = Number(countResult.total || 0)
  return {
    items: result.data.map((favorite) => {
      const venue = byId[favorite.venueId]
      if (venue) return Object.assign(presenters.venue(venue), { unavailable: false })
      return {
        id: favorite.venueId,
        name: '已下架球馆',
        city: '',
        district: '',
        address: '',
        unavailable: true
      }
    }),
    page: paging.page,
    pageSize: paging.pageSize,
    total,
    hasMore: paging.page * paging.pageSize < total
  }
}

async function set(context, payload) {
  const venueId = validate.id(payload.venueId, '球馆 ID')
  const marked = validate.boolean(payload.marked, '收藏状态')
  const id = favoriteId(context.openid, venueId)
  const ref = context.db.collection(COLLECTIONS.venueFavorites).doc(id)
  const existing = await getDocument(ref)
  if (marked) {
    const venue = await getDocument(context.db.collection(COLLECTIONS.venues).doc(venueId))
    assert(venue && venue.active && venue.verificationStatus === 'verified', 'NOT_FOUND', '球馆不存在或暂未开放')
  }
  if (marked && !existing) {
    await ref.set({ data: { userId: context.openid, venueId, createdAt: context.serverDate() } })
  }
  if (!marked && existing) await ref.remove()
  await writeAudit(context, 'favorites.set', 'venue', venueId, { marked })
  return { venueId, marked }
}

module.exports = { list, status, set, _private: { favoriteId } }
