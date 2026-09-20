const config = require('./cloud-config')
const policy = require('./request-policy')
const diagnostics = require('./diagnostics')

let initialized = ''
let readGeneration = 0
const inFlightReads = new Map()

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
  resolveFileUrls,
  _private: { responseError }
}
