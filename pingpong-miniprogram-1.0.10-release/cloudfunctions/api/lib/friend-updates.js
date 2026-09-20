const { COLLECTIONS, RATING_PLATFORMS, HANGZHOU_DISTRICTS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const presenters = require('./presenters')
const { stableId, getDocument } = require('./database')
const { checkText } = require('./moderation')
const { writeAudit } = require('./audit')

const UPDATE_KINDS = ['availability', 'tip']
const AVAILABILITY_LIFETIME_DAYS = 14

function updateId(userId, requestId = '') {
  return stableId('player-update', userId, requestId || 'legacy-current')
}
function legacyScheduleText(document) {
  if (!document || !document.date) return ''
  return `${document.date} ${document.startTime || ''}${document.endTime ? `—${document.endTime}` : ''}`.trim()
}
function availabilityFromSchedule(schedule) {
  const parts = schedule.date.split('-')
  return `${Number(parts[1])}月${Number(parts[2])}日 ${schedule.startTime}—${schedule.endTime}`
}

function isExpired(document, now = Date.now()) {
  if (!document || document.kind === 'tip') return false
  const value = document.expiresAt || document.endAt
  return Boolean(value && new Date(value).getTime() < now)
}

function visibleActive(document) {
  return Boolean(document && document.active === true && !isExpired(document))
}

function presentUpdate(document, actorId) {
  if (!document) return null
  const author = document.authorSnapshot || {}
  const kind = UPDATE_KINDS.includes(document.kind) ? document.kind : 'availability'
  return {
    id: document._id || '',
    kind,
    author: {
      playerId: author.playerId || '',
      displayName: author.displayName || '球友',
      avatarFileId: author.avatarFileId || ''
    },
    city: '杭州',
    district: document.district || '',
    availabilityText: document.availabilityText || legacyScheduleText(document),
    timeNote: document.timeNote || '',
    venueName: document.venueName || '',
    content: document.content || '',
    date: document.date || '',
    startTime: document.startTime || '',
    endTime: document.endTime || '',
    ratingPlatform: document.ratingPlatform || '未填写',
    ratingValue: document.ratingValue || '',
    commentCount: Math.max(0, Number(document.commentCount || 0)),
    mine: Boolean(actorId && document.userId === actorId),
    createdAt: document.createdAt || document.updatedAt,
    updatedAt: document.updatedAt
  }
}

async function blockedUserIds(context) {
  const [outgoing, incoming] = await Promise.all([
    context.db.collection(COLLECTIONS.userBlocks).where({ userId: context.openid, active: true }).limit(100).get(),
    context.db.collection(COLLECTIONS.userBlocks).where({ targetUserId: context.openid, active: true }).limit(100).get()
  ])
  return new Set((outgoing.data || []).map(item => item.targetUserId)
    .concat((incoming.data || []).map(item => item.userId)).filter(Boolean))
}

async function list(context, payload) {
  const paging = validate.pagination(payload)
  const [result, mineResult, blocked] = await Promise.all([
    context.db.collection(COLLECTIONS.playerUpdates)
      .where({ active: true })
      .orderBy('createdAt', 'desc')
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize + 1)
      .get(),
    context.db.collection(COLLECTIONS.playerUpdates)
      .where({ userId: context.openid, active: true })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get(),
    blockedUserIds(context)
  ])
  const visible = (result.data || []).filter(document => visibleActive(document) && !blocked.has(document.userId))
  const mineDocument = (mineResult.data || []).find(visibleActive) || null
  return {
    mine: mineDocument ? presentUpdate(mineDocument, context.openid) : null,
    items: visible.slice(0, paging.pageSize).map(document => presentUpdate(document, context.openid)),
    page: paging.page,
    pageSize: paging.pageSize,
    hasMore: (result.data || []).length > paging.pageSize
  }
}

async function get(context, payload) {
  const id = validate.id(payload.updateId, '动态 ID')
  const [document, blocked] = await Promise.all([
    getDocument(context.db.collection(COLLECTIONS.playerUpdates).doc(id)),
    blockedUserIds(context)
  ])
  assert(visibleActive(document) && !blocked.has(document.userId), 'NOT_FOUND', '动态不存在或已撤下')
  return presentUpdate(Object.assign({ _id: id }, document), context.openid)
}

