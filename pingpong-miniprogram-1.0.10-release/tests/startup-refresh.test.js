const assert = require('assert')
const fs = require('fs')
const path = require('path')
const cloud = require('../utils/cloud')
const tests = []
const test = (name, run) => tests.push({ name, run })
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function failure(code) { return Object.assign(new Error(code), { code }) }
function setup() {
  let definition, listener
  const stats = { stops: 0, reads: 0, fresh: 0, sessionResets: 0, sessionRestores: 0, unsubscribed: 0 }
  const app = {
    ensureSession: async () => ({}),
    clearSession: () => { stats.sessionResets++ },
    restoreSessionAfterPrimary: () => { stats.sessionRestores++; return true }
  }
  global.getApp = () => app
  global.wx = {
    getStorageSync() {}, setStorageSync() {}, showShareMenu() {}, hideShareMenu() {}, showToast() {},
    stopPullDownRefresh() { stats.stops++ },
    onNetworkStatusChange(callback) { listener = callback },
    offNetworkStatusChange(callback) { assert.equal(callback, listener); listener = null; stats.unsubscribed++ }
  }
  const api = {
    invalidateReads() { stats.fresh++ },
    venues: { list: async () => ({ items: [] }) },
    favorites: { status: async () => ({ markedIds: [] }) },
    matches: { list: async () => { stats.reads++; return { items: [{ id: `match_${stats.reads}`, title: '练球' }] } } },
    coaches: { list: async () => ({ items: [] }) },
    files: { resolve: async () => ({ urls: {} }) }
  }
  const apiPath = require.resolve('../utils/api')
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: api }
  const filename = require.resolve('../pages/home/home')
  delete require.cache[filename]
  global.Page = value => { definition = value }
  require(filename)
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  page.setData = function(patch, callback) { Object.assign(this.data, patch); if (callback) callback() }
  page.onLoad()
  return { page, api, app, stats, network: connected => listener && listener({ isConnected: connected }) }
}

test('首页原生下拉配置保留，页面没有用纵向滚动容器抢占手势', () => {
  const root = path.resolve(__dirname, '..')
  const config = require('../pages/home/home.json')
  const template = fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8')
  assert.equal(config.enablePullDownRefresh, true)
  assert(!template.includes('scroll-y="true"'))
  assert(template.includes('bindtap="refreshHome"'))
  assert(template.includes('refreshNotice'))
  assert(template.includes('loadingSlow'))
})

test('连续三次下拉各自发起新查询并结束动画，保留当前筛选', async () => {
  const { page, api, stats } = setup()
  const query = []
  api.matches.list = async data => { query.push(data); return { items: [] } }
  page.setData({ districtIndex: 6, selectedDate: '', ballAgeIndex: 1 })
  for (let index = 1; index <= 3; index++) {
    assert.equal(await page.onPullDownRefresh(), true)
    assert.equal(stats.stops, index)
    assert.equal(stats.fresh, index)
    assert.equal(page.data.manualRefreshing, false)
    assert.equal(page.data.refreshNotice, '球局已更新')
    await turn()
  }
  assert.equal(query.length, 3)
  assert(query.every(item => item.district === '萧山区' && !item.date && item.expectedBallAge === '新手友好'))
  page.onUnload()
})

test('同轮连续下拉合并，主列表返回后立即收起动画，不等球馆和图片', async () => {
  const { page, api, stats } = setup()
  const matches = deferred(), venues = deferred(), files = deferred()
  api.matches.list = () => { stats.reads++; return matches.promise }
  api.venues.list = () => venues.promise
  api.files.resolve = () => files.promise
  const first = page.onPullDownRefresh(), second = page.onPullDownRefresh()
  assert.equal(first, second)
  await turn()
  assert.equal(stats.reads, 1)
  matches.resolve({ items: [{ id: 'new', title: '球局' }] })
  assert.equal(await first, true)
  assert.equal(stats.stops, 1)
  assert.equal(page.data.venuesLoading, true)
  assert.equal(page.data.matches[0].id, 'new')
  venues.resolve({ items: [{ id: 'v', name: '球馆', coverFileIds: ['cloud://photo'] }] })
  await turn()
  assert.equal(stats.stops, 1)
  files.resolve({ urls: {} })
  await turn()
  page.onUnload()
})

test('主动刷新脱离开屏旧查询，迟到结果不能覆盖新球局', async () => {
  const { page, api, stats } = setup()
  const old = deferred()
  api.matches.list = () => ++stats.reads === 1 ? old.promise : Promise.resolve({ items: [{ id: 'latest' }] })
  const startup = page.onShow()
  await turn()
  await page.onPullDownRefresh()
  assert.equal(stats.fresh, 1)
  old.resolve({ items: [{ id: 'old' }] })
  await startup
  assert.equal(page.data.matches[0].id, 'latest')
  assert.equal(stats.stops, 1)
  page.onUnload()
})

test('刷新失败明确显示旧数据提示，重试成功消除提示；真实空结果正常显示', async () => {
  const { page, api, stats } = setup()
  await page.onShow()
  const oldId = page.data.matches[0].id
  api.matches.list = async () => { throw failure('NETWORK_ERROR') }
  assert.equal(await page.onPullDownRefresh(), false)
  assert.equal(page.data.state, 'ready')
  assert.equal(page.data.matches[0].id, oldId)
  assert(page.data.refreshError.includes('上次结果'))
  assert.equal(stats.stops, 1)
  api.matches.list = async () => ({ items: [] })
  await page.retry()
  assert.equal(page.data.refreshError, '')
  assert.equal(page.data.state, 'ready')
  assert.deepEqual(page.data.matches, [])
  page.onUnload()
})

