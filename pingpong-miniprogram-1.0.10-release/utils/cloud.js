const config = require('./cloud-config')
const policy = require('./request-policy')
const diagnostics = require('./diagnostics')

let initialized = ''
let readGeneration = 0
const inFlightReads = new Map()
const AVATAR_MAX_BYTES = 5 * 1024 * 1024

function invalidateReads() { readGeneration += 1; inFlightReads.clear() }

class CloudApiError extends Error {
  constructor(code, message, details, requestId) {
    super(message)
    this.name = 'CloudApiError'
    this.code = code
    this.details = details || null
    this.requestId = requestId || ''
  }
}
function createRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

function assertConfigured() {
  if (typeof wx === 'undefined' || !wx.cloud) {
    throw new CloudApiError('CLOUD_UNAVAILABLE', '当前微信基础库不支持云开发')
  }
  const cloudEnvId = typeof config.resolveCloudEnvId === 'function' ? config.resolveCloudEnvId() : config.cloudEnvId
  if (!cloudEnvId || /^YOUR_.*_CLOUD_ENV_ID$/.test(cloudEnvId)) {
    throw new CloudApiError('CLOUD_ENV_NOT_CONFIGURED', '尚未配置当前版本对应的云环境 ID')
  }
  return cloudEnvId
}

function init() {
  const cloudEnvId = assertConfigured()
  if (initialized !== cloudEnvId) {
    invalidateReads()
    wx.cloud.init({ env: cloudEnvId, traceUser: true })
    initialized = cloudEnvId
  }
}

function transportError(error, requestId) {
  const cause = String(error && (error.errMsg || error.message) || '').slice(0, 200)
  if (/FUNCTION_NOT_FOUND|FUNCTION_NOT_EXIST|function.{0,20}(not exist|not found)|找不到对应的FunctionName/i.test(cause)) {
    return new CloudApiError('CLOUD_FUNCTION_NOT_DEPLOYED', '云端服务尚未部署，请更新云函数', null, requestId)
  }
  return new CloudApiError(
    'NETWORK_ERROR',
    '网络连接失败，请检查网络后重试',
    { cause: cause || 'unknown' },
    requestId
  )
}

function responseError(error = {}, requestId) {
  const code = error.code || 'UNKNOWN'
  const details = error.details || null
  let message = error.message || '操作失败'
  if (code === 'ACTION_NOT_FOUND') {
    message = '该功能正在更新，请稍后重新打开小程序'
  }
  if (code === 'CONSENT_VERSION_MISMATCH') {
    message = '当前小程序版本过旧，请关闭后重新打开或更新后重试'
  }
  if (code === 'API_VERSION_UNSUPPORTED' && Number(details && details.supportedVersion) < Number(config.apiVersion)) {
    message = '服务正在更新，请稍后重新打开小程序'
  }
  return new CloudApiError(code, message, details, requestId)
}

function uploadError(error, requestId, mediaLabel = '文件', maxSizeMb = 100) {
  const cause = String(error && (error.errMsg || error.message) || 'unknown').slice(0, 200)
  if (/too\s*large|entity\s*too\s*large|file.{0,12}size|size.{0,12}(?:limit|exceed)|exceed.{0,12}size|100\s*mb|\b413\b/i.test(cause)) {
    return new CloudApiError('UPLOAD_TOO_LARGE', `${mediaLabel}超过 ${maxSizeMb}MB，请压缩后重试`, { cause }, requestId)
  }
  if (/permission|forbidden|unauthori[sz]ed|access\s*denied|permission\s*deny|storage|bucket|cloud\s*path|environment|env\s*not|\b403\b|-60100/i.test(cause)) {
    return new CloudApiError('UPLOAD_STORAGE_UNAVAILABLE', '云存储权限或环境配置异常，请稍后重试', { cause }, requestId)
  }
  if (/network|timeout|timed\s*out|offline|socket|connection|dns|request:fail/i.test(cause)) {
    return new CloudApiError('NETWORK_ERROR', '网络连接失败，请检查网络后重试', { cause }, requestId)
  }
  return new CloudApiError('UPLOAD_FAILED', `${mediaLabel}上传失败，请稍后重试`, { cause }, requestId)
}

function isRetryableApiError(error, action) {
  // SERVICE_UNAVAILABLE represents a transient backend condition. Calls keep
  // the same requestId; restrict automatic replay to reads and the explicitly
  // idempotent message/session writes so unknown future writes are never duplicated.
  const retrySafe = policy.isRead(action) || action === 'messages.send' || action === 'bootstrap'
  return retrySafe && error instanceof CloudApiError && error.code === 'SERVICE_UNAVAILABLE'
}

