const { COLLECTIONS } = require('./constants')
const { assert, ApiError } = require('./errors')
const validate = require('./validate')
const { stableId, getDocument } = require('./database')
const { requireAdmin } = require('./auth')
const { writeAudit } = require('./audit')

const MAX_OWN = 6
const MAX_PUBLIC = 6

function present(photo) {
  return {
    id: photo._id, venueId: photo.venueId, status: photo.status,
    fileId: photo.status === 'passed' && !photo.deleted ? photo.fileId : '',
    rejectionReason: photo.status === 'rejected' ? photo.rejectionReason || '照片未通过审核' : '',
    createdAt: photo.createdAt
  }
}

async function requireVenue(db, venueId) {
  const venue = await getDocument(db.collection(COLLECTIONS.venues).doc(venueId))
  assert(venue && venue.active && venue.verificationStatus === 'verified', 'NOT_FOUND', '球馆不存在或暂未开放')
  return venue
}

function quotaId(userId, venueId) { return stableId('venue-photo-quota', userId, venueId) }

async function list(context, payload) {
  const venueId = validate.id(payload.venueId, '球馆 ID')
  await requireVenue(context.db, venueId)
  const result = await context.db.collection(COLLECTIONS.userMedia)
    .where({ userId: context.openid, venueId, purpose: 'venue_photo', deleted: false })
    .orderBy('createdAt', 'desc').limit(MAX_OWN).get()
  return { items: result.data.map(present), limit: MAX_OWN }
}

// Keep a tombstone response for older clients; do not claim tickets or files.
async function register() {
  throw new ApiError('FEATURE_DISABLED', '场馆照片上传已停用')
}

async function remove(context, payload, asAdmin = false) {
  const photoId = validate.id(payload.photoId, '照片 ID')
  const result = await context.db.runTransaction(async transaction => {
    const ref = transaction.collection(COLLECTIONS.userMedia).doc(photoId)
    const photo = await getDocument(ref)
    assert(photo && photo.purpose === 'venue_photo' && (photo.userId === context.openid || asAdmin), 'NOT_FOUND', '照片不存在或无权删除')
    if (!photo.deleted) {
      const venueRef = transaction.collection(COLLECTIONS.venues).doc(photo.venueId)
      const venue = await getDocument(venueRef)
      const quotaRef = transaction.collection(COLLECTIONS.userMedia).doc(quotaId(photo.userId, photo.venueId))
      const quota = await getDocument(quotaRef)
      if (venue) await venueRef.update({ data: { photoFileIds: (venue.photoFileIds || []).filter(id => id !== photo.fileId), updatedAt: context.serverDate() } })
      if (quota) await quotaRef.update({ data: { photoIds: (quota.photoIds || []).filter(id => id !== photoId), updatedAt: context.serverDate() } })
      await ref.update({ data: { deleted: true, status: 'deleted', updatedAt: context.serverDate() } })
    }
    return { fileId: photo.fileId, idempotent: Boolean(photo.deleted) }
  })
  try { await context.cloud.deleteFile({ fileList: [result.fileId] }) } catch (error) { console.error('VENUE_PHOTO_DELETE_FAILED', photoId, error) }
  await writeAudit(context, asAdmin ? 'admin.venuePhotos.remove' : 'venuePhotos.remove', 'venuePhoto', photoId)
  return { photoId, deleted: true, idempotent: result.idempotent }
}

async function pending(context, payload) {
  requireAdmin(context)
  const pageSize = validate.integer(payload.pageSize === undefined ? 20 : payload.pageSize, '每页数量', { min: 1, max: 50 })
  const result = await context.db.collection(COLLECTIONS.userMedia)
    .where({ purpose: 'venue_photo', status: 'reviewing', deleted: false })
    .orderBy('createdAt', 'asc').limit(pageSize).get()
  const temp = result.data.length ? await context.cloud.getTempFileURL({ fileList: result.data.map(photo => photo.fileId) }) : { fileList: [] }
  const urls = Object.fromEntries((temp.fileList || []).filter(item => !item.status && item.tempFileURL).map(item => [item.fileID, item.tempFileURL]))
  return { items: result.data.map(photo => Object.assign(present(photo), { reviewUrl: urls[photo.fileId] || '' })) }
}

async function review(context, payload) {
  requireAdmin(context)
  const photoId = validate.id(payload.photoId, '照片 ID')
  const decision = validate.oneOf(payload.decision, ['pass', 'reject'], '审核结果')
  const reason = decision === 'reject' ? validate.text(payload.reason, '拒绝原因', { min: 2, max: 120 }) : ''
  const result = await context.db.runTransaction(async transaction => {
    const photoRef = transaction.collection(COLLECTIONS.userMedia).doc(photoId)
    const photo = await getDocument(photoRef)
    assert(photo && photo.purpose === 'venue_photo' && !photo.deleted, 'NOT_FOUND', '照片不存在')
    if (photo.reviewRequestId === context.requestId) return { photoId, status: photo.status, idempotent: true, fileId: photo.fileId }
    assert(photo.status === 'reviewing', 'VERSION_CONFLICT', '照片已处理，请刷新列表')
    if (decision === 'pass') {
      const venue = await requireVenue(transaction, photo.venueId)
      const user = await getDocument(transaction.collection(COLLECTIONS.users).doc(photo.userId))
      assert(user && user.status === 'active', 'NOT_FOUND', '上传者账号已停用')
      const photoFileIds = Array.from(new Set((venue.photoFileIds || []).concat(photo.fileId)))
      assert(photoFileIds.length <= MAX_PUBLIC, 'PHOTO_LIMIT_REACHED', '球馆已有 6 张场地照片，请先处理重复或过期照片')
      await transaction.collection(COLLECTIONS.venues).doc(photo.venueId).update({ data: { photoFileIds, updatedAt: context.serverDate() } })
    }
    const status = decision === 'pass' ? 'passed' : 'rejected'
    await photoRef.update({ data: {
      status, rejectionReason: reason, reviewRequestId: context.requestId,
      reviewedBy: context.openid, reviewedAt: context.serverDate(), updatedAt: context.serverDate()
    } })
    return { photoId, status, idempotent: false, fileId: photo.fileId }
  })
  if (result.status === 'rejected') {
    try { await context.cloud.deleteFile({ fileList: [result.fileId] }) } catch (error) { console.error('REJECTED_VENUE_PHOTO_DELETE_FAILED', photoId, error) }
  }
  await writeAudit(context, 'admin.venuePhotos.review', 'venuePhoto', photoId, { decision })
  return { photoId, status: result.status, idempotent: result.idempotent }
}

async function removeAsAdmin(context, payload) {
  requireAdmin(context)
  return remove(context, payload, true)
}

module.exports = { list, register, remove, pending, review, removeAsAdmin }