test('开屏断网不会显示假空列表，网络恢复后自动查询一次', async () => {
  const { page, api, stats, network } = setup()
  api.matches.list = async () => { throw failure('NETWORK_ERROR') }
  network(false)
  await page.onShow()
  assert.equal(page.data.state, 'error')
  assert.equal(page.data.primaryLoading, false)
  api.matches.list = async () => { stats.reads++; return { items: [{ id: 'online' }] } }
  await network(true)
  await network(true)
  assert.equal(stats.reads, 1)
  assert.equal(page.data.matches[0].id, 'online')
  assert.equal(page.data.state, 'ready')
  page.onUnload()
  assert.equal(stats.unsubscribed, 1)
})

test('网络在旧请求失败前恢复也能自动补载，退出页面不再自动请求', async () => {
  const { page, api, stats, network } = setup()
  const old = deferred()
  api.matches.list = () => ++stats.reads === 1 ? old.promise : Promise.resolve({ items: [] })
  const loading = page.onShow()
  await turn()
  network(false); network(true)
  old.reject(failure('REQUEST_TIMEOUT'))
  await loading
  assert.equal(stats.reads, 2)
  page.retryOnReconnect = true
  page.onHide()
  network(false); network(true)
  assert.equal(stats.reads, 2)
  page.onUnload()
})

test('配置和授权错误不自动重试，失效会话会清理且不继续展示可操作旧列表', async () => {
  for (const code of ['CLOUD_ENV_NOT_CONFIGURED', 'CONSENT_REQUIRED', 'BOOTSTRAP_REQUIRED', 'ACCOUNT_SUSPENDED']) {
    const { page, api, stats, network } = setup()
    await page.onShow()
    let calls = 0
    api.matches.list = async () => { calls++; throw failure(code) }
    await page.onPullDownRefresh()
    if (code !== 'CLOUD_ENV_NOT_CONFIGURED') assert.equal(page.data.state, 'error')
    network(false); network(true)
    assert.equal(calls, 1)
    assert.equal(stats.sessionResets, ['CONSENT_REQUIRED', 'BOOTSTRAP_REQUIRED'].includes(code) ? 1 : 0)
    assert.equal(page.data.manualRefreshing, false)
    page.onUnload()
  }
})

test('游客开屏直接进入列表加载阶段，主列表返回即停止慢加载提示', async () => {
  const nativeSetTimeout = global.setTimeout, nativeClearTimeout = global.clearTimeout
  let slowCallback
  try {
    global.setTimeout = callback => { slowCallback = callback; return 1 }
    global.clearTimeout = () => {}
    const { page, app, api, stats } = setup()
    const matches = deferred()
    let passiveSessionChecks = 0
    app.ensureSession = () => { passiveSessionChecks++; return Promise.resolve({}) }
    api.matches.list = () => matches.promise
    const work = page.onShow()
    assert.equal(page.data.loadingStage, 'list')
    assert.equal(passiveSessionChecks, 0)
    slowCallback()
    assert.equal(page.data.loadingSlow, true)
    matches.resolve({ items: [] })
    await work
    assert.equal(page.data.loadingSlow, false)
    assert.equal(page.data.primaryLoading, false)
    assert.equal(stats.sessionRestores, 1)
    page.onUnload()
  } finally {
    global.setTimeout = nativeSetTimeout
    global.clearTimeout = nativeClearTimeout
  }
})

test('卸载取消当前下拉，离页后的旧请求不再更新页面', async () => {
  const { page, api, stats } = setup()
  const old = deferred()
  api.matches.list = () => old.promise
  const first = page.onPullDownRefresh()
  await turn()
  page.onUnload()
  assert.equal(await first, false)
  assert.equal(stats.stops, 1)
  old.resolve({ items: [{ id: 'late' }], hasMore: false })
  await turn()
  assert.deepEqual(page.data.matches, [])
})

test('首次登录遇到服务繁忙最多重试一次且复用编号，不自动重放约球写入', async () => {
  const calls = []
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    cloud: { init() {}, callFunction: async ({ data }) => {
      calls.push(data)
      return calls.length === 1 ? { result: { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '繁忙' } } }
        : { result: { ok: true, data: { profile: {} } } }
    } }
  }
  await cloud.call('bootstrap', { consentAccepted: true })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].requestId, calls[1].requestId)
  for (const action of ['matches.create', 'matches.join', 'coachBookings.create']) {
    let count = 0
    wx.cloud.callFunction = async () => { count++; return { result: { ok: false, error: { code: 'SERVICE_UNAVAILABLE' } } } }
    await assert.rejects(cloud.call(action), error => error.code === 'SERVICE_UNAVAILABLE')
    assert.equal(count, 1)
  }
  let deniedCalls = 0
  wx.cloud.callFunction = async () => { deniedCalls++; return { result: { ok: false, error: { code: 'CONSENT_REQUIRED' } } } }
  await assert.rejects(cloud.call('bootstrap'), error => error.code === 'CONSENT_REQUIRED')
  assert.equal(deniedCalls, 1)
})

;(async () => {
  for (const item of tests) { await item.run(); console.log(`PASS ${item.name}`) }
  console.log(`${tests.length} startup and refresh checks passed`)
})().catch(error => { console.error(error); process.exitCode = 1 })