function waitBeforeRetry(attempt, remainingMs) {
  const delay = Math.min(Math.max(0, remainingMs), 120 * (attempt + 1) + Math.floor(Math.random() * 80))
  return new Promise((resolve) => setTimeout(resolve, delay))
}

function deadlineError(action, requestId) {
  return new CloudApiError('REQUEST_TIMEOUT', policy.isRead(action) ? '加载超时，请检查网络后重试' : '请求结果尚未确认，请刷新状态后再试',
    { outcomeUnknown: !policy.isRead(action) }, requestId)
}

function withDeadline(work, durationMs, action, requestId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(deadlineError(action, requestId)), durationMs)
    Promise.resolve().then(work).then(
      result => { clearTimeout(timer); resolve(result) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

async function execute(action, payload, options) {
  const requestId = options.requestId || createRequestId()
  const attempts = options.retry === false || !policy.canRetry(action) ? 1 : 2
  const startedAt = Date.now()
  const deadline = startedAt + policy.timeoutMs(action, options)
  let attemptCount = 0
  let resultCode = 'OK'
  try {
    let lastError
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (Date.now() >= deadline) throw deadlineError(action, requestId)
      attemptCount += 1
      try {
        const response = await withDeadline(() => wx.cloud.callFunction({
          name: config.apiFunctionName,
          data: {
            apiVersion: config.apiVersion,
            action,
            payload,
            requestId,
            publicRead: options.publicRead === true
          }
        }), Math.max(1, deadline - Date.now()), action, requestId)
        const result = response && response.result
        if (!result || typeof result.ok !== 'boolean') {
          throw new CloudApiError('INVALID_SERVER_RESPONSE', '服务返回格式异常', { outcomeUnknown: !policy.isRead(action) }, requestId)
        }
        if (!result.ok) {
          const error = result.error || {}
          throw responseError(error, result.requestId || requestId)
        }
        return result.data
      } catch (error) {
        if (error instanceof CloudApiError) {
          lastError = error
          if (!isRetryableApiError(error, action) || attempt + 1 >= attempts) throw error
          await waitBeforeRetry(attempt, deadline - Date.now())
          continue
        }
        lastError = transportError(error, requestId)
        if (!policy.isRead(action) && lastError.code === 'NETWORK_ERROR') {
          lastError.message = '网络中断，操作结果待确认，请刷新后再试'
          lastError.details.outcomeUnknown = true
        }
        if (lastError.code !== 'NETWORK_ERROR' || attempt + 1 >= attempts) throw lastError
        await waitBeforeRetry(attempt, deadline - Date.now())
      }
    }
    if (lastError instanceof CloudApiError) throw lastError
    throw transportError(lastError, requestId)
  } catch (error) {
    resultCode = error.code || 'UNKNOWN'
    throw error
  } finally {
    diagnostics.record({ action, durationMs: Date.now() - startedAt, attempts: attemptCount, code: resultCode })
  }
}

async function call(action, payload = {}, options = {}) {
  init()
  const read = policy.isRead(action)
  if (!read) {
    // Detach reads both before and after a mutation, including uncertain writes.
    // A read started before a successful write must not serve a later refresh.
    invalidateReads()
    try { return await execute(action, payload, options) } finally { invalidateReads() }
  }
  const key = `${readGeneration}:${policy.key(action, payload, options)}`
  const deduplicate = options.deduplicate !== false && !options.requestId
  let work = deduplicate && inFlightReads.get(key)
  if (!work) {
    work = execute(action, payload, options)
    if (deduplicate) {
      inFlightReads.set(key, work)
      const cleanup = () => { if (inFlightReads.get(key) === work) inFlightReads.delete(key) }
      work.then(cleanup, cleanup)
    }
  }
  const result = await work
  // Coalesced consumers receive separate JSON objects, not shared mutable state.
  return result === undefined ? result : JSON.parse(JSON.stringify(result))
}

function avatarExtension(value) {
  const normalized = String(value || '').toLowerCase().replace(/^image\//, '')
  if (normalized === 'jpg' || normalized === 'jpeg') return 'jpg'
  if (normalized === 'png') return 'png'
  return ''
}

function avatarPathExtension(filePath) {
  const pathWithoutQuery = String(filePath || '').split(/[?#]/, 1)[0]
  const match = pathWithoutQuery.match(/\.([A-Za-z0-9]{2,5})$/)
  return avatarExtension(match && match[1])
}

function getImageInfo(filePath) {
  if (typeof wx.getImageInfo !== 'function') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    try {
      wx.getImageInfo({ src: filePath, success: resolve, fail: reject })
    } catch (error) {
      reject(error)
    }
  })
}

function getLocalFileSize(filePath) {
  if (typeof wx.getFileInfo === 'function') {
    return new Promise((resolve) => {
      try {
        wx.getFileInfo({
          filePath,
          success: (result) => resolve(Number(result && result.size)),
          fail: () => resolve(NaN)
        })
      } catch (_) {
        resolve(NaN)
      }
    })
  }
  if (typeof wx.getFileSystemManager === 'function') {
    return new Promise((resolve) => {
      try {
        wx.getFileSystemManager().stat({
          path: filePath,
          success: (result) => resolve(Number(result && result.stats && result.stats.size)),
          fail: () => resolve(NaN)
        })
      } catch (_) {
        resolve(NaN)
      }
    })
  }
  return Promise.resolve(NaN)
}

async function inspectAvatar(filePath, requestId) {
  const pathExtension = avatarPathExtension(filePath)
  let imageInfo = null
  try {
    imageInfo = await getImageInfo(filePath)
  } catch (error) {
    if (!pathExtension) {
      throw new CloudApiError('INVALID_ARGUMENT', '无法读取头像文件，请重新选择', {
        cause: String(error && (error.errMsg || error.message) || 'unknown').slice(0, 200)
      }, requestId)
    }
  }
  const detectedType = imageInfo && imageInfo.type
  const extension = detectedType ? avatarExtension(detectedType) : pathExtension
  if (!extension) {
    throw new CloudApiError('INVALID_ARGUMENT', '头像仅支持 JPG 或 PNG 图片，请重新选择', null, requestId)
  }
  const size = await getLocalFileSize(filePath)
  if (Number.isFinite(size) && size > AVATAR_MAX_BYTES) {
    throw new CloudApiError('UPLOAD_TOO_LARGE', '头像超过 5MB，请压缩后重试', {
      size,
      maxSize: AVATAR_MAX_BYTES
    }, requestId)
  }
  return { extension, size: Number.isFinite(size) ? size : null }
}

async function uploadAvatar(tempFilePath, options = {}) {
  if (!tempFilePath) throw new CloudApiError('INVALID_ARGUMENT', '请选择头像文件')
  const requestId = options.requestId || createRequestId()
  const { extension } = await inspectAvatar(tempFilePath, requestId)
  const policy = await call('files.prepareUpload', { purpose: 'avatar', extension }, { requestId })
  const cloudPath = policy.cloudPath
  let uploaded
  try {
    const uploadTask = wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath })
    if (options.onProgress && uploadTask && typeof uploadTask.onProgressUpdate === 'function') uploadTask.onProgressUpdate(options.onProgress)
    uploaded = await uploadTask
  } catch (error) {
    throw uploadError(error, requestId, '头像', 5)
  }
  if (!uploaded || !uploaded.fileID) throw new CloudApiError('UPLOAD_FAILED', '云存储未返回头像文件信息，请重试', null, requestId)
  try {
    return await call('profile.avatar.register', { fileId: uploaded.fileID, uploadToken: policy.uploadToken }, { requestId })
  } catch (error) {
    if (['INVALID_ARGUMENT', 'UPLOAD_TICKET_INVALID', 'UPLOAD_TICKET_EXPIRED', 'UPLOAD_TICKET_USED', 'CONTENT_CHECK_UNAVAILABLE'].includes(error.code)) {
      try { await wx.cloud.deleteFile({ fileList: [uploaded.fileID] }) } catch (_) {}
    }
    throw error
  }
}

async function resolveFileUrls(fileIds, options = {}) {
  const unique = Array.from(new Set((fileIds || []).filter(Boolean)))
  if (!unique.length) return { urls: {}, unresolved: [] }
  const batches = []
  for (let index = 0; index < unique.length; index += 20) batches.push(unique.slice(index, index + 20))
  const results = await Promise.all(batches.map((batch) => call('files.resolve', { fileIds: batch }, options)))
  const urls = {}
  results.forEach((result) => Object.assign(urls, result.urls || {}))
  return { urls, unresolved: unique.filter((fileId) => !urls[fileId]) }
}

module.exports = {
  CloudApiError,
  createRequestId,
  init,
  call,
  invalidateReads,
  uploadAvatar,
  resolveFileUrls,
  _private: { avatarExtension, avatarPathExtension, inspectAvatar, responseError, AVATAR_MAX_BYTES }
}
