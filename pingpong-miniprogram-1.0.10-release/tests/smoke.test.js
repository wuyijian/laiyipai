const assert = require('assert')
const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const apiPath = path.join(projectRoot, 'utils', 'api.js')
const cloudPath = path.join(projectRoot, 'utils', 'cloud.js')
const cloudConfigPath = path.join(projectRoot, 'utils', 'cloud-config.js')
const privacyPath = path.join(projectRoot, 'utils', 'privacy.js')
const appPath = path.join(projectRoot, 'app.js')

const memory = Object.create(null)
const navigation = []
const notices = []
const openedLocations = []
const cloudCalls = []
const tests = []
let requestSequence = 0
let capturedPage = null
let capturedApp = null
let activeApp = {
  globalData: { session: { profile: { playerId: 'player-test' } } },
  ensureSession: async () => ({ profile: { playerId: 'player-test' }, policies: {} })
}
let cloudHandler = async () => ({ result: { ok: true, data: {}, requestId: 'req_test' } })
let cloudUploadHandler = () => {
  const task = Promise.resolve({ fileID: 'cloud://test/avatar.jpg' })
  task.onProgressUpdate = () => {}
  return task
}
let chooseMediaHandler = (options) => {
  if (options.fail) options.fail({ errMsg: 'chooseMedia:fail cancel' })
}
let privacyAuthorizationCount = 0

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function setPath(target, key, value) {
  const parts = key.split('.')
  let cursor = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!cursor[parts[index]] || typeof cursor[parts[index]] !== 'object') cursor[parts[index]] = {}
    cursor = cursor[parts[index]]
  }
  cursor[parts[parts.length - 1]] = value
}

global.wx = {
  cloud: {
    init(options) { cloudCalls.push({ method: 'init', options: clone(options) }) },
    callFunction(options) {
      cloudCalls.push({ method: 'callFunction', options: clone(options) })
      return cloudHandler(options)
    },
    uploadFile(options) { return cloudUploadHandler(options) },
    deleteFile: async () => ({})
  },
  getStorageSync(key) { return memory[key] },
  setStorageSync(key, value) { memory[key] = clone(value) },
  removeStorageSync(key) { delete memory[key] },
  getStorageInfoSync() { return { currentSize: 1, limitSize: 10240, keys: Object.keys(memory) } },
  showToast(options) { notices.push({ type: 'toast', options: clone(options) }) },
  showModal(options) {
    notices.push({ type: 'modal', options: clone(options) })
    if (options.success) options.success({ confirm: true, cancel: false })
  },
  showActionSheet(options) { if (options.success) options.success({ tapIndex: 0 }) },
  navigateTo(options) { navigation.push({ type: 'navigateTo', url: options.url }) },
  navigateBack() { navigation.push({ type: 'navigateBack' }) },
  switchTab(options) { navigation.push({ type: 'switchTab', url: options.url }) },
  pageScrollTo() {},
  stopPullDownRefresh() {},
  setClipboardData(options) { memory.clipboard = options.data },
  openSetting() {},
  openLocation(options) { openedLocations.push(options) },
  makePhoneCall() {},
  chooseMedia(options) { return chooseMediaHandler(options) },
  requirePrivacyAuthorize(options) {
    privacyAuthorizationCount += 1
    if (options.success) options.success({})
  },
  openPrivacyContract() {},
  getFileInfo(options) {
    if (options.success) options.success({ size: 8192 })
  }
}

global.Page = (definition) => { capturedPage = definition }
global.App = (definition) => { capturedApp = definition }
global.getApp = () => activeApp

function instantiate(definition) {
  const instance = {}
  Object.keys(definition).forEach((key) => {
    instance[key] = key === 'data' || key === 'globalData' ? clone(definition[key]) : definition[key]
  })
  instance.setData = function setData(patch, callback) {
    Object.keys(patch).forEach((key) => setPath(this.data, key, patch[key]))
    if (callback) callback()
  }
  return instance
}

function clearModule(filename) {
  const resolved = require.resolve(filename)
  delete require.cache[resolved]
}

function mockModule(filename, exports) {
  const resolved = require.resolve(filename)
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: []
  }
}

function mergeApi(overrides = {}) {
  const emptyPage = async () => ({ items: [], page: 1, pageSize: 50, hasMore: false })
  const base = {
    init() {},
    createRequestId() { requestSequence += 1; return `req_client_${requestSequence}` },
    bootstrap: async () => ({ profile: {}, policies: {} }),
    venues: { list: emptyPage, nearby: emptyPage, get: async ({ venueId }) => venueFixture(venueId) },
    matches: {
      list: emptyPage,
      get: async ({ matchId }) => ({ match: matchFixture({ id: matchId }), membership: null, confirmedCount: 1 }),
      create: async () => ({ match: matchFixture(), membership: { status: 'host', canChat: true } }),
      join: async () => ({ match: matchFixture(), membership: { status: 'joined', canChat: true } }),
      pending: emptyPage,
      respondJoin: async () => ({}),
      cancel: async () => ({}),
      reschedule: async () => ({}),
      confirmSchedule: async () => ({})
    },
    coaches: { list: emptyPage, get: async () => ({ coach: {}, slots: [] }) },
    coachBookings: { create: async () => ({}), cancel: async () => ({}) },
    appointments: { list: emptyPage },
    favorites: { list: emptyPage, status: async () => ({ markedIds: [] }), set: async () => ({}) },
    profile: {
      get: async () => profileFixture(),
      update: async (payload) => payload,
      uploadAvatar: async () => ({}),
      avatarStatus: async () => ({ avatar: null }),
      removeAvatar: async () => ({})
    },
    players: { get: async () => ({ player: {}, isSelf: false }) },
    messages: { list: emptyPage, send: async ({ text }) => ({ message: { id: 'message-1', text, createdAt: new Date().toISOString() } }) },
    safety: { listBlocks: emptyPage, block: async () => ({}), report: async () => ({}) },
    files: { resolve: async () => ({ urls: {}, unresolved: [] }) },
    account: { delete: async () => ({}) }
  }
  Object.keys(overrides).forEach((key) => {
    if (base[key] && typeof base[key] === 'object' && typeof overrides[key] === 'object') {
      base[key] = Object.assign({}, base[key], overrides[key])
    } else {
      base[key] = overrides[key]
    }
  })
  return base
}

function installApi(overrides) {
  const api = mergeApi(overrides)
  mockModule(apiPath, api)
  return api
}

function installPrivacy(authorize) {
  mockModule(privacyPath, {
    authorize: authorize || (async () => {}),
    openContract() {}
  })
}

function loadPage(relativePath) {
  const fullPath = path.join(projectRoot, relativePath)
  capturedPage = null
  clearModule(fullPath)
  require(fullPath)
  assert(capturedPage, `Page() was not called by ${relativePath}`)
  return instantiate(capturedPage)
}

function resetRuntime() {
  Object.keys(memory).forEach((key) => delete memory[key])
  navigation.splice(0)
  notices.splice(0)
  openedLocations.splice(0)
  cloudCalls.splice(0)
  requestSequence = 0
  privacyAuthorizationCount = 0
  cloudUploadHandler = () => {
    const task = Promise.resolve({ fileID: 'cloud://test/avatar.jpg' })
    task.onProgressUpdate = () => {}
    return task
  }
  chooseMediaHandler = (options) => {
    if (options.fail) options.fail({ errMsg: 'chooseMedia:fail cancel' })
  }
  activeApp = {
    globalData: { session: { profile: { playerId: 'player-test' } } },
    ensureSession: async () => ({ profile: { playerId: 'player-test' }, policies: {} })
  }
  installPrivacy()
}

function test(name, callback) {
  tests.push({ name, callback })
}

function walk(dir, extension) {
  const output = []
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== 'node_modules') output.push(...walk(fullPath, extension))
    else if (!entry.isDirectory() && fullPath.endsWith(extension)) output.push(fullPath)
  })
  return output
}

function findTagEnd(source, start) {
  let quote = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return index
    }
  }
  return -1
}

function validateWxmlTags(source, filename) {
  const stack = []
  const voidTags = new Set(['input', 'image', 'icon', 'progress'])
  let cursor = 0
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor)
    if (start < 0) break
    const commentEnd = source.startsWith('<!--', start) ? source.indexOf('-->', start) : -1
    const end = commentEnd >= 0 ? commentEnd + 2 : findTagEnd(source, start)
    assert(end >= 0, `${filename}: unclosed tag at ${start}`)
    const raw = source.slice(start, end + 1)
    cursor = end + 1
    if (raw.startsWith('<!--') || raw.startsWith('<!') || raw.startsWith('<?')) continue
    const closing = /^<\s*\//.test(raw)
    const nameMatch = raw.match(/^<\s*\/?\s*([\w-]+)/)
    if (!nameMatch) continue
    const name = nameMatch[1]
    if (closing) {
      const expected = stack.pop()
      assert.strictEqual(name, expected, `${filename}: expected </${expected}> but found </${name}>`)
    } else if (!/\/\s*>$/.test(raw) && !voidTags.has(name)) {
      stack.push(name)
    }
  }
  assert.strictEqual(stack.length, 0, `${filename}: unclosed <${stack[stack.length - 1]}>`)
}

function dateString(offsetDays) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function venueFixture(id = 'venue_huanglong') {
  return {
    id,
    name: id === 'venue_huanglong' ? '黄龙体育中心乒乓球馆' : '西湖文体中心乒乓球馆',
    city: '杭州',
    district: '西湖区',
    address: '杭州市西湖区黄龙路 1 号',
    verified: true,
    active: true
  }
}

function nameOnlyVenueFixture(id = 'venue_xiaochao') {
  const isXiaochao = id === 'venue_xiaochao'
  return {
    id,
    name: isXiaochao ? '萧潮乒乓球馆' : '桂语朝阳乒乓球室',
    city: '杭州',
    district: '',
    address: '',
    location: null,
    phone: '',
    listingMode: 'name_only',
    nameOnly: true,
    activityTags: isXiaochao ? ['教学', '比赛', '训练', '切磋'] : ['切磋'],
    verified: false,
    active: true
  }
}

function matchFixture(overrides = {}) {
  const capacity = overrides.capacity === undefined ? 4 : overrides.capacity
  const participantCount = overrides.participantCount === undefined ? 1 : overrides.participantCount
  return Object.assign({
    id: 'match-1',
    title: '周末练球',
    venueId: 'venue_huanglong',
    venue: venueFixture(),
    city: '杭州',
    district: '西湖区',
    date: dateString(3),
    startTime: '19:00',
    endTime: '20:30',
    startAt: `${dateString(3)}T19:00:00+08:00`,
    endAt: `${dateString(3)}T20:30:00+08:00`,
    capacity,
    participantCount,
    seats: Math.max(0, capacity - participantCount),
    feePerPerson: 30,
    expectedBallAge: '球龄 2—5 年',
    skills: ['基本功'],
    joinMode: 'direct',
    courtStatus: 'booked',
    status: participantCount >= capacity ? 'full' : 'recruiting',
    version: 3,
    scheduleVersion: 1,
    host: { playerId: 'player-host', displayName: '林先生', ballAge: '球龄 5 年以上', skills: ['正手弧圈'] },
    participants: [{ playerId: 'player-host', displayName: '林先生' }]
  }, overrides)
}

function profileFixture(overrides = {}) {
  return Object.assign({
    playerId: 'player-me',
    nickname: '小林',
    city: '杭州',
    district: '西湖区',
    ballAge: '球龄 2—5 年',
    skills: ['正手弧圈'],
    ratingPlatform: '未填写',
    ratingValue: '',
    avatarFileId: '',
    completedMatches: 3,
    punctualityRate: 100
  }, overrides)
}

function matchAppointment(id, status, offsetDays, membershipStatus = status) {
  return {
    id,
    type: 'match',
    status,
    membershipStatus,
    match: matchFixture({
      id: `resource-${id}`,
      date: dateString(offsetDays),
      startAt: `${dateString(offsetDays)}T19:00:00+08:00`,
      endAt: `${dateString(offsetDays)}T20:30:00+08:00`,
      version: 7
    }),
    updatedAt: new Date().toISOString()
  }
}

function coachAppointment(id, status, offsetDays) {
  return {
    id,
    type: 'coach',
    status,
    booking: {
      id: `resource-${id}`,
      coach: { id: 'coach-1', name: '陈教练' },
      venue: venueFixture(),
      startAt: `${dateString(offsetDays)}T10:00:00+08:00`,
      endAt: `${dateString(offsetDays)}T11:00:00+08:00`,
      price: 180,
      version: 5
    },
    updatedAt: new Date().toISOString()
  }
}

function parseShareQuery(query) {
  const result = {}
  if (!query) return result
  String(query).split('&').filter(Boolean).forEach((pair) => {
    const separator = pair.indexOf('=')
    const rawKey = separator >= 0 ? pair.slice(0, separator) : pair
    const rawValue = separator >= 0 ? pair.slice(separator + 1) : ''
    const decode = (value) => decodeURIComponent(String(value).replace(/\+/g, ' '))
    result[decode(rawKey)] = decode(rawValue)
  })
  return result
}

