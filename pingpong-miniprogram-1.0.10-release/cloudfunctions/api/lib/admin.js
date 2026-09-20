const { COLLECTIONS, VENUE_ACTIVITY_TAGS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const presenters = require('./presenters')
const { requireAdmin, isAdmin } = require('./auth')
const { getDocument } = require('./database')
const { writeAudit } = require('./audit')
const venueEntry = require('./venue-entry')

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function adminVenue(document) {
  return Object.assign(presenters.venue(document), {
    active: document.active === true,
    verificationStatus: document.verificationStatus || 'pending',
    sourceUrls: Array.isArray(document.sourceUrls) ? document.sourceUrls : [],
    partnershipReference: document.partnershipReference || '',
    featuredRank: Number(document.featuredRank === undefined ? 9999 : document.featuredRank)
  })
}

function adminCoach(document) {
  return Object.assign(presenters.coach(document), {
    active: document.active === true,
    verificationStatus: document.verificationStatus || 'pending'
  })
}

async function listResources(context, payload, collectionName, presenter) {
  requireAdmin(context)
  const paging = validate.pagination(payload)
  const keyword = payload.keyword ? validate.text(payload.keyword, '关键词', { max: 30 }) : ''
  const condition = { deleted: context.command.neq(true) }
  if (keyword) condition.name = context.db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' })
  if (payload.district) condition.district = validate.text(payload.district, '地区', { max: 20 })
  const result = await context.db.collection(collectionName)
    .where(condition)
    .skip((paging.page - 1) * paging.pageSize)
    .limit(paging.pageSize + 1)
    .get()
  const documents = result.data || []
  return {
    items: documents.slice(0, paging.pageSize).map(presenter),
    page: paging.page,
    pageSize: paging.pageSize,
    hasMore: documents.length > paging.pageSize
  }
}

function listVenues(context, payload) {
  return listResources(context, payload, COLLECTIONS.venues, adminVenue)
}

function listCoaches(context, payload) {
  return listResources(context, payload, COLLECTIONS.coaches, adminCoach)
}

async function removeResource(context, payload, options) {
  requireAdmin(context)
  validate.id(context.requestId, '请求 ID')
  const id = validate.id(payload[options.idField], options.label)
  const reason = validate.text(payload.reason || '管理员删除', '删除原因', { min: 2, max: 120 })
  const result = await context.db.runTransaction(async (transaction) => {
    const user = await getDocument(transaction.collection(COLLECTIONS.users).doc(context.openid))
    assert(user && user.status === 'active' && isAdmin(context, user), 'FORBIDDEN', '需要运营管理员权限')
    const ref = transaction.collection(options.collection).doc(id)
    const current = await getDocument(ref)
    assert(current, 'NOT_FOUND', `${options.label}不存在`)
    if (current.deleted === true) return { idempotent: true }
    await ref.update({ data: {
      active: false,
      deleted: true,
      deletionReason: reason,
      deleteRequestId: context.requestId,
      deletedBy: context.openid,
      deletedAt: context.serverDate(),
      updatedAt: context.serverDate()
    } })
    return { idempotent: false }
  })
  if (!result.idempotent) await writeAudit(context, options.action, options.auditType, id, { reason })
  return { id, deleted: true, idempotent: result.idempotent }
}

function removeVenue(context, payload) {
  return removeResource(context, payload, {
    idField: 'venueId', label: '球馆', collection: COLLECTIONS.venues,
    action: 'admin.venues.remove', auditType: 'venue'
  })
}

function removeCoach(context, payload) {
  return removeResource(context, payload, {
    idField: 'coachId', label: '教练', collection: COLLECTIONS.coaches,
    action: 'admin.coaches.remove', auditType: 'coach'
  })
}

async function upsertVenue(context, payload) {
  requireAdmin(context)
  const venueId = validate.id(payload.venueId, '球馆 ID')
  const listingMode = validate.oneOf(payload.listingMode || 'full', ['full', 'name_only'], '场馆展示模式')
  const nameOnly = listingMode === 'name_only'
  const verificationStatus = validate.oneOf(payload.verificationStatus || (nameOnly ? 'verified' : 'pending'), ['pending', 'verified', 'rejected'], '认证状态')
  const verificationDate = nameOnly ? '' : payload.verificationDate ? validate.date(payload.verificationDate, '资料核验日期') : ''
  const sourceUrls = nameOnly ? [] : validate.stringArray(payload.sourceUrls, '资料来源', { maxItems: 6, itemMax: 300 })
  const partnerVerified = nameOnly ? false : payload.partnerVerified === undefined ? false : validate.boolean(payload.partnerVerified, '合作关系状态')
  const partnershipReference = nameOnly ? '' : validate.text(payload.partnershipReference || '', '合作记录编号', { required: false, max: 80 })
  const active = payload.active === undefined ? verificationStatus === 'verified' : validate.boolean(payload.active, '上架状态')
  const activityTags = validate.stringArray(payload.activityTags, '适合活动', { maxItems: VENUE_ACTIVITY_TAGS.length, itemMax: 4 })
  activityTags.forEach((tag) => assert(VENUE_ACTIVITY_TAGS.includes(tag), 'INVALID_ARGUMENT', `适合活动只能填写：${VENUE_ACTIVITY_TAGS.join('、')}`))
  if (!nameOnly && verificationStatus === 'verified') {
    assert(verificationDate && sourceUrls.length, 'INVALID_ARGUMENT', '核验通过的球馆必须填写核验日期和资料来源')
    sourceUrls.forEach((url) => assert(/^https:\/\//i.test(url), 'INVALID_ARGUMENT', '资料来源必须使用 HTTPS 链接'))
  }
  assert(!active || verificationStatus === 'verified', 'INVALID_ARGUMENT', '只有资料核验通过的球馆可以上架')
  assert(!partnerVerified || (verificationStatus === 'verified' && partnershipReference), 'INVALID_ARGUMENT', '标记合作场馆前请填写合作记录编号')
  assert(!nameOnly || payload.partnerVerified === undefined || payload.partnerVerified === false, 'INVALID_ARGUMENT', '名称型场馆不能标记为平台认证或合作场馆')
  const data = {
    name: venueEntry.normalizedName(payload.name),
    nameKey: venueEntry.nameKey(payload.name),
    city: validate.text(payload.city || '杭州', '城市', { max: 20 }),
    district: nameOnly ? '' : validate.text(payload.district, '地区', { max: 20 }),
    address: nameOnly ? '' : validate.text(payload.address, '详细地址', { min: 4, max: 120 }),
    location: nameOnly ? null : new context.db.Geo.Point(
      validate.number(payload.longitude, '经度', { min: -180, max: 180 }),
      validate.number(payload.latitude, '纬度', { min: -90, max: 90 })
    ),
    phone: nameOnly ? '' : validate.text(payload.phone || '', '联系电话', { required: false, max: 30 }),
    openingHours: nameOnly ? '' : validate.text(payload.openingHours || '', '开放时间', { required: false, max: 100 }),
    bookingTip: nameOnly ? '' : validate.text(payload.bookingTip || '', '预约提示', { required: false, max: 120 }),
    tags: nameOnly ? [] : validate.stringArray(payload.tags, '球馆标签', { maxItems: 8, itemMax: 16 }),
    activityTags,
    facilityTags: nameOnly ? [] : validate.stringArray(payload.facilityTags, '设施标签', { maxItems: 12, itemMax: 16 }),
    coverFileIds: nameOnly ? [] : validate.stringArray(payload.coverFileIds, '球馆图片', { maxItems: 6, itemMax: 300 }),
    featuredRank: validate.integer(payload.featuredRank === undefined ? 9999 : payload.featuredRank, '推荐排序', { min: 0, max: 9999 }),
    listingMode,
    verificationStatus,
    verificationDate,
    sourceUrls,
    partnerVerified,
    partnershipReference,
    active,
    updatedAt: context.serverDate()
  }
  const ref = context.db.collection(COLLECTIONS.venues).doc(venueId)
  const existing = await getDocument(ref)
  if (existing) await ref.update({ data })
  else await ref.set({ data: Object.assign(data, { createdAt: context.serverDate() }) })
  await writeAudit(context, 'admin.venues.upsert', 'venue', venueId, {
    active: data.active,
    listingMode,
    verificationStatus,
    partnerVerified
  })
  return presenters.venue(await getDocument(ref))
}

async function upsertCoach(context, payload) {
  requireAdmin(context)
  const coachId = validate.id(payload.coachId, '教练 ID')
  const venueIds = validate.stringArray(payload.venueIds, '执教球馆', { required: true, maxItems: 10, itemMax: 80 })
  assert(venueIds.length, 'INVALID_ARGUMENT', '至少选择一个执教球馆')
  const verificationStatus = validate.oneOf(payload.verificationStatus || 'pending', ['pending', 'verified', 'rejected'], '认证状态')
  const verificationDate = payload.verificationDate ? validate.date(payload.verificationDate, '身份核验日期') : ''
  const verificationReference = validate.text(payload.verificationReference || '', '核验记录编号', { required: false, max: 80 })
  const active = payload.active === undefined ? verificationStatus === 'verified' : validate.boolean(payload.active, '上架状态')
  assert(verificationStatus !== 'verified' || (verificationDate && verificationReference), 'INVALID_ARGUMENT', '认证教练必须填写核验日期和核验记录编号')
  assert(!active || verificationStatus === 'verified', 'INVALID_ARGUMENT', '只有认证通过的教练可以上架')
  const data = {
    name: validate.text(payload.name, '教练姓名', { min: 2, max: 30 }),
    avatarFileId: validate.text(payload.avatarFileId || '', '头像', { required: false, max: 300 }),
    city: validate.text(payload.city || '杭州', '城市', { max: 20 }),
    district: validate.text(payload.district, '地区', { max: 20 }),
    venueIds,
    specialty: validate.stringArray(payload.specialty, '擅长方向', { required: true, maxItems: 8, itemMax: 20 }),
    introduction: validate.text(payload.introduction || '', '教练介绍', { required: false, max: 500 }),
    rating: validate.number(payload.rating === undefined ? 0 : payload.rating, '评分', { min: 0, max: 5 }),
    completedSessions: validate.integer(payload.completedSessions === undefined ? 0 : payload.completedSessions, '已完成课程', { min: 0, max: 100000 }),
    featuredRank: validate.integer(payload.featuredRank === undefined ? 9999 : payload.featuredRank, '推荐排序', { min: 0, max: 9999 }),
    verificationStatus,
    verificationDate,
    verificationReference,
    active,
    updatedAt: context.serverDate()
  }
  const ref = context.db.collection(COLLECTIONS.coaches).doc(coachId)
  const existing = await getDocument(ref)
  if (existing) await ref.update({ data })
  else await ref.set({ data: Object.assign(data, { createdAt: context.serverDate() }) })
  await writeAudit(context, 'admin.coaches.upsert', 'coach', coachId, { active: data.active, verificationStatus })
  return presenters.coach(await getDocument(ref))
}

async function upsertCoachSlot(context, payload) {
  requireAdmin(context)
  const slotId = validate.id(payload.slotId, '教练时段 ID')
  const coachId = validate.id(payload.coachId, '教练 ID')
  const venueId = validate.id(payload.venueId, '球馆 ID')
  const schedule = validate.schedule(payload.date, payload.startTime, payload.endTime)
  const capacity = validate.integer(payload.capacity === undefined ? 1 : payload.capacity, '可约人数', { min: 1, max: 8 })
  const price = validate.integer(payload.price, '课程价格', { min: 0, max: 9999 })
  const [coach, venue] = await Promise.all([
    getDocument(context.db.collection(COLLECTIONS.coaches).doc(coachId)),
    getDocument(context.db.collection(COLLECTIONS.venues).doc(venueId))
  ])
  assert(coach && coach.active && coach.verificationStatus === 'verified', 'NOT_FOUND', '教练不存在、未认证或未上架')
  assert(venue && venue.active && venue.verificationStatus === 'verified', 'NOT_FOUND', '球馆不存在、未核验或未上架')
  const ref = context.db.collection(COLLECTIONS.coachSlots).doc(slotId)
  const existing = await getDocument(ref)
  assert(!existing || Number(existing.bookedCount || 0) <= capacity, 'INVALID_ARGUMENT', '可约人数不能小于已预约人数')
  const data = {
    coachId,
    venueId,
    date: schedule.date,
    startAt: schedule.startAt,
    endAt: schedule.endAt,
    price,
    capacity,
    bookedCount: Number(existing && existing.bookedCount || 0),
    status: payload.status ? validate.oneOf(payload.status, ['open', 'closed', 'full'], '时段状态') : 'open',
    version: Number(existing && existing.version || 0) + 1,
    updatedAt: context.serverDate()
  }
  if (existing) await ref.update({ data })
  else await ref.set({ data: Object.assign(data, { createdAt: context.serverDate() }) })
  await writeAudit(context, 'admin.coachSlots.upsert', 'coachSlot', slotId, { coachId, venueId })
  return { id: slotId, coachId, venueId, startAt: schedule.startAt, endAt: schedule.endAt, price, capacity, status: data.status, version: data.version }
}

async function pendingVideos(context, payload) {
  requireAdmin(context)
  const pageSize = validate.integer(payload.pageSize === undefined ? 20 : payload.pageSize, '每页数量', { min: 1, max: 50 })
  const result = await context.db.collection(COLLECTIONS.userVideos)
    .where({ status: 'reviewing', deleted: false })
    .orderBy('createdAt', 'asc')
    .limit(pageSize)
    .get()
  let urlById = {}
  if (result.data.length) {
    const urls = await context.cloud.getTempFileURL({ fileList: result.data.map((item) => item.fileId) })
    urlById = Object.fromEntries((urls.fileList || []).filter((item) => !item.status && item.tempFileURL).map((item) => [item.fileID, item.tempFileURL]))
  }
  return {
    items: result.data.map((item) => ({
      videoId: item._id,
      title: item.title,
      durationSeconds: Number(item.durationSeconds || 0),
      visibility: item.visibility || 'public',
      reviewUrl: urlById[item.fileId] || '',
      createdAt: item.createdAt
    }))
  }
}

async function reviewVideo(context, payload) {
  requireAdmin(context)
  const videoId = validate.id(payload.videoId, '视频 ID')
  const decision = validate.oneOf(payload.decision, ['pass', 'reject'], '审核结果')
  const reason = decision === 'reject' ? validate.text(payload.reason, '拒绝原因', { min: 2, max: 120 }) : ''
  const ref = context.db.collection(COLLECTIONS.userVideos).doc(videoId)
  const video = await getDocument(ref)
  assert(video && !video.deleted, 'NOT_FOUND', '视频不存在')
  if (video.reviewRequestId === context.requestId) {
    return { videoId, status: video.status, idempotent: true }
  }
  assert(video.status === 'reviewing', 'VERSION_CONFLICT', '视频已被其他管理员处理')
  const status = decision === 'pass' ? 'passed' : 'rejected'
  await ref.update({ data: {
    status,
    rejectionReason: reason,
    reviewRequestId: context.requestId,
    reviewedBy: context.openid,
    reviewedAt: context.serverDate(),
    updatedAt: context.serverDate()
  } })
  if (status === 'rejected' && video.fileId) {
    try { await context.cloud.deleteFile({ fileList: [video.fileId] }) } catch (error) { console.error('REJECTED_VIDEO_DELETE_FAILED', videoId, error) }
  }
  await writeAudit(context, 'admin.videos.review', 'video', videoId, { decision })
  return { videoId, status, idempotent: false }
}

module.exports = {
  listVenues, removeVenue, listCoaches, removeCoach,
  upsertVenue, upsertCoach, upsertCoachSlot, pendingVideos, reviewVideo
}
