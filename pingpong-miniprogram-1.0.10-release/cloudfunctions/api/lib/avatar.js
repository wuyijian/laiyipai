const { COLLECTIONS } = require('./constants')
const { assert, ApiError } = require('./errors')
const validate = require('./validate')
const { stableId, getDocument } = require('./database')
const { writeAudit } = require('./audit')
const uploads = require('./uploads')

// WeChat documents that mediaCheckAsync callbacks are delivered within 30
// minutes. Give the platform a small grace period before exposing recovery to
// the user, so a missing message-push subscription can never leave the UI in
// an endless "reviewing" state.
const MODERATION_TIMEOUT_MS = 35 * 60 * 1000

function timestampMillis(value) {
  if (!value) return NaN
  if (value instanceof Date) return value.getTime()
  if (value && typeof value === 'object') {
    if (value.$date !== undefined) return new Date(value.$date).getTime()
    if (Number.isFinite(value._seconds)) return value._seconds * 1000
    if (Number.isFinite(value.seconds)) return value.seconds * 1000
  }
  return new Date(value).getTime()
}

function deadlineFor(document) {
  const explicit = timestampMillis(document && document.moderationDeadlineAt)
  if (Number.isFinite(explicit)) return explicit
  const requested = timestampMillis(document && (document.moderationRequestedAt || document.createdAt))
  return Number.isFinite(requested) ? requested + MODERATION_TIMEOUT_MS : NaN
}

function effectiveStatus(document, now = Date.now()) {
  if (!document) return ''
  if (document.status !== 'reviewing') return document.status
  const deadline = deadlineFor(document)
  // Malformed legacy timestamps must not trap a user in reviewing forever.
  return !Number.isFinite(deadline) || now >= deadline ? 'timed_out' : 'reviewing'
}

function present(document, now = Date.now()) {
  if (!document) return null
  const status = effectiveStatus(document, now)
  const deadline = deadlineFor(document)
  return {
    id: document._id,
    status,
    fileId: status === 'passed' ? document.fileId : '',
    rejectionReason: status === 'rejected'
      ? document.rejectionReason || '头像未通过审核'
      : status === 'failed'
        ? document.rejectionReason || '头像审核暂时失败，可重新提交'
        : status === 'timed_out'
          ? '审核结果未按时返回，可重新提交，无需再次选择图片'
          : '',
    canRetry: status === 'failed' || status === 'timed_out',
    moderationDeadlineAt: Number.isFinite(deadline) ? new Date(deadline).toISOString() : '',
    createdAt: document.createdAt
  }
}

