const TARGET_LOOKUP_DELAYS_MS = [0, 80, 200, 400]

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function parseObject(value) {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (_) {
    return null
  }
}

function normalizeEvent(input) {
  const root = parseObject(input) || {}
  const body = parseObject(root.body)
  if (body) return body
  const data = parseObject(root.data)
  if (data && (data.Event || data.event || data.trace_id || data.traceId)) return data
  return root
}

function numberValue(value, fallback = 0) {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

function callbackResult(event) {
  const result = parseObject(event.result) || {}
  const errCode = numberValue(event.errcode !== undefined ? event.errcode : event.errCode, 0)
  const statusCode = numberValue(event.status_code !== undefined ? event.status_code : event.statusCode, 0)
  const suggest = String(result.suggest || event.suggest || '').toLowerCase()
  const label = numberValue(result.label !== undefined ? result.label : event.label, 0)
  if (errCode !== 0 || statusCode !== 0 || !['pass', 'risky', 'review'].includes(suggest)) {
    return {
      status: 'failed',
      rejectionReason: statusCode ? '审核服务无法读取头像，可重新提交审核' : '头像审核暂时失败，可重新提交',
      moderationResult: { suggest: suggest || 'unknown', label, errCode, statusCode }
    }
  }
  if (suggest === 'pass') {
    return {
      status: 'passed',
      rejectionReason: '',
      moderationResult: { suggest, label, errCode, statusCode }
    }
  }
  return {
    status: 'rejected',
    rejectionReason: '头像内容未通过平台安全审核，请更换图片',
    moderationResult: { suggest, label, errCode, statusCode }
  }
}

async function safeGet(ref) {
  try {
    const result = await ref.get()
    return result && result.data || null
  } catch (error) {
    const message = `${error && error.errCode || ''} ${error && error.errMsg || ''} ${error && error.message || ''}`
    if (/DOCUMENT_NOT_EXIST|not exist|does not exist|找不到|不存在/i.test(message)) return null
    throw error
  }
}

async function findTarget(db, traceId, sleep = wait) {
  for (let attempt = 0; attempt < TARGET_LOOKUP_DELAYS_MS.length; attempt += 1) {
    const delay = TARGET_LOOKUP_DELAYS_MS[attempt]
    if (delay) await sleep(delay)
    const result = await db.collection('user_media')
      .where({ moderationTraceId: traceId })
      .limit(1)
      .get()
    if (result.data && result.data.length) return result.data[0]
  }
  return null
}

async function deleteFiles(cloud, fileIds, logLabel, recordId) {
  const unique = Array.from(new Set((fileIds || []).filter(Boolean)))
  if (!unique.length) return
  try {
    await cloud.deleteFile({ fileList: unique })
  } catch (error) {
    console.error(logLabel, recordId, error)
  }
}

async function applyDecision(db, mediaId, traceId, decision) {
  let outcome = { ignored: true, media: null }
  await db.runTransaction(async (transaction) => {
    const ref = transaction.collection('user_media').doc(mediaId)
    const latest = await safeGet(ref)
    if (!latest || latest.purpose !== 'avatar' || latest.deleted === true) return

    // The lookup and this write are separated by several awaits. A retry may
    // have installed a new trace_id in between; an older callback must never
    // decide the newer moderation attempt.
    if (String(latest.moderationTraceId || '').trim() !== traceId) {
      outcome = { ignored: true, superseded: true, media: latest }
      return
    }
    if (latest.status === 'passed' && decision.status === 'passed') {
      outcome = { duplicate: true, media: latest }
      return
    }
    if (!['reviewing', 'failed'].includes(latest.status)) {
      outcome = { ignored: true, media: latest }
      return
    }

    await ref.update({ data: {
      status: decision.status,
      rejectionReason: decision.rejectionReason,
      moderationResult: decision.moderationResult,
      moderatedAt: db.serverDate(),
      updatedAt: db.serverDate()
    } })
    outcome = {
      applied: true,
      media: Object.assign({}, latest, {
        status: decision.status,
        rejectionReason: decision.rejectionReason,
        moderationResult: decision.moderationResult
      })
    }
  })
  return outcome
}

async function promoteAvatar({ cloud, db }, media) {
  const latestResult = await db.collection('user_media').where({
    userId: media.userId,
    purpose: 'avatar',
    deleted: db.command.neq(true)
  }).orderBy('createdAt', 'desc').limit(1).get()
  const latest = latestResult.data && latestResult.data[0]
  if (!latest || latest._id !== media._id) {
    await db.collection('user_media').doc(media._id).update({ data: {
      status: 'replaced',
      deleted: true,
      updatedAt: db.serverDate()
    } })
    await deleteFiles(cloud, [media.fileId], 'STALE_AVATAR_DELETE_FAILED', media._id)
    return { stale: true }
  }

  const user = await safeGet(db.collection('users').doc(media.userId))
  if (!user || user.status !== 'active') {
    await db.collection('user_media').doc(media._id).update({ data: {
      status: 'replaced',
      deleted: true,
      updatedAt: db.serverDate()
    } })
    await deleteFiles(cloud, [media.fileId], 'ORPHAN_AVATAR_DELETE_FAILED', media._id)
    return { orphaned: true }
  }

  const previousFileId = user.profile && user.profile.avatarFileId || ''
  await db.collection('users').doc(media.userId).update({ data: {
    profile: Object.assign({}, user.profile || {}, { avatarFileId: media.fileId }),
    updatedAt: db.serverDate()
  } })

  const oldResult = await db.collection('user_media').where({
    userId: media.userId,
    purpose: 'avatar',
    status: 'passed',
    deleted: false
  }).limit(20).get()
  await Promise.all((oldResult.data || []).filter((item) => item._id !== media._id).map((item) =>
    db.collection('user_media').doc(item._id).update({ data: {
      deleted: true,
      status: 'replaced',
      updatedAt: db.serverDate()
    } })
  ))
  await deleteFiles(cloud, previousFileId && previousFileId !== media.fileId ? [previousFileId] : [], 'OLD_AVATAR_DELETE_FAILED', media._id)
  return { promoted: true }
}

function createHandler({ cloud, db, sleep = wait }) {
  return async (input = {}) => {
    const event = normalizeEvent(input)
    const eventName = String(event.Event || event.event || '').toLowerCase()
    const msgType = String(event.MsgType || event.msgType || event.msg_type || '').toLowerCase()
    const traceId = String(event.trace_id || event.traceId || '').trim()
    if (eventName !== 'wxa_media_check' || (msgType && msgType !== 'event') || !traceId) {
      console.error('INVALID_MEDIA_CALLBACK', { eventName, msgType, hasTraceId: Boolean(traceId) })
      return { ok: false, code: 'INVALID_MEDIA_CALLBACK' }
    }

    const media = await findTarget(db, traceId, sleep)
    if (!media) {
      // A callback can race the write that stores trace_id. Returning a
      // non-success result makes the missing correlation visible in logs;
      // the bounded lookup above handles the normal sub-second race.
      console.error('MEDIA_CALLBACK_TARGET_NOT_FOUND', { traceId })
      return { ok: false, code: 'MEDIA_CALLBACK_TARGET_NOT_FOUND', retryable: true }
    }
    if (media.purpose !== 'avatar' || media.deleted === true) return { ok: true, ignored: true }

    const decision = callbackResult(event)
    const outcome = await applyDecision(db, media._id, traceId, decision)
    if (outcome.superseded) return { ok: true, ignored: true, superseded: true }
    if (outcome.ignored) return { ok: true, ignored: true }
    if (outcome.duplicate) {
      const recovery = await promoteAvatar({ cloud, db }, outcome.media)
      return Object.assign({ ok: true, duplicate: true }, recovery)
    }

    if (decision.status === 'passed') {
      const recovery = await promoteAvatar({ cloud, db }, outcome.media)
      return Object.assign({ ok: true }, recovery)
    }
    if (decision.status === 'rejected') {
      await deleteFiles(cloud, [outcome.media.fileId], 'REJECTED_MEDIA_DELETE_FAILED', outcome.media._id)
    }
    return { ok: true, status: decision.status }
  }
}

module.exports = {
  createHandler,
  _private: { TARGET_LOOKUP_DELAYS_MS, normalizeEvent, callbackResult, findTarget, safeGet, applyDecision }
}
