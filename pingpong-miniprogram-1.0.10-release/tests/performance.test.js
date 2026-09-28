const assert = require('assert')
const path = require('path')
const cloud = require('../utils/cloud')
const diagnostics = require('../utils/diagnostics')
const policy = require('../utils/request-policy')
const tests = [], test = (name, run) => tests.push({ name, run })
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const ok = data => ({ result: { ok: true, data } })
global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
  getStorageSync() {}, setStorageSync() {}, removeStorageSync() {}, showToast() {},
  showShareMenu() {}, hideShareMenu() {}, stopPullDownRefresh() {},
  cloud: { init() {}, callFunction: async () => ok({}) }
}

test('头像审核状态使用短超时的只读策略，不干扰首页和资料的并发加载', () => {
  assert.equal(policy.isRead('profile.avatar.status'), true)
  assert.equal(policy.canRetry('profile.avatar.status'), true)
  assert.equal(policy.timeoutMs('profile.avatar.status', {}), 8000)
  assert.equal(policy.isRead('profile.avatar.retry'), false)
})
test('相同并发读合并为一次云调用，结果相互隔离且完成后不缓存', async () => {
  cloud.invalidateReads(); const waiting = deferred(); let calls = 0
  wx.cloud.callFunction = async () => { calls++; return waiting.promise }
  const a = cloud.call('venues.list', { city: '杭州', page: 1 })
  const b = cloud.call('venues.list', { page: 1, city: '杭州' })
  await turn(); assert.equal(calls, 1)
  waiting.resolve(ok({ items: [{ name: '球馆' }] }))
  const [first, second] = await Promise.all([a, b])
  first.items[0].name = '本地修改'
  assert.equal(second.items[0].name, '球馆')
  await cloud.call('venues.list', { city: '杭州', page: 1 })
  assert.equal(calls, 2)
})
test('写入前后及会话重置均隔离在途读，不复用写入前结果', async () => {
  cloud.invalidateReads(); const reads = [], mutation = deferred()
  wx.cloud.callFunction = ({ data }) => {
    if (data.action === 'favorites.set') return mutation.promise
    const response = deferred(); reads.push(response); return response.promise
  }
  const before = cloud.call('favorites.status', { venueIds: ['v'] })
  const writing = cloud.call('favorites.set', { venueId: 'v', marked: true })
  const during = cloud.call('favorites.status', { venueIds: ['v'] })
  await turn(); assert.equal(reads.length, 2)
  mutation.resolve(ok({ marked: true })); await writing
  const after = cloud.call('favorites.status', { venueIds: ['v'] })
  await turn(); assert.equal(reads.length, 3)
  cloud.invalidateReads()
  const reset = cloud.call('favorites.status', { venueIds: ['v'] })
  await turn(); assert.equal(reads.length, 4)
  reads.forEach((item, index) => item.resolve(ok({ markedIds: index < 2 ? [] : ['v'] })))
  await Promise.all([before, during, after, reset])
})
test('权限撤回后重新读服务端，绝不返回旧缓存', async () => {
  wx.cloud.callFunction = async () => ok({ items: [{ text: 'private' }] })
  await cloud.call('messages.list', { matchId: 'm' })
  wx.cloud.callFunction = async () => ({ result: { ok: false, error: { code: 'FORBIDDEN', message: '已退出' } } })
  await assert.rejects(() => cloud.call('messages.list', { matchId: 'm' }), error => error.code === 'FORBIDDEN')
})
test('读请求超时释放等待且不重试悬挂请求，迟到响应不改变结果', async () => {
  const waiting = deferred(); let calls = 0
  wx.cloud.callFunction = () => { calls++; return waiting.promise }
  const task = cloud.call('venues.get', { venueId: 'v' }, { timeoutMs: 15 })
  await assert.rejects(task, error => error.code === 'REQUEST_TIMEOUT' && error.details.outcomeUnknown === false)
  assert.equal(calls, 1)
  waiting.resolve(ok({ id: 'v' })); await turn()
})
test('写入超时结果标为未知，不自动再次发起约球操作', async () => {
  let calls = 0
  wx.cloud.callFunction = () => { calls++; return new Promise(() => {}) }
  await assert.rejects(() => cloud.call('matches.join', { matchId: 'm' }, { timeoutMs: 15, requestId: 'request_join' }), error => error.code === 'REQUEST_TIMEOUT' && error.details.outcomeUnknown)
  assert.equal(calls, 1)
  wx.cloud.callFunction = async () => { calls++; throw new Error('network down') }
  await assert.rejects(() => cloud.call('future.unknownMutation', {}, { retry: true }))
  assert.equal(calls, 2)
})
test('总等待预算耗尽后不发第二次请求，已知未部署错误不当作断网', async () => {
  let calls = 0
  wx.cloud.callFunction = async () => { calls++; throw new Error('network down') }
  await assert.rejects(() => cloud.call('venues.list', {}, { timeoutMs: 20 }), error => error.code === 'REQUEST_TIMEOUT')
  assert.equal(calls, 1)
  wx.cloud.callFunction = async () => { calls++; throw new Error('FUNCTIONS_EXECUTE_FAIL function not exists') }
  await assert.rejects(() => cloud.call('venues.list'), error => error.code === 'CLOUD_FUNCTION_NOT_DEPLOYED')
  assert.equal(calls, 2)
})
test('请求策略只允许明确读操作去重，写入和显式请求 ID 不合并', async () => {
  assert.equal(policy.isRead('venuePhotos.register'), false)
  assert.equal(policy.isRead('invented.list'), false)
  assert.equal(policy.isRead('friends.list'), true)
  assert.equal(policy.isRead('friendUpdates.list'), false)
  assert.equal(policy.timeoutMs('venues.list', {}), 8000)
  assert.equal(policy.timeoutMs('matches.join', {}), 25000)
  let calls = 0
  wx.cloud.callFunction = async () => { calls++; return ok({}) }
  await Promise.all([cloud.call('venues.get', { venueId: 'v' }, { requestId: 'request_a' }), cloud.call('venues.get', { venueId: 'v' }, { requestId: 'request_b' })])
  await Promise.all([cloud.call('favorites.set', { venueId: 'v', marked: true }), cloud.call('favorites.set', { venueId: 'v', marked: true })])
  assert.equal(calls, 4)
})
test('本地诊断最多 80 条，不存请求内容、文件地址或身份信息', () => {
  diagnostics.clear()
  for (let index = 0; index < 100; index++) diagnostics.record({ action: 'venues.list', durationMs: index, payload: 'PRIVATE', openid: 'SECRET', url: 'https://secret.test' })
  const snapshot = diagnostics.snapshot()
  assert.equal(snapshot.samples.length, 80)
  assert.equal(snapshot.summary[0].count, 80)
  assert.equal(snapshot.summary[0].p95Ms, 95)
  assert(!JSON.stringify(snapshot).includes('PRIVATE'))
  assert(!JSON.stringify(snapshot).includes('SECRET'))
  snapshot.samples[0].durationMs = 9999
  assert.notEqual(diagnostics.snapshot().samples[0].durationMs, 9999)
})