function assertTimelinePayload(share, options) {
  assert(share && typeof share === 'object', `${options.page}: onShareTimeline must return an object`)
  assert.strictEqual(typeof share.title, 'string', `${options.page}: timeline title missing`)
  assert(share.title.includes(options.titleText), `${options.page}: title must come from the loaded resource`)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(share, 'path'), false, `${options.page}: timeline sharing must use query, not path`)
  const query = parseShareQuery(share.query)
  assert.deepStrictEqual(Object.keys(query), ['id'], `${options.page}: only the canonical resource id may be serialized`)
  assert.strictEqual(query.id, options.id, `${options.page}: shared id cannot restore the landing page`)
  if (share.imageUrl) {
    assert(/^https:\/\//.test(share.imageUrl), `${options.page}: share image must be a resolved remote URL`)
    assert(options.liveImages.includes(share.imageUrl), `${options.page}: share image must come from live cloud data`)
  }
  assert(!/(?:demo|mock|placeholder|example\.(?:com|cn))/i.test(String(share.imageUrl || '')), `${options.page}: fictional share image detected`)
  return query
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function nextEventLoopTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('云 API 使用真实 wx.cloud 契约、同一 requestId 重试且不回退演示数据', async () => {
  resetRuntime()
  const config = require(cloudConfigPath)
  const originalEnvId = config.cloudEnvId
  config.cloudEnvId = 'laiyipai-test-env'
  clearModule(cloudPath)
  clearModule(apiPath)
  let attempts = 0
  cloudHandler = async (options) => {
    attempts += 1
    if (attempts === 1) throw new Error('temporary network failure')
    return {
      result: {
        ok: true,
        data: { items: [], page: 1, pageSize: 20, hasMore: false },
        requestId: options.data.requestId
      }
    }
  }
  try {
    const api = require(apiPath)
    const result = await api.matches.list({ city: '杭州', page: 1, pageSize: 20 })
    assert.deepStrictEqual(result.items, [])
    assert.strictEqual(attempts, 2)
    const calls = cloudCalls.filter((item) => item.method === 'callFunction')
    assert.strictEqual(calls.length, 2)
    assert.strictEqual(calls[0].options.name, 'api')
    assert.strictEqual(calls[0].options.data.apiVersion, 2)
    assert.strictEqual(calls[0].options.data.action, 'matches.list')
    assert.deepStrictEqual(calls[0].options.data.payload, { city: '杭州', page: 1, pageSize: 20 })
    assert.strictEqual(calls[0].options.data.requestId, calls[1].options.data.requestId)
    assert(/^req_[a-z0-9]+_[a-z0-9]+$/.test(calls[0].options.data.requestId))
    assert(cloudCalls.some((item) => item.method === 'init' && item.options.env === 'laiyipai-test-env'))
  } finally {
    config.cloudEnvId = originalEnvId
    cloudHandler = async () => ({ result: { ok: true, data: {}, requestId: 'req_test' } })
    clearModule(cloudPath)
    clearModule(apiPath)
  }
})
test('新版客户端连到旧云函数时提示服务更新，不再透出旧版日期校验', async () => {
  resetRuntime()
  const config = require(cloudConfigPath)
  const originalEnvId = config.cloudEnvId
  config.cloudEnvId = 'laiyipai-test-env'
  cloudHandler = async (options) => ({
    result: {
      ok: false,
      error: {
        code: 'API_VERSION_UNSUPPORTED',
        message: '客户端版本过旧，请更新小程序',
        details: { supportedVersion: 1 }
      },
      requestId: options.data.requestId
    }
  })
  try {
    clearModule(cloudPath)
    clearModule(apiPath)
    const api = require(apiPath)
    await assert.rejects(
      () => api.friendUpdates.publish({ kind: 'tip', content: '练球心得' }),
      error => error.code === 'API_VERSION_UNSUPPORTED' &&
        error.message === '服务正在更新，请稍后重新打开小程序' &&
        !error.message.includes('日期')
    )
  } finally {
    config.cloudEnvId = originalEnvId
    cloudHandler = async () => ({ result: { ok: true, data: {}, requestId: 'req_test' } })
    clearModule(cloudPath)
    clearModule(apiPath)
  }
})

test('云 API 对服务繁忙做一次安全重试且保持 requestId', async () => {
  resetRuntime()
  const config = require(cloudConfigPath)
  const originalEnvId = config.cloudEnvId
  config.cloudEnvId = 'laiyipai-test-env'
  clearModule(cloudPath)
  clearModule(apiPath)
  let attempts = 0
  cloudHandler = async (options) => {
    attempts += 1
    if (attempts === 1) {
      return {
        result: {
          ok: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: '服务繁忙，请稍后重试' },
          requestId: options.data.requestId
        }
      }
    }
    return {
      result: {
        ok: true,
        data: { items: [] },
        requestId: options.data.requestId
      }
    }
  }
  try {
    const api = require(apiPath)
    const result = await api.venues.list()
    assert.deepStrictEqual(result, { items: [] })
    assert.strictEqual(attempts, 2)
    const calls = cloudCalls.filter((item) => item.method === 'callFunction')
    assert.strictEqual(calls.length, 2)
    assert.strictEqual(calls[0].options.data.action, 'venues.list')
    assert.strictEqual(calls[0].options.data.requestId, calls[1].options.data.requestId)
  } finally {
    config.cloudEnvId = originalEnvId
    cloudHandler = async () => ({ result: { ok: true, data: {}, requestId: 'req_test' } })
    clearModule(cloudPath)
    clearModule(apiPath)
  }
})

test('头像上传区分超限、云存储权限与网络错误', async () => {
  resetRuntime()
  const config = require(cloudConfigPath)
  const originalEnvId = config.cloudEnvId
  config.cloudEnvId = 'laiyipai-test-env'
  cloudHandler = async (options) => ({
    result: {
      ok: true,
      data: options.data.action === 'files.prepareUpload'
        ? { cloudPath: 'user-avatars/2099-01-01/ticket.jpg', uploadToken: 'ticket_avatar' }
        : {},
      requestId: options.data.requestId
    }
  })
  try {
    clearModule(cloudPath)
    const cloud = require(cloudPath)
    const cases = [
      ['uploadFile:fail 413 entity too large', 'UPLOAD_TOO_LARGE', '头像超过 5MB'],
      ['uploadFile:fail permission denied by storage rule', 'UPLOAD_STORAGE_UNAVAILABLE', '云存储权限或环境配置异常'],
      ['uploadFile:fail network timeout', 'NETWORK_ERROR', '网络连接失败']
    ]
    for (const [errMsg, code, message] of cases) {
      cloudUploadHandler = () => Promise.reject({ errMsg })
      let thrown
      try {
        await cloud.uploadAvatar('wxfile://tmp/avatar.jpg')
      } catch (error) {
        thrown = error
      }
      assert(thrown)
      assert.strictEqual(thrown.code, code)
      assert(thrown.message.includes(message))
    }
  } finally {
    config.cloudEnvId = originalEnvId
    cloudHandler = async () => ({ result: { ok: true, data: {}, requestId: 'req_test' } })
    cloudUploadHandler = () => {
      const task = Promise.resolve({ fileID: 'cloud://test/avatar.jpg' })
      task.onProgressUpdate = () => {}
      return task
    }
    clearModule(cloudPath)
    clearModule(apiPath)
  }
})

test('头像上传按真实图片类型处理微信临时路径并在上传前检查大小', async () => {
  resetRuntime()
  const config = require(cloudConfigPath)
  const originalEnvId = config.cloudEnvId
  const originalGetImageInfo = wx.getImageInfo
  const originalGetFileInfo = wx.getFileInfo
  const preparedExtensions = []
  const uploads = []
  let imageInfo = { type: 'PNG' }
  let imageInfoError = null
  let fileSize = 1024
  config.cloudEnvId = 'laiyipai-test-env'
  wx.getImageInfo = (options) => {
    if (imageInfoError) options.fail(imageInfoError)
    else options.success(clone(imageInfo))
  }
  wx.getFileInfo = (options) => options.success({ size: fileSize })
  cloudHandler = async (options) => {
    if (options.data.action === 'files.prepareUpload') {
      const extension = options.data.payload.extension
      preparedExtensions.push(extension)
      return {
        result: {
          ok: true,
          data: { cloudPath: `user-avatars/2099-01-01/ticket.${extension}`, uploadToken: `ticket_${preparedExtensions.length}` },
          requestId: options.data.requestId
        }
      }
    }
    return { result: { ok: true, data: { avatar: { status: 'reviewing' } }, requestId: options.data.requestId } }
  }
  cloudUploadHandler = (options) => {
    uploads.push(clone(options))
    const task = Promise.resolve({ fileID: `cloud://test/${options.cloudPath}` })
    task.onProgressUpdate = () => {}
    return task
  }
  try {
    clearModule(cloudPath)
    const cloud = require(cloudPath)

    await cloud.uploadAvatar('wxfile://tmp/cropped-avatar', { requestId: 'req_png_no_suffix' })
    assert.strictEqual(preparedExtensions[0], 'png', '无后缀 chooseAvatar 路径必须使用实际图片类型')
    assert.strictEqual(uploads[0].filePath, 'wxfile://tmp/cropped-avatar')
    assert(uploads[0].cloudPath.endsWith('.png'))

    imageInfoError = { errMsg: 'getImageInfo:fail temporary inspection unavailable' }
    await cloud.uploadAvatar('http://tmp/avatar.JPG?from=chooseAvatar', { requestId: 'req_suffix_fallback' })
    assert.strictEqual(preparedExtensions[1], 'jpg', '图片信息读取失败时应兼容带查询参数的合法后缀')

    imageInfoError = null
    imageInfo = { type: 'webp' }
    await assert.rejects(
      cloud.uploadAvatar('wxfile://tmp/avatar.jpg', { requestId: 'req_webp' }),
      (error) => error.code === 'INVALID_ARGUMENT' && /JPG 或 PNG/.test(error.message)
    )
    assert.strictEqual(preparedExtensions.length, 2, '不支持的真实图片类型不得申请上传凭证')
    assert.strictEqual(uploads.length, 2, '不支持的真实图片类型不得上传到云存储')

    imageInfo = { type: 'jpeg' }
    fileSize = 5 * 1024 * 1024 + 1
    await assert.rejects(
      cloud.uploadAvatar('wxfile://tmp/oversized-avatar', { requestId: 'req_too_large' }),
      (error) => error.code === 'UPLOAD_TOO_LARGE' && /超过 5MB/.test(error.message)
    )
    assert.strictEqual(preparedExtensions.length, 2, '超限头像应在云调用前被拒绝')

    imageInfoError = { errMsg: 'getImageInfo:fail file not found' }
    await assert.rejects(
      cloud.uploadAvatar('wxfile://tmp/missing-avatar', { requestId: 'req_invalid_temp_path' }),
      (error) => error.code === 'INVALID_ARGUMENT' && /重新选择/.test(error.message)
    )
  } finally {
    config.cloudEnvId = originalEnvId
    if (originalGetImageInfo) wx.getImageInfo = originalGetImageInfo
    else delete wx.getImageInfo
    wx.getFileInfo = originalGetFileInfo
    cloudHandler = async () => ({ result: { ok: true, data: {}, requestId: 'req_test' } })
    cloudUploadHandler = () => {
      const task = Promise.resolve({ fileID: 'cloud://test/avatar.jpg' })
      task.onProgressUpdate = () => {}
      return task
    }
    clearModule(cloudPath)
    clearModule(apiPath)
  }
})

test('app.ensureSession 合并并发初始化并缓存真实会话', async () => {
  resetRuntime()
  let initCount = 0
  let bootstrapCount = 0
  let authorizeCount = 0
  let resolveBootstrap
  mockModule(apiPath, {
    init() { initCount += 1 },
    bootstrap() {
      bootstrapCount += 1
      return new Promise((resolve) => { resolveBootstrap = resolve })
    }
  })
  installPrivacy(async () => { authorizeCount += 1 })
  capturedApp = null
  clearModule(appPath)
  require(appPath)
  const app = instantiate(capturedApp)
  const first = app.loginWithWechat(true)
  const second = app.ensureSession()
  await Promise.resolve()
  assert.strictEqual(bootstrapCount, 1)
  resolveBootstrap({ profile: { playerId: 'player-me' }, policies: { coachCancellationHours: 12 } })
  const [firstSession, secondSession] = await Promise.all([first, second])
  assert.deepStrictEqual(firstSession, secondSession)
  assert.strictEqual(initCount, 1)
  assert.strictEqual(authorizeCount, 1)
  assert.strictEqual((await app.ensureSession()).profile.playerId, 'player-me')
  assert.strictEqual(bootstrapCount, 1)
})

test('发布包页面完整，JS/JSON/WXML/WXSS 可解析且不引用旧数据仓库', () => {
  resetRuntime()
  installApi()
  const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8'))
  const projectConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'project.config.json'), 'utf8'))
  assert.strictEqual(config.tabBar.list.length, 4)
  assert.strictEqual(config.__usePrivacyCheck__, true)
  assert.strictEqual(config.style, 'v2')
  assert(!config.plugins, '发布包不得声明未使用的小程序插件')
  assert(projectConfig.packOptions.ignore.some((item) => item.type === 'folder' && item.value === '.tmp-wx-sdk-compat'), '临时依赖验证目录必须从上传包排除')
  assert.strictEqual(config.tabBar.custom, true, '底部导航必须使用不依赖本地图片代理的自定义 TabBar')
  assert(projectConfig.packOptions.include.some((item) => item.type === 'folder' && item.value === 'custom-tab-bar'), '自定义 TabBar 必须显式加入上传包，避免被无依赖文件过滤误删')
  config.tabBar.list.forEach((item) => {
    assert(!item.iconPath && !item.selectedIconPath, `${item.pagePath} 不应再请求本地 TabBar 图片`)
  })
  ;['index.js', 'index.json', 'index.wxml', 'index.wxss'].forEach((filename) => {
    assert(fs.existsSync(path.join(projectRoot, 'custom-tab-bar', filename)), `custom-tab-bar/${filename} missing`)
  })
  config.pages.forEach((pagePath) => {
    ['.js', '.json', '.wxml', '.wxss'].forEach((extension) => {
      assert(fs.existsSync(path.join(projectRoot, `${pagePath}${extension}`)), `${pagePath}${extension} missing`)
    })
  })
  walk(projectRoot, '.js').forEach((filename) => {
    const source = fs.readFileSync(filename, 'utf8')
    assert.doesNotThrow(() => new Function(source), `${filename} failed syntax check`)
  })
  walk(projectRoot, '.json').forEach((filename) => {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(filename, 'utf8')), `${filename} failed JSON parse`)
  })
  const runtimeFiles = [appPath].concat(walk(path.join(projectRoot, 'pages'), '.js'))
  runtimeFiles.forEach((filename) => {
    const source = fs.readFileSync(filename, 'utf8')
    assert(!/utils[\\/](?:data|store)(?:\.js)?['"]/.test(source), `${filename} still imports legacy demo storage`)
    assert(!source.includes('requirePlugin'), `${filename} must not load a runtime plugin`)
  })
})