async function requestModeration(context, fileId) {
  let mediaUrl = ''
  try {
    const tempResult = await context.cloud.getTempFileURL({ fileList: [fileId] })
    const item = tempResult.fileList && tempResult.fileList[0]
    assert(item && !item.status && item.tempFileURL, 'INVALID_ARGUMENT', '无法读取头像文件')
    mediaUrl = item.tempFileURL
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('INVALID_ARGUMENT', '头像文件不存在或无权访问')
  }
  try {
    const result = await context.cloud.openapi.security.mediaCheckAsync({
      media_url: mediaUrl,
      media_type: 2,
      version: 2,
      scene: 1,
      openid: context.openid
    })
    const errCode = Number(result.errCode !== undefined ? result.errCode : result.errcode || 0)
    assert(errCode === 0, 'CONTENT_CHECK_UNAVAILABLE', '头像安全检查暂不可用，请稍后重试')
    const traceId = result.traceId || result.trace_id || ''
    assert(traceId, 'CONTENT_CHECK_UNAVAILABLE', '未收到头像审核编号，请稍后重试')
    return {
      traceId,
      deadlineAt: new Date(Date.now() + MODERATION_TIMEOUT_MS)
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    console.error('AVATAR_CHECK_FAILED', context.requestId, error)
    throw new ApiError('CONTENT_CHECK_UNAVAILABLE', '头像安全检查暂不可用，请稍后重试')
  }
}

async function status(context) {
  const result = await context.db.collection(COLLECTIONS.userMedia)
    .where({ userId: context.openid, purpose: 'avatar', deleted: context.command.neq(true) })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get()
  return { avatar: present(result.data[0]) }
}

async function register(context, payload) {
  const fileId = validate.text(payload.fileId, '头像文件', { min: 10, max: 500 })
  assert(/^cloud:\/\//.test(fileId), 'INVALID_ARGUMENT', '头像必须先上传到本小程序云存储')
  const mediaId = stableId('user-avatar', context.openid, validate.id(context.requestId, '请求 ID'))
  const ref = context.db.collection(COLLECTIONS.userMedia).doc(mediaId)
  const existing = await getDocument(ref)
  if (existing) return { avatar: present(existing), idempotent: true }
  await uploads.claim(context, payload.uploadToken, 'avatar', fileId)
  const moderation = await requestModeration(context, fileId)
  await ref.set({ data: {
    userId: context.openid,
    purpose: 'avatar',
    fileId,
    status: 'reviewing',
    moderationTraceId: moderation.traceId,
    moderationRequestId: context.requestId,
    moderationAttempt: 1,
    moderationRequestedAt: context.serverDate(),
    moderationDeadlineAt: moderation.deadlineAt,
    deleted: false,
    requestId: context.requestId,
    createdAt: context.serverDate(),
    updatedAt: context.serverDate()
  } })
  await writeAudit(context, 'profile.avatar.register', 'userMedia', mediaId, {})
  return { avatar: present(await getDocument(ref)), idempotent: false }
}

async function retry(context) {
  const result = await context.db.collection(COLLECTIONS.userMedia)
    .where({ userId: context.openid, purpose: 'avatar', deleted: context.command.neq(true) })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get()
  const document = result.data[0]
  assert(document, 'NOT_FOUND', '没有可重新审核的头像')
  if (document.moderationRequestId === context.requestId) {
    return { avatar: present(document), idempotent: true }
  }
  const currentStatus = effectiveStatus(document)
  assert(currentStatus === 'timed_out' || currentStatus === 'failed', 'AVATAR_REVIEW_NOT_RETRYABLE', '头像正在审核或已完成，请刷新状态')
  assert(document.fileId, 'NOT_FOUND', '头像文件已不存在，请重新选择')

  const previousTraceId = document.moderationTraceId || ''
  const moderation = await requestModeration(context, document.fileId)
  let stored = null
  let superseded = false
  let idempotent = false
  await context.db.runTransaction(async (transaction) => {
    const ref = transaction.collection(COLLECTIONS.userMedia).doc(document._id)
    const latest = await getDocument(ref)
    assert(latest && latest.userId === context.openid && latest.purpose === 'avatar' && latest.deleted !== true,
      'NOT_FOUND', '头像文件已不存在，请重新选择')
    if (latest.moderationRequestId === context.requestId) {
      idempotent = true
      stored = latest
      return
    }
    // A late callback or another retry may have won while the OpenAPI request
    // was in flight. Never regress a terminal status back to reviewing.
    if (effectiveStatus(latest) !== currentStatus || (latest.moderationTraceId || '') !== previousTraceId) {
      superseded = true
      stored = latest
      return
    }
    await ref.update({ data: {
      status: 'reviewing',
      rejectionReason: '',
      moderationTraceId: moderation.traceId,
      moderationRequestId: context.requestId,
      moderationAttempt: Number(latest.moderationAttempt || 1) + 1,
      moderationRequestedAt: context.serverDate(),
      moderationDeadlineAt: moderation.deadlineAt,
      updatedAt: context.serverDate()
    } })
    stored = Object.assign({}, latest, {
      status: 'reviewing',
      rejectionReason: '',
      moderationTraceId: moderation.traceId,
      moderationRequestId: context.requestId,
      moderationAttempt: Number(latest.moderationAttempt || 1) + 1,
      moderationRequestedAt: new Date(),
      moderationDeadlineAt: moderation.deadlineAt
    })
  })
  if (!superseded && !idempotent) await writeAudit(context, 'profile.avatar.retry', 'userMedia', document._id, {})
  return { avatar: present(stored), idempotent, superseded }
}

async function remove(context) {
  const fileId = context.user.profile && context.user.profile.avatarFileId || ''
  const profile = Object.assign({}, context.user.profile || {}, { avatarFileId: '' })
  const mediaResult = await context.db.collection(COLLECTIONS.userMedia)
    .where({ userId: context.openid, purpose: 'avatar', deleted: context.command.neq(true) })
    .limit(20)
    .get()
  await context.db.collection(COLLECTIONS.users).doc(context.openid).update({ data: { profile, updatedAt: context.serverDate() } })
  await context.db.collection(COLLECTIONS.userMedia).where({ userId: context.openid, purpose: 'avatar', deleted: context.command.neq(true) }).update({
    data: { deleted: true, status: 'deleted', updatedAt: context.serverDate() }
  })
  const fileIds = Array.from(new Set([fileId].concat(mediaResult.data.map((item) => item.fileId)).filter(Boolean)))
  if (fileIds.length) {
    try { await context.cloud.deleteFile({ fileList: fileIds }) } catch (error) { console.error('AVATAR_DELETE_FAILED', context.requestId, error) }
  }
  await writeAudit(context, 'profile.avatar.remove', 'user', 'self', {})
  return { deleted: true }
}

module.exports = {
  status,
  register,
  retry,
  remove,
  _private: { MODERATION_TIMEOUT_MS, deadlineFor, effectiveStatus, present, requestModeration, timestampMillis }
}