function ratingFromPayload(context, payload) {
  const profile = presenters.userProfile(context.user)
  const platform = payload.ratingPlatform === undefined
    ? profile.ratingPlatform
    : validate.oneOf(payload.ratingPlatform, RATING_PLATFORMS, '积分平台')
  if (!platform || platform === '未填写') return { ratingPlatform: '未填写', ratingValue: '' }
  const fallback = profile.ratingPlatform === platform ? profile.ratingValue : ''
  const value = payload.ratingValue === undefined ? fallback : payload.ratingValue
  return {
    ratingPlatform: platform,
    ratingValue: String(validate.integer(value, '积分', { min: 1, max: 9999 }))
  }
}

async function publish(context, payload) {
  // API v1 used an exact date/time range. Keep accepting it while clients roll
  // forward, but only v2 is allowed to create the new broad-time/text formats.
  const legacyRequest = Number(context.apiVersion || 2) === 1 && payload.availabilityText === undefined
  const legacySchedule = legacyRequest
    ? validate.schedule(payload.date, payload.startTime, payload.endTime)
    : null
  const kind = legacyRequest ? 'availability' : validate.oneOf(payload.kind || 'availability', UPDATE_KINDS, '动态类型')
  const district = kind === 'availability' ? validate.oneOf(payload.district, HANGZHOU_DISTRICTS, '地区') : ''
  const availabilityText = legacySchedule
    ? availabilityFromSchedule(legacySchedule)
    : kind === 'availability'
      ? validate.text(payload.availabilityText, '可约时间', { min: 2, max: 40 }) : ''
  const timeNote = kind === 'availability'
    ? validate.text(payload.timeNote || '', '时间备注', { required: false, max: 60 }) : ''
  const venueName = kind === 'availability'
    ? validate.text(payload.venueName || '', '球馆备注', { required: false, max: 50 }) : ''
  const content = validate.text(payload.content || '', kind === 'tip' ? '心得或技巧' : '补充说明', {
    required: kind === 'tip', min: kind === 'tip' ? 2 : 0, max: 500
  })
  const rating = ratingFromPayload(context, payload)
  await checkText(context, [availabilityText, timeNote, venueName, content], 2)

  const id = legacyRequest
    ? stableId('player-update', context.openid)
    : updateId(context.openid, validate.id(context.requestId, '请求 ID'))
  const ref = context.db.collection(COLLECTIONS.playerUpdates).doc(id)
  const existing = await getDocument(ref)
  if (existing && !legacyRequest) return presentUpdate(Object.assign({ _id: id }, existing), context.openid)

  const profile = presenters.userProfile(context.user)
  const document = {
    userId: context.openid,
    authorSnapshot: {
      playerId: profile.playerId,
      displayName: profile.nickname,
      avatarFileId: profile.avatarFileId
    },
    kind,
    city: '杭州',
    district,
    availabilityText,
    timeNote,
    venueName,
    content,
    ratingPlatform: rating.ratingPlatform,
    ratingValue: rating.ratingValue,
    commentCount: Math.max(0, Number(existing && existing.commentCount || 0)),
    active: true,
    status: 'active',
    expiresAt: legacySchedule
      ? legacySchedule.endAt
      : kind === 'availability' ? new Date(Date.now() + AVAILABILITY_LIFETIME_DAYS * 24 * 60 * 60 * 1000) : null,
    requestId: context.requestId,
    createdAt: existing && existing.createdAt || context.serverDate(),
    updatedAt: context.serverDate()
  }
  if (legacySchedule) Object.assign(document, legacySchedule)
  await ref.set({ data: document })
  await writeAudit(context, 'friendUpdates.publish', 'player_update', id, { kind, district })
  return presentUpdate(Object.assign({ _id: id }, document), context.openid)
}

async function remove(context, payload) {
  const id = Number(context.apiVersion || 2) === 1 && !payload.updateId
    ? stableId('player-update', context.openid)
    : validate.id(payload.updateId, '动态 ID')
  const ref = context.db.collection(COLLECTIONS.playerUpdates).doc(id)
  const existing = await getDocument(ref)
  if (!existing || existing.active !== true) return { removed: true }
  assert(existing.userId === context.openid, 'FORBIDDEN', '只能撤下自己发布的动态')
  await ref.update({ data: {
    active: false,
    status: 'withdrawn',
    withdrawnAt: context.serverDate(),
    updatedAt: context.serverDate()
  } })
  await writeAudit(context, 'friendUpdates.remove', 'player_update', id)
  return { removed: true }
}

module.exports = {
  list,
  get,
  publish,
  remove,
  _private: { updateId, presentUpdate, ratingFromPayload, visibleActive, blockedUserIds, isExpired, availabilityFromSchedule, UPDATE_KINDS, AVAILABILITY_LIFETIME_DAYS }
}
