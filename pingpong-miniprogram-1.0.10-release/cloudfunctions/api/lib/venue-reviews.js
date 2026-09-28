const { COLLECTIONS, VENUE_REVIEW_TAGS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const presenters = require('./presenters')
const { getDocument, stableId } = require('./database')
const { checkText } = require('./moderation')
const { writeAudit } = require('./audit')

const MAX_REVIEWS = 50

function reviewId(userId, venueId) {
  return stableId('venue-review', userId, venueId)
}

function emptyTagCounts() {
  return Object.fromEntries(VENUE_REVIEW_TAGS.map((tag) => [tag, 0]))
}

function currentTagCounts(venue) {
  return Object.assign(emptyTagCounts(), venue && venue.ratingTagCounts || {})
}

function summary(venue) {
  const count = Math.max(0, Number(venue && venue.ratingCount || 0))
  const total = Math.max(0, Number(venue && venue.ratingTotal || 0))
  return {
    count,
    average: count ? Math.round((total / count) * 10) / 10 : 0,
    tags: VENUE_REVIEW_TAGS.map((tag) => ({ tag, count: Math.max(0, Number(currentTagCounts(venue)[tag] || 0)) }))
      .filter((item) => item.count > 0)
  }
}

async function requireVenue(context, venueId) {
  const venue = await getDocument(context.db.collection(COLLECTIONS.venues).doc(venueId))
  assert(venue && venue.active === true && venue.verificationStatus === 'verified', 'NOT_FOUND', '球馆不存在或暂未开放')
  return venue
}

async function list(context, payload) {
  const venueId = validate.id(payload.venueId, '球馆 ID')
  const paging = validate.pagination(Object.assign({}, payload, { pageSize: Math.min(MAX_REVIEWS, payload.pageSize === undefined ? 20 : payload.pageSize) }))
  const venue = await requireVenue(context, venueId)
  const result = await context.db.collection(COLLECTIONS.venueReviews)
    .where({ venueId, status: 'active' })
    .orderBy('updatedAt', 'desc')
    .skip((paging.page - 1) * paging.pageSize)
    .limit(paging.pageSize + 1)
    .get()
  const mine = await getDocument(context.db.collection(COLLECTIONS.venueReviews).doc(reviewId(context.openid, venueId)))
  return {
    summary: summary(venue),
    items: result.data.slice(0, paging.pageSize).map((item) => presenters.venueReview(item, context.openid)),
    mine: mine && mine.status === 'active' ? presenters.venueReview(mine, context.openid) : null,
    page: paging.page,
    pageSize: paging.pageSize,
    hasMore: result.data.length > paging.pageSize
  }
}

async function upsert(context, payload) {
  const venueId = validate.id(payload.venueId, '球馆 ID')
  const rating = validate.integer(payload.rating, '评分', { min: 1, max: 5 })
  const tags = validate.stringArray(payload.tags, '球馆标签', { maxItems: 5, itemMax: 10 })
  tags.forEach((tag) => validate.oneOf(tag, VENUE_REVIEW_TAGS, '球馆标签'))
  const customText = validate.text(payload.customText || '', '自定义反馈', { required: false, max: 200 })
  await checkText(context, [customText], 2)
  const result = await context.db.runTransaction(async (transaction) => {
    const venueRef = transaction.collection(COLLECTIONS.venues).doc(venueId)
    const venue = await getDocument(venueRef)
    assert(venue && venue.active === true && venue.verificationStatus === 'verified', 'NOT_FOUND', '球馆不存在或暂未开放')
    const ref = transaction.collection(COLLECTIONS.venueReviews).doc(reviewId(context.openid, venueId))
    const previous = await getDocument(ref)
    const wasActive = previous && previous.status === 'active'
    const oldRating = wasActive ? Number(previous.rating || 0) : 0
    const oldTags = wasActive && Array.isArray(previous.tags) ? previous.tags : []
    const tagCounts = currentTagCounts(venue)
    oldTags.forEach((tag) => { if (Object.prototype.hasOwnProperty.call(tagCounts, tag)) tagCounts[tag] = Math.max(0, Number(tagCounts[tag] || 0) - 1) })
    tags.forEach((tag) => { tagCounts[tag] = Number(tagCounts[tag] || 0) + 1 })
    const count = Math.max(0, Number(venue.ratingCount || 0) - (wasActive ? 1 : 0)) + 1
    const total = Math.max(0, Number(venue.ratingTotal || 0) - oldRating) + rating
    const review = {
      userId: context.openid,
      venueId,
      status: 'active',
      rating,
      tags,
      customText,
      authorSnapshot: {
        playerId: context.user && context.user.publicId || '',
        displayName: context.user && context.user.profile && context.user.profile.nickname || '球友'
      },
      requestId: context.requestId,
      createdAt: previous && previous.createdAt || context.serverDate(),
      updatedAt: context.serverDate()
    }
    await ref.set({ data: review })
    await venueRef.update({ data: {
      ratingCount: count,
      ratingTotal: total,
      ratingAverage: Math.round((total / count) * 10) / 10,
      ratingTagCounts: tagCounts,
      updatedAt: context.serverDate()
    } })
    return { reviewId: reviewId(context.openid, venueId), review, ratingCount: count, ratingAverage: Math.round((total / count) * 10) / 10 }
  })
  await writeAudit(context, 'venueReviews.upsert', 'venueReview', result.reviewId, { venueId, rating, tagCount: tags.length })
  return {
    review: presenters.venueReview(Object.assign({ _id: result.reviewId }, result.review), context.openid),
    summary: { count: result.ratingCount, average: result.ratingAverage }
  }
}

module.exports = { list, upsert, _private: { reviewId, summary, VENUE_REVIEW_TAGS } }