function setup(name, overrides = {}) {
  const venue = { id: 'venue_a', name: '萧潮乒乓球馆', nameOnly: true, coverFileIds: [] }
  const api = {
    init() {}, invalidateReads() {}, diagnostics, bootstrap: async () => ({}),
    venues: { list: async () => ({ items: [venue] }), get: async () => venue },
    matches: { list: async () => ({ items: [{ id: 'm1', venueId: venue.id, venue: { name: venue.name }, title: '练球' }], hasMore: true }) },
    coaches: { list: async () => ({ items: [] }) },
    favorites: { status: async () => ({ markedIds: [] }), set: async () => ({}) },
    venuePhotos: { list: async () => ({ items: [] }) },
    files: { resolve: async () => ({ urls: {} }) }
  }
  for (const [key, value] of Object.entries(overrides)) api[key] = Object.assign(api[key] || {}, value)
  const filename = require.resolve('../utils/api')
  require.cache[filename] = { id: filename, filename, loaded: true, exports: api }
  let definition
  global.Page = value => { definition = value }
  global.getApp = () => ({
    globalData: { session: { profile: { playerId: 'player-performance' } } },
    ensureSession: async () => ({ profile: { playerId: 'player-performance' } })
  })
  const pagePath = path.resolve(__dirname, '../pages', name, `${name}.js`)
  delete require.cache[pagePath]; require(pagePath)
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  page.setData = function(patch, callback) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = this.data
      while (parts.length > 1) { const key = parts.shift(); target = target[key] || (target[key] = {}) }
      target[parts[0]] = value
    }
    if (callback) callback()
  }
  page.onLoad({ id: 'venue_a' })
  return { page, api, venue }
}
test('球馆及标记查询悬挂时，首页球局仍先显示且可操作', async () => {
  const waiting = deferred()
  const { page } = setup('home', { venues: { list: () => waiting.promise } })
  const loading = page.loadContent()
  await turn()
  assert.equal(page.data.state, 'ready'); assert.equal(page.data.matches[0].id, 'm1')
  assert.equal(page.data.venuesLoading, true)
  waiting.resolve({ items: [] }); await loading
})
test('首页翻页不重复请求已加载的球馆、标记和封面', async () => {
  const { page, api } = setup('home'); let venues = 0, favorites = 0
  const list = api.venues.list; api.venues.list = async data => { venues++; return list(data) }
  api.favorites.status = async () => { favorites++; return { markedIds: [] } }
  await page.loadContent(); await page.loadMore()
  assert.equal(venues, 1); assert.equal(favorites, 1)
  assert.equal(page.data.matchesPage, 2)
})
test('首页短时间重进复用球馆目录，但仍刷新用户标记状态', async () => {
  const { page, api } = setup('home'); let venues = 0, favorites = 0
  const list = api.venues.list; api.venues.list = async data => { venues++; return list(data) }
  api.favorites.status = async () => { favorites++; return { markedIds: [] } }
  await page.loadContent(); await page.loadContent()
  assert.equal(venues, 1)
  assert.equal(favorites, 2)
})
test('未取得标记状态时点击只查询，不猜测写入', async () => {
  const waiting = deferred(); let queries = 0, writes = 0
  const { page } = setup('home', { favorites: {
    status: () => ++queries === 1 ? waiting.promise : Promise.resolve({ markedIds: ['venue_a'] }),
    set: async () => { writes++ }
  } })
  const loading = page.loadContent(); await turn()
  assert.equal(page.data.venues[0].favoriteKnown, false)
  await page.toggleVenueFavorite({ currentTarget: { dataset: { id: 'venue_a' } } })
  assert.equal(writes, 0)
  waiting.resolve({ markedIds: [] }); await loading
  assert.equal(page.data.venues[0].favorited, true, '晚返回的旧批量查询不得撤回较新的状态确认')
})
test('球馆首屏不等待列表或图片，教练只在切换标签后读取一次', async () => {
  const matches = deferred(), files = deferred(); let coaches = 0
  const { page } = setup('venue-detail', {
    venues: { get: async () => ({ id: 'venue_a', name: '球馆', coverFileIds: ['cloud://test/cover.jpg'] }) },
    matches: { list: () => matches.promise },
    coaches: { list: async () => { coaches++; return { items: [] } } },
    files: { resolve: () => files.promise }
  })
  const loading = page.loadVenue(); await turn()
  assert.equal(page.data.state, 'ready'); assert.equal(page.data.venue.name, '球馆')
  assert.equal(page.data.matchesLoading, true); assert.equal(page.data.mediaLoading, true)
  assert.equal(coaches, 0)
  await page.switchTab({ currentTarget: { dataset: { value: 'coaches' } } })
  await page.switchTab({ currentTarget: { dataset: { value: 'coaches' } } })
  assert.equal(coaches, 1)
  matches.resolve({ items: [] }); files.resolve({ urls: {} }); await loading
  assert.equal(page.data.mediaFailed, true)
})
test('球馆详情登录返回后完成原来的标记意图，取消登录不会延迟误标记', async () => {
  let writes = 0
  let statusReads = 0
  const { page, api } = setup('venue-detail', {
    favorites: {
      status: async () => { statusReads += 1; return { markedIds: [] } },
      set: async ({ marked }) => { if (marked) writes += 1; return { marked } }
    }
  })
  const app = {
    globalData: { session: null },
    ensureSession: async () => { throw Object.assign(new Error('请先登录'), { code: 'LOGIN_REQUIRED' }) }
  }
  global.getApp = () => app
  await page.loadVenue()
  await page.toggleFavorite()
  assert.equal(writes, 0)

  app.globalData.session = { profile: { playerId: 'player-returning' } }
  await page.onShow()
  assert.equal(statusReads, 1)
  assert.equal(writes, 1)
  assert.equal(page.data.favoriteStatus, 'marked')

  app.globalData.session = null
  page.setData({ loggedIn: false, favoriteStatus: 'unknown', 'venue.favorited': false })
  await page.toggleFavorite()
  await page.onShow()
  app.globalData.session = { profile: { playerId: 'player-later' } }
  await page.onShow()
  assert.equal(writes, 1, '选择先逛逛后，未来登录不能补做旧的标记操作')
})
test('球馆刷新失败保留内容；下架必须关闭，离开页面后丢弃迟到响应', async () => {
  const { page, api } = setup('venue-detail')
  await page.loadVenue()
  api.venues.get = async () => { throw new Error('offline') }
  await page.loadVenue(); assert.equal(page.data.state, 'ready'); assert(page.data.refreshError)
  api.venues.get = async () => { throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' }) }
  await page.loadVenue(); assert.equal(page.data.state, 'error'); assert.equal(page.data.venue, null)
  const waiting = deferred(); api.venues.get = () => waiting.promise
  const load = page.loadVenue(); await turn(); page.onUnload()
  waiting.resolve({ id: 'venue_a', name: '旧响应' }); await load
  assert.equal(page.data.venue, null)
})
test('发布页球馆目录和搜索按需读取，相同关键词不重复联网', async () => {
  let reads = 0
  const { page } = setup('publish', { venues: {
    list: async (payload) => {
      reads += 1
      return {
        items: [{
          id: payload.keyword ? 'venue_search' : 'venue_first',
          name: payload.keyword ? '远洋乒乓球馆' : '首页球馆',
          address: payload.keyword ? '滨江区远洋街 8 号' : '滨江区',
          activityTags: []
        }],
        hasMore: true
      }
    }
  } })
  await page.venueLoading
  assert.equal(reads, 1, '首屏不得根据 hasMore 自动拉完整个目录')
  page.inputVenueSearch({ detail: { value: '远洋' } })
  await page.searchVenues()
  await page.searchVenues()
  assert.equal(reads, 2, '相同关键词只允许一次服务端搜索')
  assert.equal(page.data.filteredVenues[0].id, 'venue_search')
  assert.equal(page.data.venueSearchHasMore, true)

  page.venueSearchCache.get('远洋').cachedAt = 0
  await page.searchVenues()
  assert.equal(reads, 3, '过期缓存必须重新校验，避免继续展示已下架或改名球馆')
  for (let index = 0; index < 9; index += 1) {
    page.inputVenueSearch({ detail: { value: `球馆${index}` } })
    await page.searchVenues()
  }
  assert.equal(page.venueSearchCache.size, 8, '长驻发布页的搜索缓存必须有容量上限')
})
test('退出会话时旧初始化响应不能重新登录，也不清除新会话的等待状态', async () => {
  const { api } = setup('home'); let definition
  const first = deferred(), second = deferred(); let requests = 0
  api.bootstrap = () => ++requests === 1 ? first.promise : second.promise
  global.App = value => { definition = value }
  const appPath = require.resolve('../app'); delete require.cache[appPath]; require(appPath)
  const app = Object.assign({}, definition, { globalData: Object.assign({}, definition.globalData) })
  const old = app.loginWithWechat(true); await turn(); app.clearSession()
  const current = app.loginWithWechat(true); await turn()
  first.resolve({ profile: { playerId: 'player_old', nickname: '旧用户' } })
  await assert.rejects(old)
  assert.equal(app.globalData.session, null); assert(app.globalData.sessionPromise)
  second.resolve({ profile: { playerId: 'player_current', nickname: '当前用户' } }); await current
  assert.equal(app.globalData.session.profile.nickname, '当前用户')
})
;(async () => {
  for (const item of tests) { await item.run(); console.log(`PASS ${item.name}`) }
  console.log(`${tests.length} performance and concurrency checks passed`)
})().catch(error => { console.error(error); process.exitCode = 1 })