test('所有页面模板标签、事件绑定及 WXSS 结构有效', () => {
  resetRuntime()
  installApi()
  walk(path.join(projectRoot, 'pages'), '.wxml').forEach((filename) => {
    const source = fs.readFileSync(filename, 'utf8')
    validateWxmlTags(source, filename)
    assert(!/{{[^}]*\.[a-zA-Z]+\(/.test(source), `${filename}: method call found in WXML expression`)
    const page = loadPage(path.relative(projectRoot, filename.replace(/\.wxml$/, '.js')))
    const handlers = [...source.matchAll(/(?:bind|catch)[a-z]+="([^"]+)"/g)].map((match) => match[1])
    handlers.forEach((handler) => assert.strictEqual(typeof page[handler], 'function', `${filename}: missing ${handler}`))
  })
  const customTabBarTemplate = path.join(projectRoot, 'custom-tab-bar', 'index.wxml')
  const customTabBarSource = fs.readFileSync(customTabBarTemplate, 'utf8')
  validateWxmlTags(customTabBarSource, customTabBarTemplate)
  assert(!/{{[^}]*\.[a-zA-Z]+\(/.test(customTabBarSource), `${customTabBarTemplate}: method call found in WXML expression`)
  walk(path.join(projectRoot, 'pages'), '.wxss').forEach((filename) => {
    const source = fs.readFileSync(filename, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.strictEqual((source.match(/{/g) || []).length, (source.match(/}/g) || []).length, `${filename}: unbalanced CSS braces`)
  })
})

test('朋友圈分享只开放给首页和三类公开资源详情页', async () => {
  resetRuntime()
  installApi()
  const publicPages = [
    'pages/home/home.js',
    'pages/match-detail/match-detail.js',
    'pages/venue-detail/venue-detail.js',
    'pages/coach-detail/coach-detail.js'
  ]
  publicPages.forEach((filename) => {
    const page = loadPage(filename)
    assert.strictEqual(typeof page.onShareTimeline, 'function', `${filename} must declare onShareTimeline`)
  })

  const privatePages = [
    'pages/chat/chat.js',
    'pages/orders/orders.js',
    'pages/profile/profile.js',
    'pages/settings/settings.js',
    'pages/publish/publish.js',
    'pages/player-detail/player-detail.js'
  ]
  privatePages.forEach((filename) => {
    const page = loadPage(filename)
    assert.strictEqual(page.onShareTimeline, undefined, `${filename} must not be shareable to Timeline`)
    const source = fs.readFileSync(path.join(projectRoot, filename), 'utf8')
    assert(!source.includes('shareTimeline'), `${filename} must not enable Timeline through wx.showShareMenu`)
  })

  const home = loadPage('pages/home/home.js')
  home.onLoad()
  await home.loadContent()
  const homeShare = home.onShareTimeline()
  assert(homeShare && typeof homeShare.title === 'string' && homeShare.title.includes('杭州'))
  assert.strictEqual(Object.prototype.hasOwnProperty.call(homeShare, 'path'), false)
  assert.strictEqual(homeShare.imageUrl, undefined, 'empty home feed must not fall back to a fabricated share image')
})

test('朋友圈中的球局 ID 可重新加载同一个真实球局', async () => {
  resetRuntime()
  const matchId = 'match_prod_20260904_01'
  const avatarFileId = 'cloud://laiyipai-prod/avatars/player-host.jpg'
  const avatarUrl = 'https://cdn.laiyipai.cn/avatars/player-host.jpg'
  const requestedIds = []
  const rawMatch = matchFixture({
    id: matchId,
    title: '周六黄龙练球',
    host: Object.assign({}, matchFixture().host, { avatarFileId })
  })
  installApi({
    matches: {
      get: async ({ matchId: requestedId }) => {
        requestedIds.push(requestedId)
        return { match: rawMatch, membership: null, confirmedCount: 1 }
      }
    },
    venues: { get: async () => venueFixture() },
    favorites: { list: async () => ({ items: [] }) },
    files: { resolve: async () => ({ urls: { [avatarFileId]: avatarUrl }, unresolved: [] }) }
  })
  const page = loadPage('pages/match-detail/match-detail.js')
  page.onLoad({ id: matchId })
  await page.loadMatch()
  const query = assertTimelinePayload(page.onShareTimeline(), {
    page: 'match-detail',
    id: matchId,
    titleText: rawMatch.title,
    liveImages: [page.data.match.host.avatarUrl]
  })
  const landing = loadPage('pages/match-detail/match-detail.js')
  landing.onLoad(query)
  await landing.loadMatch()
  assert.strictEqual(landing.data.id, matchId)
  assert.strictEqual(landing.data.match.id, matchId)
  assert.deepStrictEqual(requestedIds, [matchId, matchId])
})

test('朋友圈中的球馆 ID 可重新加载同一个已核验球馆', async () => {
  resetRuntime()
  const venueId = 'venue_prod_huanglong'
  const coverFileId = 'cloud://laiyipai-prod/venues/huanglong-cover.jpg'
  const coverUrl = 'https://cdn.laiyipai.cn/venues/huanglong-cover.jpg'
  const requestedIds = []
  const rawVenue = Object.assign(venueFixture(venueId), {
    name: '黄龙体育中心乒乓球馆',
    coverFileIds: [coverFileId],
    verificationDate: '2026-09-01T08:00:00+08:00'
  })
  installApi({
    venues: {
      get: async ({ venueId: requestedId }) => {
        requestedIds.push(requestedId)
        return rawVenue
      }
    },
    files: { resolve: async () => ({ urls: { [coverFileId]: coverUrl }, unresolved: [] }) }
  })
  const page = loadPage('pages/venue-detail/venue-detail.js')
  page.onLoad({ id: venueId })
  await page.loadVenue()
  const query = assertTimelinePayload(page.onShareTimeline(), {
    page: 'venue-detail',
    id: venueId,
    titleText: rawVenue.name,
    liveImages: page.data.venue.imageUrls
  })
  const landing = loadPage('pages/venue-detail/venue-detail.js')
  landing.onLoad(query)
  await landing.loadVenue()
  assert.strictEqual(landing.data.id, venueId)
  assert.strictEqual(landing.data.venue.id, venueId)
  assert.deepStrictEqual(requestedIds, [venueId, venueId])
})

test('球馆详情标记状态查询失败时显示待确认并允许重试', async () => {
  resetRuntime()
  activeApp = {
    globalData: { session: { profile: { playerId: 'player-returning' } } },
    ensureSession: async () => ({ profile: { playerId: 'player-returning' } })
  }
  const venue = venueFixture('venue-status-retry')
  let statusCalls = 0
  let setCalls = 0
  installApi({
    venues: { get: async () => venue },
    favorites: {
      status: async () => {
        statusCalls += 1
        if (statusCalls === 1) throw new Error('status unavailable')
        return { markedIds: [venue.id] }
      },
      set: async () => { setCalls += 1 }
    }
  })
  const page = loadPage('pages/venue-detail/venue-detail.js')
  page.onLoad({ id: venue.id })
  await page.loadVenue()
  assert.strictEqual(page.data.state, 'ready')
  assert.strictEqual(page.data.favoriteStatus, 'unknown')
  assert.strictEqual(page.data.venue.favorited, false)

  await page.toggleFavorite()
  assert.strictEqual(statusCalls, 2)
  assert.strictEqual(setCalls, 0, '未知状态下首次点击只能重试查询，不能猜测写入')
  assert.strictEqual(page.data.favoriteStatus, 'marked')
  assert.strictEqual(page.data.venue.favorited, true)
  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'venue-detail', 'venue-detail.wxml'), 'utf8')
  assert(template.includes('状态待确认'))
})

test('朋友圈中的教练 ID 可重新加载同一个认证教练', async () => {
  resetRuntime()
  const coachId = 'coach_prod_chen'
  const avatarFileId = 'cloud://laiyipai-prod/coaches/chen.jpg'
  const avatarUrl = 'https://cdn.laiyipai.cn/coaches/chen.jpg'
  const requestedIds = []
  const rawCoach = {
    id: coachId,
    name: '陈教练',
    verified: true,
    venueIds: ['venue_huanglong'],
    avatarFileId,
    specialty: ['基本功', '接发球'],
    experienceYears: 8,
    nextSlots: []
  }
  installApi({
    coaches: {
      get: async ({ coachId: requestedId }) => {
        requestedIds.push(requestedId)
        return { coach: rawCoach, slots: [] }
      }
    },
    venues: { get: async ({ venueId }) => venueFixture(venueId) },
    files: { resolve: async () => ({ urls: { [avatarFileId]: avatarUrl }, unresolved: [] }) }
  })
  const page = loadPage('pages/coach-detail/coach-detail.js')
  page.onLoad({ id: coachId })
  await page.loadCoach()
  const query = assertTimelinePayload(page.onShareTimeline(), {
    page: 'coach-detail',
    id: coachId,
    titleText: rawCoach.name,
    liveImages: [page.data.coach.avatarUrl]
  })
  const landing = loadPage('pages/coach-detail/coach-detail.js')
  landing.onLoad(query)
  await landing.loadCoach()
  assert.strictEqual(landing.data.id, coachId)
  assert.strictEqual(landing.data.coach.id, coachId)
  assert.deepStrictEqual(requestedIds, [coachId, coachId])
})

test('首页忽略旧教练入口记忆，默认找球局并保留筛选条件', async () => {
  resetRuntime()
  const requestedMatches = []
  let coachCalls = 0
  wx.setStorageSync('laiyipai_ui_home_filters_v1', {
    mode: 'coaches', district: '萧山区', date: dateString(1), ballAge: '新手友好'
  })
  installApi({
    venues: { list: async () => ({ items: [] }) },
    matches: { list: async payload => { requestedMatches.push(payload); return { items: [] } } },
    coaches: { list: async () => { coachCalls += 1; return { items: [] } } }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  await home.onShow()
  assert.strictEqual(home.data.mode, 'matches')
  assert.strictEqual(coachCalls, 0)
  assert.strictEqual(requestedMatches.length, 1)
  assert.strictEqual(requestedMatches[0].district, '萧山区')
  assert.strictEqual(requestedMatches[0].date, dateString(1))
  assert.strictEqual(requestedMatches[0].expectedBallAge, '新手友好')
  assert.strictEqual(wx.getStorageSync('laiyipai_ui_home_filters_v1').mode, undefined)
})

test('手动约教练后返回保留选择，重新创建首页仍默认找球局', async () => {
  resetRuntime()
  const home = loadPage('pages/home/home.js')
  const requestedModes = []
  home.loadContent = async () => { requestedModes.push(home.data.mode); return true }
  home.onLoad()
  assert.strictEqual(home.data.mode, 'matches')
  home.switchMode({ currentTarget: { dataset: { mode: 'coaches' } } })
  assert.strictEqual(home.data.mode, 'coaches')
  await home.onShow()
  assert.strictEqual(home.data.mode, 'coaches')
  assert.deepStrictEqual(requestedModes, ['coaches', 'coaches'])
  assert.strictEqual(wx.getStorageSync('laiyipai_ui_home_filters_v1').mode, undefined)
  const reopened = loadPage('pages/home/home.js')
  reopened.onLoad()
  assert.strictEqual(reopened.data.mode, 'matches')
})

test('首页持久化的过期日期会回退到今天并使用当天查询', async () => {
  resetRuntime()
  const today = dateString(0)
  const requestedDates = []
  wx.setStorageSync('laiyipai_ui_home_filters_v1', {
    mode: 'matches',
    district: '全杭州',
    date: dateString(-2),
    ballAge: '不限球龄'
  })
  installApi({
    venues: { list: async () => ({ items: [] }) },
    matches: {
      list: async (payload) => {
        requestedDates.push(payload.date)
        return { items: [] }
      }
    }
  })

  const home = loadPage('pages/home/home.js')
  home.onLoad()
  assert.strictEqual(home.data.selectedDate, today)
  assert(home.data.dateOptions.some((item) => item.value === home.data.selectedDate), '回退日期必须在可见日期栏中')
  await home.loadContent({ showSkeleton: true })
  assert.deepStrictEqual(requestedDates, [today])
})

test('三个公开详情页缺少资源 ID 时立即显示可返回的不存在状态', async () => {
  const pages = [
    { filename: 'pages/match-detail/match-detail.js', template: 'pages/match-detail/match-detail.wxml', loader: 'loadMatch' },
    { filename: 'pages/venue-detail/venue-detail.js', template: 'pages/venue-detail/venue-detail.wxml', loader: 'loadVenue' },
    { filename: 'pages/coach-detail/coach-detail.js', template: 'pages/coach-detail/coach-detail.wxml', loader: 'loadCoach' }
  ]

  for (const item of pages) {
    resetRuntime()
    let apiCalls = 0
    const unexpected = async () => {
      apiCalls += 1
      throw new Error('缺少 ID 时不应访问云端')
    }
    installApi({
      venues: { get: unexpected },
      matches: { get: unexpected },
      coaches: { get: unexpected }
    })
    const page = loadPage(item.filename)
    page.onLoad({})
    await page[item.loader]()

    assert.strictEqual(page.data.state, 'error', `${item.filename}: 缺少 ID 时不能停留在 loading`)
    assert.strictEqual(page.data.notFound, true, `${item.filename}: 缺少 ID 应按资源不存在处理`)
    assert(String(page.data.errorMessage || '').trim(), `${item.filename}: 缺少 ID 时应解释错误`)
    assert.strictEqual(apiCalls, 0, `${item.filename}: 缺少 ID 时不应发起无效云请求`)
    assert.strictEqual(typeof page.goHome, 'function', `${item.filename}: 入口页错误必须可以返回首页`)
    const template = fs.readFileSync(path.join(projectRoot, item.template), 'utf8')
    assert(template.includes('bindtap="goHome"'), `${item.template}: 不存在状态必须展示返回首页操作`)
  }
})

test('教练详情刷新时重绑仍有效的时段并清理已失效的预约选择', async () => {
  resetRuntime()
  const slotDate = dateString(3)
  let slots = [{
    id: 'slot-refresh-a',
    venueId: 'venue_huanglong',
    startAt: `${slotDate}T10:00:00+08:00`,
    endAt: `${slotDate}T11:00:00+08:00`,
    price: 160,
    capacity: 1,
    remaining: 1,
    version: 1
  }]
  installApi({
    coaches: {
      get: async () => ({
        coach: {
          id: 'coach-refresh',
          name: '刷新测试教练',
          verified: true,
          venueIds: ['venue_huanglong'],
          specialty: ['基本功']
        },
        slots: clone(slots)
      })
    }
  })

  const page = loadPage('pages/coach-detail/coach-detail.js')
  page.onLoad({ id: 'coach-refresh' })
  await page.loadCoach()
  page.selectSlot({ currentTarget: { dataset: { id: 'slot-refresh-a' } } })
  await page.openBooking()
  const staleSelection = page.data.selectedSlot
  assert.strictEqual(staleSelection.price, 160)
  assert.strictEqual(page.data.bookingSheet, true)

  slots = [Object.assign({}, slots[0], { price: 220, version: 2 })]
  await page.loadCoach()
  assert.strictEqual(page.data.selectedSlotId, 'slot-refresh-a')
  assert.strictEqual(page.data.selectedSlot.price, 220, '仍可约的时段必须替换为服务端最新对象')
  assert.strictEqual(page.data.selectedSlot.version, 2)
  assert.notStrictEqual(page.data.selectedSlot, staleSelection)
  assert.strictEqual(page.data.bookingSheet, true, '仍有效时段可保留已打开的确认弹层')

  slots = [{
    id: 'slot-refresh-b',
    venueId: 'venue_huanglong',
    startAt: `${slotDate}T14:00:00+08:00`,
    endAt: `${slotDate}T15:00:00+08:00`,
    price: 180,
    capacity: 1,
    remaining: 1,
    version: 1
  }]
  await page.loadCoach()
  assert.strictEqual(page.data.selectedSlotId, '')
  assert.strictEqual(page.data.selectedSlot, null)
  assert.strictEqual(page.data.bookingSheet, false)
})

test('教练时段球馆加载失败时名称与跳转编号不会错配', async () => {
  resetRuntime()
  const slotDate = dateString(3)
  installApi({
    coaches: {
      get: async () => ({
        coach: {
          id: 'coach-venue-fallback',
          name: '多馆教练',
          verified: true,
          venueIds: ['venue-a', 'venue-b'],
          specialty: ['基本功']
        },
        slots: [{
          id: 'slot-venue-b',
          venueId: 'venue-b',
          startAt: `${slotDate}T10:00:00+08:00`,
          endAt: `${slotDate}T11:00:00+08:00`,
          price: 180,
          remaining: 1,
          version: 1
        }]
      })
    },
    venues: {
      get: async ({ venueId }) => {
        if (venueId === 'venue-b') throw new Error('球馆 B 暂未载入')
        return venueFixture(venueId, { name: '球馆 A' })
      }
    }
  })
  const page = loadPage('pages/coach-detail/coach-detail.js')
  page.onLoad({ id: 'coach-venue-fallback' })
  await page.loadCoach()
  assert.strictEqual(page.data.coach.venueId, 'venue-b')
  assert.strictEqual(page.data.coach.venueName, '球馆资料待加载')
  assert.strictEqual(page.data.slots[0].venueName, '球馆资料待加载')
})

test('首页快速切换筛选时旧请求结果不能覆盖新请求', async () => {
  resetRuntime()
  const pendingMatches = []
  const requestedDates = []
  installApi({
    venues: { list: async () => ({ items: [] }) },
    matches: {
      list: (payload) => {
        const request = deferred()
        requestedDates.push(payload.date)
        pendingMatches.push(request)
        return request.promise
      }
    },
    coaches: {
      list: async () => {
        throw new Error('找球局模式不应请求教练')
      }
    }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  const oldDate = dateString(2)
  const newDate = dateString(3)
  home.setData({ selectedDate: oldDate })
  const oldRequest = home.loadContent({ showSkeleton: true })
  await nextEventLoopTurn()
  assert.strictEqual(pendingMatches.length, 1)

  home.setData({ selectedDate: newDate })
  const newRequest = home.loadContent({ showSkeleton: true })
  await nextEventLoopTurn()
  assert.strictEqual(pendingMatches.length, 2)
  assert.deepStrictEqual(requestedDates, [oldDate, newDate])

  pendingMatches[1].resolve({ items: [matchFixture({ id: 'match-new-filter', title: '新筛选结果', date: newDate })] })
  await newRequest
  assert.strictEqual(home.data.state, 'ready')
  assert.strictEqual(home.data.matches.length, 1)
  assert.strictEqual(home.data.matches[0].id, 'match-new-filter')

  pendingMatches[0].resolve({ items: [matchFixture({ id: 'match-stale-filter', title: '旧筛选结果', date: oldDate })] })
  await oldRequest
  assert.strictEqual(home.data.matches.length, 1)
  assert.strictEqual(home.data.matches[0].id, 'match-new-filter')
  assert.strictEqual(home.data.matches[0].title, '新筛选结果')
})

test('找球局模式不调用教练接口，次要模块故障不影响主列表', async () => {
  resetRuntime()
  let matchCalls = 0
  let coachCalls = 0
  installApi({
    venues: { list: async () => ({ items: [] }) },
    matches: {
      list: async () => {
        matchCalls += 1
        return { items: [matchFixture({ id: 'match-primary-flow', title: '主列表球局' })] }
      }
    },
    coaches: {
      list: async () => {
        coachCalls += 1
        throw new Error('教练服务暂时不可用')
      }
    }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  home.setData({ mode: 'matches' })
  await home.loadContent({ showSkeleton: true })
  assert.strictEqual(matchCalls, 1)
  assert.strictEqual(coachCalls, 0)
  assert.strictEqual(home.data.state, 'ready')
  assert.strictEqual(home.data.errorMessage, '')
  assert.strictEqual(home.data.matches.length, 1)
  assert.strictEqual(home.data.matches[0].id, 'match-primary-flow')
})

test('首页跨模式并发切换时旧教练响应不能污染新的球局视图', async () => {
  resetRuntime()
  const coachRequest = deferred()
  let coachCalls = 0
  let matchCalls = 0
  installApi({
    venues: { list: async () => ({ items: [] }) },
    coaches: {
      list: () => {
        coachCalls += 1
        return coachRequest.promise
      }
    },
    matches: {
      list: async () => {
        matchCalls += 1
        return { items: [matchFixture({ id: 'match-after-mode-switch', title: '切换后的球局' })] }
      }
    }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  home.setData({ mode: 'coaches' })
  const oldCoachLoad = home.loadContent({ showSkeleton: true })
  await nextEventLoopTurn()
  assert.strictEqual(coachCalls, 1)

  home.setData({ mode: 'matches' })
  const latestMatchLoad = home.loadContent({ showSkeleton: true })
  await latestMatchLoad
  assert.strictEqual(matchCalls, 1)
  assert.strictEqual(home.data.mode, 'matches')
  assert.strictEqual(home.data.matches[0].id, 'match-after-mode-switch')

  coachRequest.resolve({
    items: [{ id: 'coach-stale', name: '旧请求教练', verified: true, venueIds: [], nextSlots: [] }]
  })
  await oldCoachLoad
  assert.strictEqual(home.data.mode, 'matches')
  assert.strictEqual(home.data.matches[0].id, 'match-after-mode-switch')
  assert.deepStrictEqual(home.data.coaches, [])
})

test('首页后台刷新失败时保留已展示球局并退出刷新态', async () => {
  resetRuntime()
  let shouldFail = false
  installApi({
    venues: { list: async () => ({ items: [] }) },
    matches: {
      list: async () => {
        if (shouldFail) throw new Error('球局服务暂时不可用')
        return { items: [matchFixture({ id: 'match-cached-view', title: '已展示球局' })] }
      }
    }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  await home.loadContent({ showSkeleton: true })
  assert.strictEqual(home.data.state, 'ready')
  assert.strictEqual(home.data.matches[0].id, 'match-cached-view')

  shouldFail = true
  await home.loadContent()
  assert.strictEqual(home.data.state, 'ready')
  assert.strictEqual(home.data.refreshing, false)
  assert.strictEqual(home.data.errorMessage, '')
  assert.strictEqual(home.data.matches[0].id, 'match-cached-view')
  assert(notices.some((item) => item.type === 'toast' && item.options.title === '球局服务暂时不可用'))
})

test('首页媒体 URL 解析失败时仍展示可预约的文字信息', async () => {
  resetRuntime()
  const venue = Object.assign(venueFixture(), { coverFileIds: ['cloud://laiyipai-prod/venues/cover.jpg'] })
  installApi({
    venues: { list: async () => ({ items: [venue] }) },
    matches: { list: async () => ({ items: [matchFixture({ id: 'match-without-media' })] }) },
    files: { resolve: async () => { throw new Error('临时 URL 服务失败') } }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  await home.loadContent({ showSkeleton: true })
  assert.strictEqual(home.data.state, 'ready')
  assert.strictEqual(home.data.matches[0].id, 'match-without-media')
  assert.strictEqual(home.data.venues[0].id, venue.id)
  assert.strictEqual(home.data.venues[0].coverUrl, '')
  assert.strictEqual(home.data.errorMessage, '')
})

test('名称型球馆在首页保留活动标签且不伪造地址与导航能力', async () => {
  resetRuntime()
  const venue = Object.assign(nameOnlyVenueFixture(), {
    district: '不应展示的地区',
    address: '不应展示的地址',
    phone: '10086',
    location: { latitude: 30.1, longitude: 120.2 },
    activityTags: ['教学', '比赛', '训练', '切磋', '教学', '']
  })
  installApi({
    venues: { list: async () => ({ items: [venue] }) },
    matches: { list: async () => ({ items: [] }) }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  await home.loadContent({ showSkeleton: true })

  const presented = home.data.venues[0]
  assert.strictEqual(presented.name, '萧潮乒乓球馆')
  assert.deepStrictEqual(presented.activityTags, ['教学', '比赛', '训练', '切磋'])
  assert.strictEqual(presented.district, '')
  assert.strictEqual(presented.locationText, '')
  assert.strictEqual(presented.address, '')
  assert.strictEqual(presented.phone, '')
  assert.strictEqual(presented.location, null)
  assert.strictEqual(presented.hasLocation, false)

  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'home', 'home.wxml'), 'utf8')
  assert(template.includes('item.activityTags'))
  assert(template.includes('item.locationText'))
  assert(!template.includes('{{item.district}}</view>'), '名称型球馆不能产生空地区行')
})

test('首页用球馆资料补足球局位置，并按坐标导航或按地址复制', async () => {
  resetRuntime()
  const location = { latitude: 30.266763, longitude: 120.133775 }
  const mappedVenue = Object.assign(venueFixture('venue-home-map'), {
    name: '黄龙体育中心乒乓球馆',
    location
  })
  const addressOnlyVenue = {
    id: 'venue-address-only',
    name: '地址待补坐标球馆',
    address: '杭州市西湖区测试路 8 号'
  }
  installApi({
    venues: { list: async () => ({ items: [mappedVenue] }) },
    matches: {
      list: async () => ({ items: [
        matchFixture({
          id: 'match-with-map',
          venueId: mappedVenue.id,
          venue: { id: mappedVenue.id, name: mappedVenue.name, address: mappedVenue.address }
        }),
        matchFixture({
          id: 'match-address-only',
          venueId: addressOnlyVenue.id,
          venue: addressOnlyVenue
        })
      ] })
    }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  await home.loadContent({ showSkeleton: true })

  const mappedMatch = home.data.matches.find((item) => item.id === 'match-with-map')
  assert.strictEqual(mappedMatch.hasLocation, true)
  assert.deepStrictEqual(mappedMatch.location, location)
  assert.strictEqual(mappedMatch.address, mappedVenue.address)
  assert(mappedMatch.venueLocationText.includes(mappedVenue.address))

  assert.strictEqual(home.openMatchMap({ currentTarget: { dataset: { id: mappedMatch.id } } }), true)
  assert.strictEqual(openedLocations.length, 1)
  assert.strictEqual(openedLocations[0].latitude, location.latitude)
  assert.strictEqual(openedLocations[0].longitude, location.longitude)
  assert.strictEqual(openedLocations[0].name, mappedVenue.name)
  assert.strictEqual(openedLocations[0].address, mappedVenue.address)

  assert.strictEqual(home.openMatchMap({ currentTarget: { dataset: { id: 'match-address-only' } } }), true)
  assert.strictEqual(openedLocations.length, 1, '仅地址的球馆不能调用地图坐标导航')
  assert.strictEqual(memory.clipboard, addressOnlyVenue.address)
})

test('首页球馆可直接标记并在保存失败时恢复原状态', async () => {
  resetRuntime()
  const venue = venueFixture('venue-home-mark')
  const statusPayloads = []
  const setPayloads = []
  let failSet = false
  installApi({
    venues: { list: async () => ({ items: [venue] }) },
    matches: { list: async () => ({ items: [] }) },
    favorites: {
      status: async (payload) => {
        statusPayloads.push(clone(payload))
        return { markedIds: [] }
      },
      set: async (payload) => {
        setPayloads.push(clone(payload))
        if (failSet) throw new Error('标记服务暂时不可用')
        return payload
      }
    }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  await home.loadContent({ showSkeleton: true })
  assert.deepStrictEqual(statusPayloads, [{ venueIds: [venue.id] }])
  assert.strictEqual(home.data.venues[0].favorited, false)

  await home.toggleVenueFavorite({ currentTarget: { dataset: { id: venue.id } } })
  assert.deepStrictEqual(setPayloads[0], { venueId: venue.id, marked: true })
  assert.strictEqual(home.data.venues[0].favorited, true)
  assert.strictEqual(home.data.favoriteSavingById[venue.id], undefined)

  failSet = true
  await home.toggleVenueFavorite({ currentTarget: { dataset: { id: venue.id } } })
  assert.deepStrictEqual(setPayloads[1], { venueId: venue.id, marked: false })
  assert.strictEqual(home.data.venues[0].favorited, true, '取消失败时必须恢复已标记状态')
  assert.strictEqual(home.data.favoriteSavingById[venue.id], undefined)

  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'home', 'home.wxml'), 'utf8')
  assert(template.includes('toggleVenueFavorite'))
  assert(template.includes('已标记'))
})

test('首页旧的标记状态响应不能覆盖稍后保存成功的结果', async () => {
  resetRuntime()
  const venue = venueFixture('venue-favorite-race')
  const staleStatus = deferred()
  const staleStatusStarted = deferred()
  let statusCalls = 0
  let remoteMarked = false
  installApi({
    venues: { list: async () => ({ items: [venue] }) },
    matches: { list: async () => ({ items: [] }) },
    favorites: {
      status: async () => {
        statusCalls += 1
        if (statusCalls === 2) {
          staleStatusStarted.resolve()
          return staleStatus.promise
        }
        return { markedIds: remoteMarked ? [venue.id] : [] }
      },
      set: async ({ marked }) => { remoteMarked = marked }
    }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  await home.loadContent({ showSkeleton: true })
  assert.strictEqual(home.data.venues[0].favorited, false)

  const refresh = home.loadContent()
  await staleStatusStarted.promise
  await home.toggleVenueFavorite({ currentTarget: { dataset: { id: venue.id } } })
  assert.strictEqual(home.data.venues[0].favorited, true)
  staleStatus.resolve({ markedIds: [] })
  await refresh
  assert.strictEqual(home.data.venues[0].favorited, true, '刷新开始较早的未标记响应不得覆盖已保存结果')

  await home.loadContent()
  assert.strictEqual(home.data.venues[0].favorited, true)
  assert.strictEqual(home.favoriteMutations[venue.id], undefined, '保存后的新鲜状态应清理临时覆盖')
})

test('首页将 45 个媒体 fileID 按最多 20 个分批解析并合并 URL', async () => {
  resetRuntime()
  const venues = Array.from({ length: 25 }, (_, index) => {
    const sequence = String(index + 1).padStart(2, '0')
    return Object.assign(venueFixture(`venue-media-${sequence}`), {
      name: `核验球馆 ${sequence}`,
      coverFileIds: [`cloud://laiyipai-prod/venues/cover-${sequence}.jpg`]
    })
  })
  const coaches = Array.from({ length: 20 }, (_, index) => {
    const sequence = String(index + 1).padStart(2, '0')
    return {
      id: `coach-media-${sequence}`,
      name: `认证教练 ${sequence}`,
      verified: true,
      venueIds: [venues[index % venues.length].id],
      avatarFileId: `cloud://laiyipai-prod/coaches/avatar-${sequence}.jpg`,
      specialty: ['基本功'],
      nextSlots: []
    }
  })
  const resolveBatches = []
  installApi({
    venues: { list: async () => ({ items: venues }) },
    coaches: { list: async () => ({ items: coaches }) },
    files: {
      resolve: async (fileIds) => {
        resolveBatches.push(fileIds.slice())
        return {
          urls: Object.fromEntries(fileIds.map((fileId) => [
            fileId,
            `https://cdn.laiyipai.cn/${encodeURIComponent(fileId.slice('cloud://'.length))}`
          ])),
          unresolved: []
        }
      }
    }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  home.setData({ mode: 'coaches' })
  await home.loadContent({ showSkeleton: true })

  assert.deepStrictEqual(resolveBatches.map((batch) => batch.length), [20, 20, 5])
  assert(resolveBatches.every((batch) => batch.length > 0 && batch.length <= 20))
  assert.strictEqual(new Set(resolveBatches.flat()).size, 45)
  assert.strictEqual(home.data.venues.filter((item) => item.coverUrl).length, 25)
  assert.strictEqual(home.data.coaches.filter((item) => item.avatarUrl).length, 20)
  assert.strictEqual(home.data.state, 'ready')
})

test('首页从云端得到真实空列表时进入可操作空状态', async () => {
  resetRuntime()
  let sessionCount = 0
  const payloads = []
  activeApp = {
    globalData: { session: null },
    ensureSession: async () => { sessionCount += 1; return { profile: {} } }
  }
  installApi({
    venues: { list: async (payload) => { payloads.push(['venues', payload]); return { items: [] } } },
    matches: { list: async (payload) => { payloads.push(['matches', payload]); return { items: [] } } },
    coaches: { list: async (payload) => { payloads.push(['coaches', payload]); return { items: [] } } }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  await home.loadContent()
  assert.strictEqual(sessionCount, 0, '游客读取真实空列表不应先恢复登录会话')
  assert.strictEqual(home.data.state, 'ready')
  assert.deepStrictEqual(home.data.venues, [])
  assert.deepStrictEqual(home.data.matches, [])
  assert.deepStrictEqual(home.data.coaches, [])
  assert(payloads.every((entry) => entry[1].city === '杭州'))
  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'home', 'home.wxml'), 'utf8')
  assert(template.includes('暂时没有合适的球局'))
  assert(template.includes('当前地区暂无可约教练'))
  assert(template.includes('bindtap="openPublish"'))
})

test('无结果时主动放宽日期球龄并保留地区，再次放宽才查询全杭州', async () => {
  resetRuntime()
  const payloads = []
  installApi({
    matches: { list: async (payload) => { payloads.push(payload); return { items: [] } } }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  home.setData({ districtIndex: 1, districtLabel: '西湖区', ballAgeIndex: 2 })
  await home.loadContent()
  assert.strictEqual(payloads[0].date, dateString(0))
  assert.strictEqual(payloads[0].expectedBallAge, '球龄 1 年以内')
  assert.strictEqual(home.data.ballAgeIndex, 2, '空结果不能自动放宽用户筛选')

  await home.expandMatchSearch()
  assert.strictEqual(payloads[1].district, '西湖区')
  assert.strictEqual(payloads[1].date, undefined)
  assert.strictEqual(payloads[1].expectedBallAge, undefined)
  assert.strictEqual(home.data.districtIndex, 1)
  assert.strictEqual(home.data.selectedDate, '')
  assert.strictEqual(home.data.ballAgeIndex, 0)

  await home.expandMatchSearch()
  assert.strictEqual(payloads[2].district, undefined)
  assert.strictEqual(payloads[2].city, '杭州')
  assert.strictEqual(home.data.districtLabel, '')
  assert.strictEqual(wx.getStorageSync('laiyipai_ui_home_filters_v1').district, '全杭州')
})

test('首页缓存跨天返回时刷新日期栏，同时保留全部日期选择', async () => {
  resetRuntime()
  const requestedDates = []
  installApi({
    matches: { list: async (payload) => { requestedDates.push(payload.date); return { items: [] } } }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  home.setData({
    selectedDate: dateString(-1),
    dateOptions: [{ value: dateString(-1), weekday: '今天', label: '旧日期' }]
  })
  await home.onShow()
  assert.strictEqual(home.data.selectedDate, dateString(0))
  assert.strictEqual(requestedDates[0], dateString(0))
  assert(home.data.dateOptions.some((item) => item.value === dateString(0)))
  assert(!home.data.dateOptions.some((item) => item.value === dateString(-1)))
  home.setData({ selectedDate: '' })
  await home.onShow()
  assert.strictEqual(home.data.selectedDate, '')
  assert.strictEqual(requestedDates[1], undefined)
})

test('教练空状态扩大地区仍保留教练模式且不请求球局', async () => {
  resetRuntime()
  let matchRequests = 0
  const coachRequests = []
  installApi({
    matches: { list: async () => { matchRequests += 1; return { items: [] } } },
    coaches: { list: async (payload) => { coachRequests.push(payload); return { items: [] } } }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  home.setData({ mode: 'coaches', districtIndex: 1, districtLabel: '西湖区' })
  await home.expandCoachSearch()
  assert.strictEqual(home.data.mode, 'coaches')
  assert.strictEqual(home.data.districtIndex, 0)
  assert.strictEqual(matchRequests, 0)
  assert.strictEqual(coachRequests.length, 1)
  assert.strictEqual(coachRequests[0].district, undefined)
  assert.strictEqual(coachRequests[0].city, '杭州')
})

test('首页球局分页可跨过空页并按 ID 合并去重', async () => {
  resetRuntime()
  const requestedPages = []
  installApi({
    matches: {
      list: async (payload) => {
        requestedPages.push(payload.page)
        if (payload.page === 1) return { items: [], page: 1, pageSize: 50, hasMore: true }
        if (payload.page === 2) {
          return {
            items: [matchFixture({ id: 'match-page-1' }), matchFixture({ id: 'match-page-2' })],
            page: 2,
            pageSize: 50,
            hasMore: true
          }
        }
        return {
          items: [
            matchFixture({ id: 'match-page-2', title: '更新后的球局' }),
            matchFixture({ id: 'match-page-3' })
          ],
          page: 3,
          pageSize: 50,
          hasMore: false
        }
      }
    }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  await home.loadContent()
  assert.deepStrictEqual(home.data.matches, [])
  assert.strictEqual(home.data.matchesHasMore, true, '空首屏仍需允许继续翻页')
  assert.strictEqual(home.data.matchesPage, 1)

  await home.loadMore()
  assert.deepStrictEqual(home.data.matches.map((item) => item.id), ['match-page-1', 'match-page-2'])
  await home.loadMore()
  assert.deepStrictEqual(home.data.matches.map((item) => item.id), ['match-page-1', 'match-page-2', 'match-page-3'])
  assert.strictEqual(home.data.matches[1].title, '更新后的球局')
  assert.strictEqual(home.data.matchesHasMore, false)
  assert.strictEqual(home.data.matchesPage, 3)
  assert.deepStrictEqual(requestedPages, [1, 2, 3])

  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'home', 'home.wxml'), 'utf8')
  assert(template.includes('已显示 '))
  assert(template.includes('加载更多球局'))
  assert(!template.includes('matchCountText'), '球馆卡片不能展示仅由当前分页推算的场次数')
})

test('首页教练分页合并去重并保留各自页码', async () => {
  resetRuntime()
  const requestedPages = []
  const coach = (id, name) => ({ id, name, venueIds: [], specialty: ['基础训练'], nextSlots: [] })
  installApi({
    coaches: {
      list: async (payload) => {
        requestedPages.push(payload.page)
        return payload.page === 1
          ? { items: [coach('coach-page-1', '陈教练')], page: 1, pageSize: 30, hasMore: true }
          : {
              items: [coach('coach-page-1', '陈教练（新）'), coach('coach-page-2', '林教练')],
              page: 2,
              pageSize: 30,
              hasMore: false
            }
      }
    }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  home.setData({ mode: 'coaches' })
  await home.loadContent({ showSkeleton: true })
  await home.loadMore()
  assert.deepStrictEqual(home.data.coaches.map((item) => item.id), ['coach-page-1', 'coach-page-2'])
  assert.strictEqual(home.data.coaches[0].displayName, '陈教练（新）')
  assert.strictEqual(home.data.coachesPage, 2)
  assert.strictEqual(home.data.coachesHasMore, false)
  assert.strictEqual(home.data.matchesPage, 0)
  assert.deepStrictEqual(requestedPages, [1, 2])
})

test('首页分页失败保留已有列表并可重试同一页', async () => {
  resetRuntime()
  let secondPageAttempts = 0
  installApi({
    matches: {
      list: async (payload) => {
        if (payload.page === 1) {
          return { items: [matchFixture({ id: 'match-kept' })], page: 1, pageSize: 50, hasMore: true }
        }
        secondPageAttempts += 1
        if (secondPageAttempts === 1) throw new Error('下一页暂时不可用')
        return { items: [matchFixture({ id: 'match-retried' })], page: 2, pageSize: 50, hasMore: false }
      }
    }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  await home.loadContent()

  const failed = await home.loadMore()
  assert.strictEqual(failed, false)
  assert.deepStrictEqual(home.data.matches.map((item) => item.id), ['match-kept'])
  assert.strictEqual(home.data.state, 'ready')
  assert.strictEqual(home.data.matchesPage, 1)
  assert.strictEqual(home.data.matchesHasMore, true)
  assert(home.data.paginationError.includes('下一页暂时不可用'))

  await home.retryPagination()
  assert.strictEqual(secondPageAttempts, 2)
  assert.deepStrictEqual(home.data.matches.map((item) => item.id), ['match-kept', 'match-retried'])
  assert.strictEqual(home.data.paginationError, '')
  assert.strictEqual(home.data.matchesPage, 2)
})

test('筛选刷新会丢弃尚未返回的旧分页结果', async () => {
  resetRuntime()
  let resolveOldPage
  const oldPage = new Promise((resolve) => { resolveOldPage = resolve })
  installApi({
    matches: {
      list: async (payload) => {
        if (payload.page === 2) return oldPage
        if (payload.district === '西湖区') {
          return { items: [matchFixture({ id: 'match-filtered' })], page: 1, pageSize: 50, hasMore: false }
        }
        return { items: [matchFixture({ id: 'match-before-filter' })], page: 1, pageSize: 50, hasMore: true }
      }
    }
  })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  await home.loadContent()

  const oldRequest = home.loadMore()
  await Promise.resolve()
  home.setData({ districtIndex: 1, districtLabel: '西湖区' })
  await home.loadContent({ showSkeleton: true })
  resolveOldPage({ items: [matchFixture({ id: 'match-stale-page' })], page: 2, pageSize: 50, hasMore: false })
  await oldRequest

  assert.deepStrictEqual(home.data.matches.map((item) => item.id), ['match-filtered'])
  assert.strictEqual(home.data.matchesPage, 1)
  assert.strictEqual(home.data.matchesHasMore, false)
  assert.strictEqual(home.data.loadingMore, false)
})

test('首页跨天切换筛选失败时不把旧日期列表留在可操作状态', async () => {
  resetRuntime()
  installApi({ matches: { list: async () => { throw new Error('当天球局加载失败') } } })
  const home = loadPage('pages/home/home.js')
  home.onLoad()
  home.setData({
    state: 'ready',
    selectedDate: dateString(-1),
    matches: [matchFixture({ id: 'match-yesterday' })]
  })
  await home.onShow()
  assert.strictEqual(home.data.selectedDate, dateString(0))
  assert.strictEqual(home.data.state, 'error')
  assert(home.data.errorMessage.includes('当天球局加载失败'))
})

test('发布页恢复过期草稿时回退到有效的默认时段', async () => {
  resetRuntime()
  installApi()
  const today = dateString(0)
  wx.setStorageSync('laiyipai_ui_publish_draft_v2', {
    title: '过期草稿',
    date: dateString(-3),
    startTime: '19:00',
    endTime: '20:30',
    termsVersion: require(cloudConfigPath).termsVersion
  })

  const publish = loadPage('pages/publish/publish.js')
  publish.onLoad()
  assert.strictEqual(publish.data.minimumDate, today)
  assert(publish.data.date >= today)
  assert.notStrictEqual(publish.data.date, dateString(-3))
  assert(new Date(`${publish.data.date}T${publish.data.startTime}:00+08:00`).getTime() >= Date.now() + 10 * 60 * 1000)
  assert(publish.data.dateLabel)
  await nextEventLoopTurn()
})

test('发布页晚间生成的默认时间始终能在同一日期内结束', async () => {
  resetRuntime()
  installApi()
  const NativeDate = global.Date
  let fixedTimestamp = new NativeDate(2026, 8, 4, 21, 10, 0, 0).getTime()
  class FixedDate extends NativeDate {
    constructor(...args) {
      if (args.length) super(...args)
      else super(fixedTimestamp)
    }

    static now() {
      return fixedTimestamp
    }
  }

  try {
    global.Date = FixedDate
    for (const hour of [21, 22]) {
      fixedTimestamp = new NativeDate(2026, 8, 4, hour, 10, 0, 0).getTime()
      const publish = loadPage('pages/publish/publish.js')
      publish.onLoad()
      const [startHour, startMinute] = publish.data.startTime.split(':').map(Number)
      const [endHour, endMinute] = publish.data.endTime.split(':').map(Number)
      const startTotal = startHour * 60 + startMinute
      const endTotal = endHour * 60 + endMinute
      assert.strictEqual(publish.data.minimumDate, '2026-09-04')
      assert(publish.data.date >= publish.data.minimumDate, '默认日期不能早于今天')
      assert(endTotal > startTotal, `${hour}:10 生成的同日结束时间 ${publish.data.endTime} 必须晚于开始时间 ${publish.data.startTime}`)
      await nextEventLoopTurn()
    }
  } finally {
    global.Date = NativeDate
  }
})

test('发布允许留空标题并提交默认标题、规范球馆 ID 与稳定幂等键', async () => {
  resetRuntime()
  const venues = [venueFixture('venue_huanglong'), venueFixture('venue_xihu')]
  const createCalls = []
  activeApp = { ensureSession: async () => ({ profile: { playerId: 'player-me' } }) }
  installApi({
    venues: { list: async () => ({ items: venues }) },
    matches: {
      create: async (payload, options) => {
        createCalls.push({ payload: clone(payload), options: clone(options) })
        return { match: matchFixture(Object.assign({ id: 'match-created', venue: venues[1] }, payload)), membership: { status: 'host', canChat: true } }
      }
    }
  })
  const publish = loadPage('pages/publish/publish.js')
  publish.onLoad()
  await publish.loadVenues()
  publish.changeVenue({ detail: { value: '1' } })
  publish.setData({
    title: '',
    date: dateString(3),
    startTime: '19:00',
    endTime: '20:30',
    capacity: 7,
    ballAgeIndex: 3,
    practiceIntent: '切磋球技',
    joinMode: 'confirm',
    courtStatus: 'booked',
    feePerPerson: '35',
    note: '前台集合，费用到店 AA',
    termsAccepted: true
  })
  await publish.submit()
  assert.strictEqual(createCalls.length, 1)
  const call = createCalls[0]
  assert.strictEqual(call.payload.title, '轻松练一场')
  assert.strictEqual(call.payload.venueId, 'venue_xihu')
  assert.strictEqual(call.payload.feePerPerson, 35)
  assert.strictEqual(call.payload.capacity, 7)
  assert.strictEqual(call.payload.expectedBallAge, '球龄 2—5 年')
  assert.strictEqual(call.payload.practiceIntent, '切磋球技')
  assert(!Object.prototype.hasOwnProperty.call(call.payload, 'skills'))
  assert.strictEqual(call.payload.joinMode, 'confirm')
  assert.strictEqual(call.payload.courtStatus, 'booked')
  assert.strictEqual(call.payload.termsAccepted, true)
  assert.strictEqual(call.payload.termsVersion, require(cloudConfigPath).termsVersion)
  assert(!Object.prototype.hasOwnProperty.call(call.payload, 'venueName'))
  assert(!Object.prototype.hasOwnProperty.call(call.payload, 'address'))
  assert(/^req_client_\d+$/.test(call.options.requestId))
  assert.strictEqual(publish.data.publishedMatch.id, 'match-created')
  assert.strictEqual(memory.laiyipai_ui_publish_draft_v2, undefined)
})

test('仅有名称的球馆仍可选择并用于发布球局', async () => {
  resetRuntime()
  const venues = [nameOnlyVenueFixture('venue_xiaochao'), nameOnlyVenueFixture('venue_guiyu')]
  const createCalls = []
  installApi({
    venues: { list: async () => ({ items: venues }) },
    matches: {
      create: async (payload) => {
        createCalls.push(clone(payload))
        return { match: matchFixture({ id: 'match-name-only', venueId: payload.venueId, venue: venues[1] }) }
      }
    }
  })
  const publish = loadPage('pages/publish/publish.js')
  publish.onLoad()
  await publish.loadVenues()
  assert.deepStrictEqual(publish.data.venueNames, ['萧潮乒乓球馆', '桂语朝阳乒乓球室'])

  publish.changeVenue({ detail: { value: '1' } })
  assert.strictEqual(publish.data.selectedVenue.name, '桂语朝阳乒乓球室')
  assert.deepStrictEqual(publish.data.selectedVenue.activityTags, ['切磋'])
  publish.setData({
    date: dateString(3),
    startTime: '19:00',
    endTime: '20:30',
    termsAccepted: true
  })
  await publish.submit()
  assert.strictEqual(createCalls.length, 1)
  assert.strictEqual(createCalls[0].venueId, 'venue_guiyu')
  assert.strictEqual(createCalls[0].capacity, 2)

  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'publish', 'publish.wxml'), 'utf8')
  assert(template.includes('selectedVenue.activityTags'))
  assert(template.includes('selectedVenue.locationText'))
})

test('想练什么固定为随便练练与切磋球技两项单选', () => {
  resetRuntime()
  installApi()
  const publish = loadPage('pages/publish/publish.js')
  const labels = publish.data.practiceIntentOptions.map((item) => item.value)
  assert.deepStrictEqual(labels, ['随便练练', '切磋球技'])
  assert.strictEqual(publish.data.practiceIntent, '随便练练')

  publish.selectPracticeIntent({ currentTarget: { dataset: { value: '切磋球技' } } })
  assert.strictEqual(publish.data.practiceIntent, '切磋球技')
  publish.selectPracticeIntent({ currentTarget: { dataset: { value: '其他玩法' } } })
  assert.strictEqual(publish.data.practiceIntent, '切磋球技')

  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'publish', 'publish.wxml'), 'utf8')
  assert(template.includes('想练什么'))
  assert(template.includes('practiceIntentOptions'))
  assert(!template.includes('最多 3 项'))
})

test('发布页默认 2 人，草稿保留已选人数，重置恢复 2 人', async () => {
  resetRuntime()
  installApi()
  const publish = loadPage('pages/publish/publish.js')
  publish.onLoad()
  await publish.loadVenues()
  assert.strictEqual(publish.data.capacity, 2)
  publish.commitCapacity({ detail: { value: 6 } })
  const restored = loadPage('pages/publish/publish.js')
  restored.onLoad()
  await restored.loadVenues()
  assert.strictEqual(restored.data.capacity, 6)
  restored.resetForm()
  assert.strictEqual(restored.data.capacity, 2)
  for (const value of [undefined, null, '', 'invalid', 2.5]) {
    restored.setCapacity(value)
    assert.strictEqual(restored.data.capacity, 2)
  }
  const clientState = require('../utils/client-state')
  assert.strictEqual(clientState.setRebookPrefill({}).capacity, 2)
  assert.strictEqual(clientState.setRebookPrefill({ capacity: 6 }).capacity, 6)
  clientState.consumePublishPrefill()
})

test('发布页用紧凑滑块选择 1—8 人并实时预览', () => {
  resetRuntime()
  installApi()
  const publish = loadPage('pages/publish/publish.js')

  assert.strictEqual(publish.data.capacityMin, 1)
  assert.strictEqual(publish.data.capacityMax, 8)
  assert.strictEqual(publish.data.capacity, 2)
  publish.setData({ joinMode: 'confirm' })
  publish.previewCapacity({ detail: { value: 6 } })
  assert.strictEqual(publish.data.capacity, 6)
  publish.commitCapacity({ detail: { value: 1 } })
  assert.strictEqual(publish.data.capacity, 1)
  assert.strictEqual(publish.data.joinMode, 'direct')
  publish.commitCapacity({ detail: { value: 8 } })
  assert.strictEqual(publish.data.capacity, 8)
  publish.setCapacity(20)
  assert.strictEqual(publish.data.capacity, 8)
  publish.setCapacity(0)
  assert.strictEqual(publish.data.capacity, 1)
})

test('球局详情刷新时球馆接口失败仍保留已展示的位置', async () => {
  resetRuntime()
  const matchId = 'match-location-fallback'
  const venueId = 'venue-location-fallback'
  const location = { latitude: 30.2741, longitude: 120.1551 }
  const rawMatch = matchFixture({
    id: matchId,
    venueId,
    venue: { id: venueId, name: '已载入位置球馆', address: '杭州市西湖区保留路 1 号' }
  })
  installApi({
    matches: { get: async () => ({
      match: rawMatch,
      membership: null,
      confirmedCount: 1,
      hostVideos: [{ id: 'legacy-host-media', url: 'https://temp.example/legacy.mp4' }]
    }) },
    venues: { get: async () => { throw new Error('球馆接口暂时不可用') } }
  })
  const detail = loadPage('pages/match-detail/match-detail.js')
  detail.onLoad({ id: matchId })
  detail.setData({
    state: 'ready',
    match: Object.assign({}, rawMatch, {
      venueName: rawMatch.venue.name,
      address: rawMatch.venue.address,
      venueLocationText: `西湖区 · ${rawMatch.venue.address}`,
      hasLocation: true,
      location
    })
  })

  assert.strictEqual(await detail.loadMatch({ keepContent: true }), true)
  assert.strictEqual(detail.data.match.hasLocation, true)
  assert.deepStrictEqual(detail.data.match.location, location)
  assert.strictEqual(detail.data.match.hostVideos, undefined)

  detail.openMap()
  assert.strictEqual(openedLocations.length, 1)
  assert.strictEqual(openedLocations[0].latitude, location.latitude)
  assert.strictEqual(openedLocations[0].longitude, location.longitude)
})

test('球局首次载入会保留快照坐标，不被失败的球馆补充接口清空', async () => {
  resetRuntime()
  const matchId = 'match-snapshot-location'
  const venueId = 'venue-snapshot-location'
  const location = { latitude: 30.2912, longitude: 120.1824 }
  const rawMatch = matchFixture({
    id: matchId,
    venueId,
    venue: {
      id: venueId,
      name: '快照位置球馆',
      district: '拱墅区',
      address: '杭州市拱墅区球馆路 8 号',
      location
    }
  })
  installApi({
    matches: { get: async () => ({ match: rawMatch, membership: null, confirmedCount: 1 }) },
    venues: { get: async () => { throw new Error('补充资料暂不可用') } }
  })
  const detail = loadPage('pages/match-detail/match-detail.js')
  detail.onLoad({ id: matchId })
  assert.strictEqual(await detail.loadMatch(), true)
  assert.strictEqual(detail.data.match.hasLocation, true)
  assert.deepStrictEqual(detail.data.match.location, location)
})

test('实时球馆暂缺坐标时不会清空球局快照地图', async () => {
  resetRuntime()
  const matchId = 'match-name-only-live-location'
  const venueId = 'venue-name-only-live-location'
  const location = { latitude: 30.2468, longitude: 120.1732 }
  const rawMatch = matchFixture({
    id: matchId,
    venueId,
    venue: {
      id: venueId,
      name: '快照球馆',
      district: '上城区',
      address: '杭州市上城区快照路 6 号',
      location
    }
  })
  installApi({
    matches: { get: async () => ({ match: rawMatch, membership: null, confirmedCount: 1 }) },
    venues: { get: async () => ({ id: venueId, name: '快照球馆', verified: true }) }
  })
  const detail = loadPage('pages/match-detail/match-detail.js')
  detail.onLoad({ id: matchId })
  await detail.loadMatch()
  assert.strictEqual(detail.data.match.hasLocation, true)
  assert.deepStrictEqual(detail.data.match.location, location)
  assert.strictEqual(detail.data.match.address, rawMatch.venue.address)
})

test('球局详情不会把暂时未知的球馆标记状态显示为未标记', async () => {
  resetRuntime()
  const rawMatch = matchFixture({ id: 'match-favorite-status-retry' })
  let statusCalls = 0
  let setCalls = 0
  installApi({
    matches: { get: async () => ({ match: rawMatch, membership: null, confirmedCount: 1 }) },
    venues: { get: async () => venueFixture(rawMatch.venueId) },
    favorites: {
      status: async () => {
        statusCalls += 1
        if (statusCalls === 1) throw new Error('status unavailable')
        return { markedIds: [rawMatch.venueId] }
      },
      set: async () => { setCalls += 1 }
    }
  })
  const detail = loadPage('pages/match-detail/match-detail.js')
  detail.onLoad({ id: rawMatch.id })
  await detail.loadMatch()
  assert.strictEqual(detail.data.favoriteStatus, 'unknown')

  await detail.toggleFavorite()
  assert.strictEqual(statusCalls, 2)
  assert.strictEqual(setCalls, 0)
  assert.strictEqual(detail.data.favoriteStatus, 'marked')
  assert.strictEqual(detail.data.match.venueFavorited, true)
  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'match-detail', 'match-detail.wxml'), 'utf8')
  assert(template.includes('状态待确认'))
})

test('单人练习详情不开放加入或候补', async () => {
  resetRuntime()
  let joinCalls = 0
  const soloMatch = matchFixture({
    id: 'match-solo-practice',
    title: '单人发球练习',
    capacity: 1,
    participantCount: 1,
    seats: 0,
    status: 'full'
  })
  installApi({
    matches: {
      get: async () => ({ match: soloMatch, membership: null, confirmedCount: 1 }),
      join: async () => { joinCalls += 1 }
    },
    venues: { get: async () => venueFixture() },
    favorites: { list: async () => ({ items: [] }) }
  })
  const detail = loadPage('pages/match-detail/match-detail.js')
  detail.onLoad({ id: soloMatch.id })
  await detail.loadMatch()

  assert.strictEqual(detail.data.match.soloPractice, true)
  assert.strictEqual(detail.data.match.seatText, '单人练习')
  assert.strictEqual(detail.data.match.joinModeText, '不开放加入')
  assert.strictEqual(detail.data.match.actionText, '单人练习')
  assert.strictEqual(detail.data.match.actionDisabled, true)
  detail.primaryAction()
  assert.strictEqual(detail.data.joinSheet, false)
  assert.strictEqual(joinCalls, 0)

  soloMatch.status = 'cancelled'
  await detail.loadMatch()
  assert.strictEqual(detail.data.match.statusLabel, '已取消')
  assert.strictEqual(detail.data.match.actionText, '找其他球局')
  detail.primaryAction()
  assert.strictEqual(navigation[navigation.length - 1].url, '/pages/home/home')
})

test('加入有空位球局时不请求候补并开放对话', async () => {
  resetRuntime()
  let membership = null
  let joinCall
  const rawMatch = matchFixture({ participantCount: 2, capacity: 4, seats: 2 })
  installApi({
    matches: {
      get: async () => ({ match: rawMatch, membership, confirmedCount: 2 }),
      join: async (payload, options) => {
        joinCall = { payload: clone(payload), options: clone(options) }
        membership = { status: 'joined', canChat: true }
        return { match: rawMatch, membership }
      }
    },
    venues: { get: async () => venueFixture() },
    favorites: { list: async () => ({ items: [] }) }
  })
  const detail = loadPage('pages/match-detail/match-detail.js')
  detail.onLoad({ id: rawMatch.id })
  detail.setData({ match: { seats: 2 } })
  await detail.confirmJoin()
  assert.deepStrictEqual(joinCall.payload, {
    matchId: rawMatch.id,
    allowWaitlist: false,
    termsAccepted: true,
    termsVersion: require(cloudConfigPath).termsVersion
  })
  assert(/^req_client_\d+$/.test(joinCall.options.requestId))
  assert.strictEqual(detail.data.resultTitle, '加入成功')
  assert.strictEqual(detail.data.canChat, true)
  assert.strictEqual(detail.data.membership.status, 'joined')
})

test('满员球局明确请求候补且候补期间不开放对话', async () => {
  resetRuntime()
  let membership = null
  let joinPayload
  const rawMatch = matchFixture({ participantCount: 4, capacity: 4, seats: 0, status: 'full' })
  installApi({
    matches: {
      get: async () => ({ match: rawMatch, membership, confirmedCount: 4 }),
      join: async (payload) => {
        joinPayload = clone(payload)
        membership = { status: 'waitlisted', canChat: false }
        return { match: rawMatch, membership }
      }
    },
    venues: { get: async () => venueFixture() },
    favorites: { list: async () => ({ items: [] }) }
  })
  const detail = loadPage('pages/match-detail/match-detail.js')
  detail.onLoad({ id: rawMatch.id })
  detail.setData({ match: { seats: 0 } })
  await detail.confirmJoin()
  assert.deepStrictEqual(joinPayload, {
    matchId: rawMatch.id,
    allowWaitlist: true,
    termsAccepted: true,
    termsVersion: require(cloudConfigPath).termsVersion
  })
  assert.strictEqual(detail.data.resultTitle, '已加入候补')
  assert.strictEqual(detail.data.canChat, false)
  assert.strictEqual(detail.data.membership.status, 'waitlisted')
  assert.strictEqual(detail.data.match.actionText, '查看候补状态')
  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'match-detail', 'match-detail.wxml'), 'utf8')
  assert(template.includes("match.seats > 0 ? match.joinModeText : '候补申请'"))
})

test('对话缺少球局 ID 时立即退出加载态', () => {
  resetRuntime()
  installApi()
  const chat = loadPage('pages/chat/chat.js')
  chat.onLoad({})
  assert.strictEqual(chat.data.state, 'error')
  assert.strictEqual(chat.data.forbidden, true)
  assert(chat.data.errorMessage.includes('链接不完整'))
})

test('对话在结束二十四小时后由轮询切换为关闭状态', async () => {
  resetRuntime()
  let listCount = 0
  const rawMatch = matchFixture({ id: 'match-chat-expiry' })
  installApi({
    matches: {
      get: async () => ({
        match: rawMatch,
        membership: { status: 'joined', canChat: true, confirmedScheduleVersion: 1 },
        confirmedCount: 2
      })
    },
    venues: { get: async () => venueFixture() },
    messages: {
      list: async () => {
        listCount += 1
        if (listCount > 1) {
          const error = new Error('球局结束 24 小时后群聊已关闭')
          error.code = 'CHAT_CLOSED'
          throw error
        }
        return { items: [], nextCursor: null }
      }
    }
  })
  const chat = loadPage('pages/chat/chat.js')
  chat.onLoad({ id: rawMatch.id })
  await chat.loadChat()
  assert.strictEqual(chat.data.state, 'ready')
  await chat.refreshMessages()
  assert.strictEqual(chat.data.state, 'error')
  assert.strictEqual(chat.data.forbidden, true)
  assert(chat.data.errorMessage.includes('24 小时'))
})

test('预约中心按时期与类型筛选，并分别调用球局和教练取消接口', async () => {
  resetRuntime()
  const items = [
    coachAppointment('coach-upcoming', 'confirmed', 4),
    matchAppointment('match-upcoming', 'joined', 3),
    matchAppointment('match-history', 'cancelled', -3)
  ]
  const matchCancels = []
  const coachCancels = []
  installApi({
    appointments: { list: async () => ({ items }) },
    matches: { cancel: async (payload, options) => { matchCancels.push({ payload: clone(payload), options: clone(options) }) } },
    coachBookings: { cancel: async (payload, options) => { coachCancels.push({ payload: clone(payload), options: clone(options) }) } }
  })
  const orders = loadPage('pages/orders/orders.js')
  await orders.loadAppointments()
  assert.strictEqual(orders.data.state, 'ready')
  assert.strictEqual(orders.data.appointments.length, 2)
  assert.strictEqual(orders.data.appointments[0].isNext, true)
  assert.strictEqual(orders.data.appointments[0].id, 'match-upcoming')
  assert.strictEqual(orders.data.appointments[1].isNext, false)
  assert.deepStrictEqual(orders.data.typeOptions.map(({ value, count }) => [value, count]), [
    ['all', 2],
    ['match', 1],
    ['coach', 1]
  ])

  orders.changeType({ currentTarget: { dataset: { value: 'match' } } })
  assert.strictEqual(orders.data.appointments.length, 1)
  assert.strictEqual(orders.data.appointments[0].kind, 'match')
  assert.strictEqual(orders.data.emptyActionText, '去找球局')
  orders.openCancel({ currentTarget: { dataset: { id: 'match-upcoming' } } })
  orders.changeCancelReason({ detail: { value: '1' } })
  await orders.confirmCancel()
  assert.strictEqual(matchCancels.length, 1)
  assert.deepStrictEqual(matchCancels[0].payload, {
    matchId: 'resource-match-upcoming',
    expectedVersion: 7,
    reason: '时间不合适'
  })

  orders.changeType({ currentTarget: { dataset: { value: 'coach' } } })
  assert.strictEqual(orders.data.appointments.length, 1)
  assert.strictEqual(orders.data.emptyActionText, '去看看教练')
  orders.openCancel({ currentTarget: { dataset: { id: 'coach-upcoming' } } })
  await orders.confirmCancel()
  assert.strictEqual(coachCancels.length, 1)
  assert.deepStrictEqual(coachCancels[0].payload, {
    bookingId: 'resource-coach-upcoming',
    expectedVersion: 5,
    reason: '临时有事'
  })

  orders.changePeriod({ currentTarget: { dataset: { value: 'history' } } })
  orders.changeType({ currentTarget: { dataset: { value: 'all' } } })
  assert.strictEqual(orders.data.appointments.length, 1)
  assert.strictEqual(orders.data.appointments[0].id, 'match-history')
  assert.strictEqual(orders.data.appointments[0].isNext, false)
  assert.deepStrictEqual(orders.data.typeOptions.map(({ value, count }) => [value, count]), [
    ['all', 1],
    ['match', 1],
    ['coach', 0]
  ])
})

test('预约中心切到教练类型时不显示球局加入申请', () => {
  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'orders', 'orders.wxml'), 'utf8')
  assert(template.includes("period === 'upcoming' && type !== 'coach' && joinRequests.length"))
  assert(template.includes("type !== 'coach' && hasHostMatches && !joinRequests.length"), '没有申请制球局时不应展示无效的申请空卡片')
  assert(template.includes('item.count'), '类型筛选应显示当前周期内的预约数量')
  assert(template.includes("item.isNext ? '下一场 · ' : ''"), '当前安排应标明下一场')
})

test('单人练习改期后仍可确认新时间且不显示沟通入口', async () => {
  resetRuntime()
  const soloAppointment = matchAppointment('solo-rescheduled', 'schedule_confirmation_required', 3, 'host')
  soloAppointment.match.capacity = 1
  soloAppointment.match.participantCount = 1
  soloAppointment.match.seats = 0
  soloAppointment.match.status = 'changed'
  installApi({ appointments: { list: async () => ({ items: [soloAppointment] }) } })
  const orders = loadPage('pages/orders/orders.js')
  await orders.loadAppointments()

  const item = orders.data.appointments[0]
  assert.strictEqual(item.kindLabel, '单人练习')
  assert.strictEqual(item.canChat, false)
  assert.strictEqual(item.canConfirmSchedule, true)
  assert.strictEqual(item.canCancel, true)
  assert.strictEqual(item.showActions, true)
  assert.strictEqual(item.cancelPolicyText, '取消后会关闭这次单人练习。')
})

test('预约主列表不等待加入申请接口即可先展示', async () => {
  resetRuntime()
  let resolvePending
  installApi({
    appointments: { list: async () => ({ items: [matchAppointment('host-upcoming', 'recruiting', 3, 'host')] }) },
    matches: {
      pending: async () => new Promise((resolve) => { resolvePending = resolve })
    }
  })
  const orders = loadPage('pages/orders/orders.js')
  await orders.loadAppointments()
  assert.strictEqual(orders.data.state, 'ready')
  assert.strictEqual(orders.data.appointments.length, 1)
  assert.strictEqual(orders.data.joinRequestsState, 'loading')

  resolvePending({
    items: [{
      membershipId: 'membership-pending-1',
      status: 'pending',
      player: { displayName: '周球友', ballAge: '球龄 2—5 年', skills: ['反手拨球'] }
    }]
  })
  await nextEventLoopTurn()
  assert.strictEqual(orders.data.joinRequestsState, 'ready')
  assert.strictEqual(orders.data.joinRequests[0].applicantName, '周球友')
})

test('预约列表刷新失败保留旧内容，不冒充加入申请故障', async () => {
  resetRuntime()
  let fail = false
  installApi({
    appointments: {
      list: async () => {
        if (fail) throw Object.assign(new Error('预约列表暂不可用'), { code: 'SERVICE_UNAVAILABLE' })
        return { items: [matchAppointment('kept-appointment', 'joined', 3)] }
      }
    }
  })
  const orders = loadPage('pages/orders/orders.js')
  await orders.loadAppointments()
  await orders.joinRequestsLoading
  const previousJoinState = orders.data.joinRequestsState
  fail = true
  await orders.loadAppointments()
  assert.strictEqual(orders.data.state, 'ready')
  assert.strictEqual(orders.data.appointments[0].id, 'kept-appointment')
  assert.strictEqual(orders.data.joinRequestsState, previousJoinState)
  assert(orders.data.syncError.includes('预约列表'))
})

test('教练认证页按版本重提并显式提交协议同意', async () => {
  resetRuntime()
  const submissions = []
  const rejected = {
    id: 'coach-application-self',
    status: 'rejected',
    realName: '陈教练',
    mobile: '13800138000',
    experienceYears: 6,
    specialty: ['基本功', '发球接发'],
    venueName: '萧潮乒乓球馆',
    introduction: '按学员节奏安排训练。',
    qualification: '六年青少年乒乓球教学经验',
    reviewReason: '请补充常驻球馆信息',
    version: 2
  }
  installApi({
    coachApplications: {
      get: async () => ({ status: 'rejected', application: rejected }),
      submit: async (payload) => {
        submissions.push(clone(payload))
        return { application: Object.assign({}, payload, { id: rejected.id, status: 'reviewing', version: 3 }) }
      }
    }
  })
  const page = loadPage('pages/coach-apply/coach-apply.js')
  await page.loadApplication()
  assert.strictEqual(page.data.status, 'rejected')
  assert.strictEqual(page.data.application.reviewReason, '请补充常驻球馆信息')
  assert.strictEqual(page.data.form.qualification, '六年青少年乒乓球教学经验')

  page.changeTerms({ detail: { value: ['accepted'] } })
  await page.submitApplication()
  assert.strictEqual(submissions.length, 1)
  assert.strictEqual(submissions[0].termsAccepted, true)
  assert.strictEqual(submissions[0].termsVersion, require(cloudConfigPath).termsVersion)
  assert.strictEqual(submissions[0].expectedVersion, 2)
  assert.strictEqual(submissions[0].qualification, '六年青少年乒乓球教学经验')
  assert.strictEqual(page.data.status, 'reviewing')

  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'coach-apply', 'coach-apply.wxml'), 'utf8')
  assert(template.includes('无需上传证件图片'))
  assert(template.includes('maxlength="300"'))
  assert(!template.includes('chooseMedia'))
})

test('个人资料先展示基础资料，不等待标记球馆接口', async () => {
  resetRuntime()
  const pendingFavorites = deferred()
  installApi({
    profile: { get: async () => profileFixture({ nickname: '先看到我' }) },
    favorites: { list: async () => pendingFavorites.promise }
  })
  const profile = loadPage('pages/profile/profile.js')
  const loading = profile.loadProfile()
  await nextEventLoopTurn()

  assert.strictEqual(profile.data.state, 'ready')
  assert.strictEqual(profile.data.profile.nickname, '先看到我')
  assert.strictEqual(profile.data.venuesState, 'loading')

  pendingFavorites.resolve({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false })
  await loading
  assert.strictEqual(profile.data.venuesState, 'ready')
})

test('我的页面每次显示都会刷新服务端管理员能力', async () => {
  resetRuntime()
  let sessionOptions = null
  activeApp.ensureSession = async (options) => {
    sessionOptions = options
    const session = {
      profile: { playerId: 'player-admin' },
      policies: {},
      capabilities: { adminVenueReview: true, adminCoachReview: true }
    }
    activeApp.globalData.session = session
    return session
  }
  installApi({
    profile: { get: async () => profileFixture() },
    favorites: { list: async () => ({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false }) }
  })
  const profile = loadPage('pages/profile/profile.js')
  await profile.loadProfile()
  assert.deepStrictEqual(sessionOptions, { refresh: true })
  assert.strictEqual(profile.data.isAdmin, true)
  assert.strictEqual(profile.data.canReviewCoaches, true)
})

test('客户端不再展示或请求个人视频', async () => {
  resetRuntime()
  installApi({})
  const profile = loadPage('pages/profile/profile.js')
  assert.strictEqual(profile.loadVideoItems, undefined)
  assert.strictEqual(profile.previewVideo, undefined)
  assert.strictEqual(profile.removeVideo, undefined)
  assert.strictEqual(profile.data.videoItems, undefined)
  assert.strictEqual(profile.data.videosState, undefined)
  const clientFiles = [
    'pages/profile/profile.wxml',
    'pages/player-detail/player-detail.wxml',
    'pages/match-detail/match-detail.wxml',
    'utils/api.js'
  ]
  clientFiles.forEach((relativePath) => {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')
    assert(!/比赛视频|比赛片段|已有视频|previewHostVideo|previewVideo|videos\s*:/.test(source), `${relativePath} 不应保留个人视频入口`)
  })
})

test('个人资料的收藏与头像接口失败时仍可查看和编辑基础资料', async () => {
  resetRuntime()
  installApi({
    profile: {
      get: async () => profileFixture({ avatarFileId: 'cloud://avatar/me.jpg' }),
      avatarStatus: async () => { throw new Error('avatar unavailable') }
    },
    favorites: { list: async () => { throw new Error('favorites unavailable') } },
    files: { resolve: async () => { throw new Error('files unavailable') } }
  })
  const profile = loadPage('pages/profile/profile.js')
  await profile.loadProfile()
  assert.strictEqual(profile.data.state, 'ready')
  assert.strictEqual(profile.data.profile.avatarUrl, '')
  assert.deepStrictEqual(profile.data.savedVenues, [])
  assert.strictEqual(profile.data.venuesState, 'error')
  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'profile', 'profile.wxml'), 'utf8')
  assert(template.includes("venuesState === 'error' && !savedVenues.length"), '球馆未同步时不应把默认值 0 当成真实计数')
  assert(template.includes("venuesState === 'ready' && !savedVenues.length"), '只有真实空结果才显示未标记球馆空状态')
  assert(!template.includes('<view class="section-subtitle">{{savedVenuesTotal}} 家已标记</view>'), '球馆计数必须受加载状态保护')
  profile.openEdit()
  assert.strictEqual(profile.data.editVisible, true)
})

test('常去球馆瞬时失败会自动恢复，手动重试只刷新球馆模块', async () => {
  resetRuntime()
  let favoriteReads = 0
  let profileReads = 0
  installApi({
    profile: {
      get: async () => { profileReads += 1; return profileFixture() },
      avatarStatus: async () => ({ avatar: null })
    },
    favorites: {
      list: async () => {
        favoriteReads += 1
        if (favoriteReads === 1) throw Object.assign(new Error('temporary network error'), { code: 'NETWORK_ERROR' })
        return { items: [venueFixture('venue-auto-recovered')], total: 1, page: 1, hasMore: false }
      }
    }
  })
  const profile = loadPage('pages/profile/profile.js')
  await profile.loadProfile()
  assert.strictEqual(favoriteReads, 2)
  assert.strictEqual(profile.data.venuesState, 'ready')
  assert.strictEqual(profile.data.savedVenues[0].id, 'venue-auto-recovered')

  profile.setData({ venuesState: 'error' })
  await profile.retrySavedVenues()
  assert.strictEqual(profileReads, 1, '模块重试不应重新加载个人资料')
  assert.strictEqual(favoriteReads, 3)
  assert.strictEqual(profile.data.venuesState, 'ready')
  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'profile', 'profile.wxml'), 'utf8')
  assert(template.includes('bindtap="retrySavedVenues"'))
})

test('较早的常去球馆响应不能覆盖较新的标记列表', async () => {
  resetRuntime()
  const older = deferred()
  let favoriteReads = 0
  installApi({
    favorites: {
      list: async () => {
        favoriteReads += 1
        if (favoriteReads === 1) return older.promise
        return { items: [venueFixture('venue-newer')], total: 1, page: 1, hasMore: false }
      }
    }
  })
  const profile = loadPage('pages/profile/profile.js')
  const oldLoad = profile.loadSavedVenues()
  await nextEventLoopTurn()
  await profile.loadSavedVenues()
  older.resolve({ items: [venueFixture('venue-older')], total: 1, page: 1, hasMore: false })
  await oldLoad
  assert.deepStrictEqual(profile.data.savedVenues.map(item => item.id), ['venue-newer'])
})

test('我的页面刷新失败会恢复教练认证状态，不停在加载中', async () => {
  resetRuntime()
  let reads = 0
  installApi({
    profile: {
      get: async () => {
        reads += 1
        if (reads > 1) throw Object.assign(new Error('资料刷新失败'), { code: 'SERVICE_UNAVAILABLE' })
        return profileFixture()
      },
      avatarStatus: async () => ({ avatar: null })
    },
    favorites: { list: async () => ({ items: [], total: 0, page: 1, hasMore: false }) },
    coachApplications: { get: async () => ({ status: 'not_submitted' }) }
  })
  const profile = loadPage('pages/profile/profile.js')
  await profile.loadProfile()
  assert.strictEqual(profile.data.coachApplicationState, 'ready')
  await profile.loadProfile()
  assert.strictEqual(profile.data.state, 'ready')
  assert.strictEqual(profile.data.coachApplicationState, 'ready')
})

test('我的页面可分页展示超过 50 家标记球馆并移除下架占位项', async () => {
  resetRuntime()
  const tombstone = {
    id: 'venue-delisted',
    name: '已下架球馆',
    city: '',
    district: '',
    address: '',
    unavailable: true
  }
  let favorites = [tombstone].concat(Array.from({ length: 54 }, (_, index) => (
    venueFixture(`venue-saved-${String(index + 1).padStart(2, '0')}`)
  )))
  const setPayloads = []
  installApi({
    favorites: {
      list: async ({ page, pageSize }) => {
        const start = (page - 1) * pageSize
        return {
          items: favorites.slice(start, start + pageSize),
          page,
          pageSize,
          total: favorites.length,
          hasMore: start + pageSize < favorites.length
        }
      },
      set: async (payload) => {
        setPayloads.push(clone(payload))
        if (!payload.marked) favorites = favorites.filter((item) => item.id !== payload.venueId)
      }
    }
  })
  const profile = loadPage('pages/profile/profile.js')
  await profile.loadProfile()
  assert.strictEqual(profile.data.savedVenues.length, 20)
  assert.strictEqual(profile.data.savedVenuesTotal, 55)
  assert.strictEqual(profile.data.savedVenuesHasMore, true)
  assert.strictEqual(profile.data.savedVenues[0].unavailable, true)

  await profile.loadMoreVenues()
  await profile.loadMoreVenues()
  assert.strictEqual(profile.data.savedVenues.length, 55)
  assert.strictEqual(profile.data.savedVenuesTotal, 55)
  assert.strictEqual(profile.data.savedVenuesHasMore, false)

  profile.manageVenue({ currentTarget: { dataset: { id: tombstone.id } } })
  await nextEventLoopTurn()
  assert.deepStrictEqual(setPayloads, [{ venueId: tombstone.id, marked: false }])
  assert.strictEqual(profile.data.savedVenues.some((item) => item.id === tombstone.id), false)
  assert.strictEqual(profile.data.savedVenuesTotal, 54)
  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'profile', 'profile.wxml'), 'utf8')
  assert(template.includes('loadMoreVenues'))
  assert(template.includes('manageVenue'))
  assert(!template.includes('bindtap="unmarkVenue"'), '取消标记不应作为列表行上的直接操作')
  assert(template.includes('savedVenuesTotal'))
})

test('个人资料按 files.resolve 契约显示头像并提交球龄、技术和第三方积分', async () => {
  resetRuntime()
  const updates = []
  let authorizeCount = 0
  const rawProfile = profileFixture({ avatarFileId: 'cloud://avatar/me.jpg' })
  installPrivacy(async () => { authorizeCount += 1 })
  installApi({
    profile: {
      get: async () => clone(rawProfile),
      update: async (payload) => { updates.push(clone(payload)); return payload },
      avatarStatus: async () => ({ avatar: { status: 'passed' } })
    },
    favorites: { list: async () => ({ items: [venueFixture()] }) },
    files: {
      resolve: async () => ({
        urls: {
          'cloud://avatar/me.jpg': 'https://temp.example/avatar.jpg'
        },
        unresolved: []
      })
    }
  })
  const profile = loadPage('pages/profile/profile.js')
  await profile.loadProfile()
  assert.strictEqual(profile.data.profile.avatarUrl, 'https://temp.example/avatar.jpg')
  assert.strictEqual(profile.data.savedVenues[0].id, 'venue_huanglong')

  profile.openEdit()
  assert.strictEqual(profile.data.editDirty, false)
  await profile.saveProfile()
  assert.strictEqual(authorizeCount, 0)
  assert.strictEqual(updates.length, 0)
  profile.changeNickname({ detail: { value: '林小拍' } })
  profile.changeEditBallAge({ detail: { value: '4' } })
  profile.changeRatingPlatform({ detail: { value: '1' } })
  profile.changeRatingValue({ detail: { value: '1825' } })
  profile.changeNewSkill({ detail: { value: '反手拧拉' } })
  profile.addSkill()
  await profile.saveProfile()
  assert.strictEqual(authorizeCount, 1)
  assert.strictEqual(updates.length, 1)
  assert.deepStrictEqual(updates[0], {
    nickname: '林小拍',
    city: '杭州',
    district: '西湖区',
    ballAge: '球龄 5—10 年',
    skills: ['正手弧圈', '反手拧拉'],
    ratingPlatform: '开球网',
    ratingValue: '1825'
  })
  assert.strictEqual(profile.data.editVisible, false)
  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'profile', 'profile.wxml'), 'utf8')
  assert(template.includes("disabled=\"{{saving || !editDirty}}\""), '资料未修改时不应允许重复保存')
  assert(template.includes('仅作约球参考，不影响加入球局'))
})

test('微信 chooseAvatar 事件保留临时路径且仅修改头像时不重复提交资料', async () => {
  resetRuntime()
  const avatarUploads = []
  const profileUpdates = []
  let authorizeCount = 0
  installPrivacy(async () => { authorizeCount += 1 })
  installApi({
    profile: {
      get: async () => profileFixture(),
      update: async (payload) => { profileUpdates.push(clone(payload)); return payload },
      uploadAvatar: async (path, options) => {
        avatarUploads.push({ path, requestId: options.requestId })
        options.onProgress({ progress: 64 })
        return { avatar: { status: 'reviewing' } }
      },
      avatarStatus: async () => ({ avatar: null })
    }
  })
  const profile = loadPage('pages/profile/profile.js')
  await profile.loadProfile()
  profile.openEdit()
  profile.chooseAvatar({ detail: {} })
  assert.strictEqual(profile.data.editDirty, false, '取消选择头像不应制造未保存修改')
  const temporaryPath = 'wxfile://tmp/choose-avatar-without-extension'
  profile.chooseAvatar({ detail: { avatarUrl: temporaryPath } })
  assert.strictEqual(profile.pendingAvatarPath, temporaryPath)
  assert.strictEqual(profile.data.editProfile.avatarPreviewUrl, temporaryPath)
  assert.strictEqual(profile.data.avatarDirty, true)

  await profile.saveProfile()
  assert.strictEqual(authorizeCount, 1)
  assert.strictEqual(avatarUploads.length, 1)
  assert.strictEqual(avatarUploads[0].path, temporaryPath)
  assert(/^req_client_\d+$/.test(avatarUploads[0].requestId))
  assert.strictEqual(profileUpdates.length, 0, '只换头像时不应重写未修改的文字资料')
  assert.strictEqual(profile.pendingAvatarPath, '')
  assert.strictEqual(profile.data.uploadProgress, 0)
  assert.strictEqual(profile.data.editVisible, false)
})

test('我的头像可直接选择，且只改头像不会被旧资料校验或整表保存阻断', async () => {
  resetRuntime()
  const uploads = []
  let updateCount = 0
  let authorizeCount = 0
  const rawProfile = profileFixture({ ratingPlatform: '开球网', ratingValue: '' })
  installPrivacy(async () => { authorizeCount += 1 })
  installApi({
    profile: {
      get: async () => clone(rawProfile),
      update: async () => { updateCount += 1 },
      uploadAvatar: async (path, options) => {
        uploads.push({ path, requestId: options.requestId })
        return { avatar: { status: 'reviewing' } }
      },
      avatarStatus: async () => ({ avatar: { status: uploads.length ? 'reviewing' : 'passed' } })
    }
  })
  const page = loadPage('pages/profile/profile.js')
  await page.loadProfile()

  page.chooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/new-avatar.jpg' } })
  assert.strictEqual(page.data.editVisible, true)
  assert.strictEqual(page.data.avatarDirty, true)
  assert.strictEqual(page.data.profileDirty, false)
  assert.strictEqual(page.data.editProfile.avatarPreviewUrl, 'wxfile://tmp/new-avatar.jpg')

  await page.saveProfile()
  assert.strictEqual(authorizeCount, 1)
  assert.strictEqual(uploads.length, 1)
  assert.strictEqual(uploads[0].path, 'wxfile://tmp/new-avatar.jpg')
  assert(uploads[0].requestId)
  assert.strictEqual(updateCount, 0)
  assert.strictEqual(page.data.editVisible, false)

  const template = fs.readFileSync(path.join(projectRoot, 'pages', 'profile', 'profile.wxml'), 'utf8')
  assert(/avatar-edit-trigger[\s\S]*open-type="chooseAvatar"[\s\S]*bindchooseavatar="chooseAvatar"/.test(template))
  assert(template.includes('保存新头像'))
})

test('标记球馆刷新失败时保留已展示内容', async () => {
  resetRuntime()
  let failOptionalRequests = false
  installApi({
    profile: {
      get: async () => profileFixture({ ratingPlatform: undefined }),
      avatarStatus: async () => ({ avatar: null })
    },
    favorites: {
      list: async () => {
        if (failOptionalRequests) throw new Error('favorites unavailable')
        return { items: [venueFixture()] }
      }
    }
  })
  const profile = loadPage('pages/profile/profile.js')
  await profile.loadProfile()
  assert.strictEqual(profile.data.profile.ratingPlatform, '未填写')
  assert.strictEqual(profile.data.savedVenues.length, 1)

  failOptionalRequests = true
  await profile.loadProfile()
  assert.strictEqual(profile.data.savedVenues.length, 1)
  assert.strictEqual(profile.data.venuesState, 'error')
})

test('球友资料只展示约球相关信息', async () => {
  resetRuntime()
  installApi({
    players: {
      get: async () => ({
        player: {
          playerId: 'player-friend',
          displayName: '林球友',
          avatarFileId: 'cloud://avatar/friend.jpg',
          city: '杭州',
          district: '西湖区',
          ballAge: '球龄 2—5 年',
          skills: ['反手拧拉'],
          ratingPlatform: '开球网',
          ratingValue: '1750'
        },
        videos: [{ id: 'legacy-player-media', url: 'https://temp.example/legacy.mp4' }],
        isSelf: false
      })
    },
    files: { resolve: async () => ({ urls: { 'cloud://avatar/friend.jpg': 'https://temp.example/friend.jpg' }, unresolved: [] }) }
  })
  const page = loadPage('pages/player-detail/player-detail.js')
  page.onLoad({ id: 'player-friend' })
  await page.loadPlayer()
  assert.strictEqual(page.data.state, 'ready')
  assert.strictEqual(page.data.player.avatarUrl, 'https://temp.example/friend.jpg')
  assert.strictEqual(page.data.player.ballAgeText, '2—5 年')
  assert.strictEqual(page.data.player.ratingText, '开球网 1750')
  assert.deepStrictEqual(page.data.player.skills, ['反手拧拉'])
  assert.strictEqual(page.data.videos, undefined)
  assert.strictEqual(page.data.isSelf, false)
})

test('球友资料不等待头像链接即可先展示', async () => {
  resetRuntime()
  const avatar = deferred()
  installApi({
    players: {
      get: async () => ({
        player: {
          playerId: 'player-fast',
          displayName: '先看资料的球友',
          avatarFileId: 'cloud://avatar/slow.jpg',
          city: '杭州',
          ballAge: '球龄 1—2 年',
          skills: []
        },
        isSelf: false
      })
    },
    files: { resolve: () => avatar.promise }
  })
  const page = loadPage('pages/player-detail/player-detail.js')
  page.onLoad({ id: 'player-fast' })
  await page.loadPlayer()
  assert.strictEqual(page.data.state, 'ready')
  assert.strictEqual(page.data.player.displayName, '先看资料的球友')
  assert.strictEqual(page.data.player.avatarUrl, '')

  avatar.resolve({ urls: { 'cloud://avatar/slow.jpg': 'https://temp.example/slow.jpg' }, unresolved: [] })
  await nextEventLoopTurn()
  assert.strictEqual(page.data.player.avatarUrl, 'https://temp.example/slow.jpg')
})

test('球友资料缺少 ID 时不会停留在加载骨架', async () => {
  resetRuntime()
  installApi()
  const page = loadPage('pages/player-detail/player-detail.js')
  page.onLoad({})
  await page.loadPlayer()
  assert.strictEqual(page.data.state, 'error')
  assert.strictEqual(page.data.notFound, true)
  assert(page.data.errorMessage.includes('球友编号'))
})

test('名称型球馆在详情、球局与我的页面均只展示有效信息', async () => {
  resetRuntime()
  const venue = nameOnlyVenueFixture('venue_xiaochao')
  installApi({ venues: { get: async () => venue } })
  const venueDetail = loadPage('pages/venue-detail/venue-detail.js')
  venueDetail.onLoad({ id: venue.id })
  await venueDetail.loadVenue()
  assert.strictEqual(venueDetail.data.venue.nameOnly, true)
  assert.strictEqual(venueDetail.data.venue.district, '')
  assert.strictEqual(venueDetail.data.venue.locationText, '')
  assert.strictEqual(venueDetail.data.venue.location, null)
  assert.strictEqual(venueDetail.data.venue.hasLocation, false)
  assert.deepStrictEqual(venueDetail.data.venue.activityTags, ['教学', '比赛', '训练', '切磋'])

  const venueTemplate = fs.readFileSync(path.join(projectRoot, 'pages', 'venue-detail', 'venue-detail.wxml'), 'utf8')
  assert(venueTemplate.includes('venue.activityTags'))
  assert(venueTemplate.includes('wx:if="{{venue.locationText || venue.hasLocation}}"'))
  assert(!venueTemplate.includes('disabled="{{!venue.hasLocation}}"'))
  venueDetail.openMap()
  assert.strictEqual(notices[notices.length - 1].options.title, '暂无地图位置，请在球局中确认')

  installApi({
    venues: { get: async () => venue },
    matches: {
      get: async () => ({
        match: matchFixture({
          id: 'match-name-only-detail',
          venueId: venue.id,
          venue: { id: venue.id, name: venue.name, address: '旧地址不应继续显示' }
        }),
        membership: null,
        confirmedCount: 1
      })
    }
  })
  const matchDetail = loadPage('pages/match-detail/match-detail.js')
  matchDetail.onLoad({ id: 'match-name-only-detail' })
  await matchDetail.loadMatch()
  assert.strictEqual(matchDetail.data.match.address, '')
  assert.strictEqual(matchDetail.data.match.venueLocationText, '')
  assert.strictEqual(matchDetail.data.match.hasLocation, false)
  assert.deepStrictEqual(matchDetail.data.match.venueActivityTags, ['教学', '比赛', '训练', '切磋'])
  matchDetail.openMap()
  assert.strictEqual(memory.clipboard, undefined)
  assert.strictEqual(notices[notices.length - 1].options.title, '暂无地图位置，请加入后确认')

  const matchTemplate = fs.readFileSync(path.join(projectRoot, 'pages', 'match-detail', 'match-detail.wxml'), 'utf8')
  assert(matchTemplate.includes('match.venueActivityTags'))
  assert(matchTemplate.includes('wx:if="{{match.venueLocationText || match.hasLocation}}"'))
  assert(!matchTemplate.includes('disabled="{{!match.hasLocation}}"'))

  installApi({
    venues: { get: async () => venue },
    matches: {
      get: async () => ({
        match: matchFixture({
          id: 'match-name-only-chat',
          venueId: venue.id,
          venue: { id: venue.id, name: venue.name, address: '旧地址不应继续显示' }
        }),
        membership: { status: 'joined', canChat: true, confirmedScheduleVersion: 1 },
        confirmedCount: 2
      })
    }
  })
  const chat = loadPage('pages/chat/chat.js')
  chat.onLoad({ id: 'match-name-only-chat' })
  await chat.loadChat()
  assert.strictEqual(chat.data.match.address, '')
  assert.strictEqual(chat.data.match.venueLocationText, '')
  assert.strictEqual(chat.data.match.hasLocation, false)
  chat.openMap()
  assert.strictEqual(memory.clipboard, undefined)
  assert.strictEqual(notices[notices.length - 1].options.title, '具体位置请在对话中确认')
  const chatTemplate = fs.readFileSync(path.join(projectRoot, 'pages', 'chat', 'chat.wxml'), 'utf8')
  assert(chatTemplate.includes('wx:if="{{match.venueLocationText || match.address || match.hasLocation}}"'))

  installApi({ favorites: { list: async () => ({ items: [venue], page: 1, total: 1, hasMore: false }) } })
  const profile = loadPage('pages/profile/profile.js')
  await profile.loadSavedVenues()
  assert.strictEqual(profile.data.savedVenues[0].name, '萧潮乒乓球馆')
  assert.deepStrictEqual(profile.data.savedVenues[0].activityTags, ['教学', '比赛', '训练', '切磋'])
  assert.strictEqual(profile.data.savedVenues[0].locationText, '')

  const profileTemplate = fs.readFileSync(path.join(projectRoot, 'pages', 'profile', 'profile.wxml'), 'utf8')
  assert(profileTemplate.includes('item.activityTags'))
  assert(profileTemplate.includes('item.locationText'))
})

async function run() {
  let passed = 0
  for (const item of tests) {
    try {
      await item.callback()
      passed += 1
      process.stdout.write(`PASS ${item.name}\n`)
    } catch (error) {
      process.stderr.write(`FAIL ${item.name}\n${error.stack || error}\n`)
      process.exitCode = 1
      return
    }
  }
  process.stdout.write(`\n${passed} release smoke tests passed\n`)
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
