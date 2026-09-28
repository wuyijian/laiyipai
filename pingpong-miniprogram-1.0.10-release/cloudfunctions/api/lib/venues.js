const { COLLECTIONS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const presenters = require('./presenters')
const { getDocument } = require('./database')

const VENUE_LIST_FIELDS = {
  _id: true, name: true, city: true, district: true, address: true, location: true,
  coverFileIds: true, photoFileIds: true, phone: true, openingHours: true,
  bookingTip: true, tags: true, activityTags: true, facilityTags: true,
  listingMode: true, source: true, sourceUrls: true, verificationStatus: true,
  adminVerified: true, partnerVerified: true, verificationDate: true,
  featuredRank: true, updatedAt: true,
  ratingCount: true, ratingTotal: true, ratingAverage: true, ratingTagCounts: true
}

function selectFields(query) {
  return query && typeof query.field === 'function' ? query.field(VENUE_LIST_FIELDS) : query
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pointCoordinates(point) {
  if (!point) return null
  const longitude = Number(point.longitude !== undefined ? point.longitude : point.coordinates && point.coordinates[0])
  const latitude = Number(point.latitude !== undefined ? point.latitude : point.coordinates && point.coordinates[1])
  return Number.isFinite(longitude) && Number.isFinite(latitude) ? { longitude, latitude } : null
}

function distanceMeters(fromLatitude, fromLongitude, point) {
  const target = pointCoordinates(point)
  if (!target) return undefined
  const rad = (value) => value * Math.PI / 180
  const earth = 6371000
  const deltaLat = rad(target.latitude - fromLatitude)
  const deltaLng = rad(target.longitude - fromLongitude)
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(rad(fromLatitude)) * Math.cos(rad(target.latitude)) * Math.sin(deltaLng / 2) ** 2
  return 2 * earth * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function list(context, payload) {
  const paging = validate.pagination(payload)
  const city = validate.text(payload.city === undefined ? '杭州' : payload.city, '城市', { max: 20 })
  const district = payload.district ? validate.text(payload.district, '地区', { max: 20 }) : ''
  const keyword = payload.keyword ? validate.text(payload.keyword, '关键词', { max: 30 }) : ''
  const publicCondition = { active: true, verificationStatus: 'verified', city }
  if (district) publicCondition.district = district
  // A venue is commonly remembered by either its name or a road/community in
  // the full address. Keep all public-state predicates on both OR branches so
  // search can never expose an inactive or unverified row.
  const condition = keyword
    ? context.command.or([
        Object.assign({}, publicCondition, { name: context.db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' }) }),
        Object.assign({}, publicCondition, { address: context.db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' }) })
      ])
    : publicCondition
  const query = context.db.collection(COLLECTIONS.venues)
    .where(condition)
    .orderBy('featuredRank', 'asc')
    .orderBy('name', 'asc')
    .skip((paging.page - 1) * paging.pageSize)
    .limit(paging.pageSize + 1)
  const result = await selectFields(query).get()
  return {
    items: result.data.slice(0, paging.pageSize).map((item) => presenters.venue(item)),
    page: paging.page,
    pageSize: paging.pageSize,
    hasMore: result.data.length > paging.pageSize
  }
}

async function nearby(context, payload) {
  const latitude = validate.number(payload.latitude, '纬度', { min: -90, max: 90 })
  const longitude = validate.number(payload.longitude, '经度', { min: -180, max: 180 })
  const radiusMeters = validate.integer(payload.radiusMeters === undefined ? 20000 : payload.radiusMeters, '搜索半径', { min: 500, max: 50000 })
  const pageSize = validate.integer(payload.pageSize === undefined ? 30 : payload.pageSize, '每页数量', { min: 1, max: 50 })
  const condition = {
    active: true,
    verificationStatus: 'verified',
    location: context.command.geoNear({
      geometry: new context.db.Geo.Point(longitude, latitude),
      minDistance: 0,
      maxDistance: radiusMeters
    })
  }
  const query = context.db.collection(COLLECTIONS.venues).where(condition).limit(pageSize)
  const result = await selectFields(query).get()
  return {
    items: result.data.map((item) => presenters.venue(item, distanceMeters(latitude, longitude, item.location))),
    radiusMeters
  }
}

async function get(context, payload) {
  const venueId = validate.id(payload.venueId, '球馆 ID')
  const document = await getDocument(context.db.collection(COLLECTIONS.venues).doc(venueId))
  assert(document && document.active && document.verificationStatus === 'verified', 'NOT_FOUND', '球馆不存在或暂未开放')
  return presenters.venue(document)
}

module.exports = { list, nearby, get }
