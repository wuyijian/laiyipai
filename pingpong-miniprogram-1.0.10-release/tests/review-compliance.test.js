const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.resolve(__dirname, '..')
const tests = []
const test = (name, run) => tests.push({ name, run })

function failure(code, message = code) {
  return Object.assign(new Error(message), { code })
}

function loadApp() {
  const calls = {
    cloudInit: 0,
    bootstrap: 0,
    privacy: 0,
    chooseAvatar: 0,
    getPhoneNumber: 0,
    navigation: []
  }
  const loginConsent = {
    accepted: () => false,
    remember() {},
    forget() {}
  }
  const api = {
    init: () => { calls.cloudInit += 1 },
    bootstrap: async () => { calls.bootstrap += 1; return { profile: { playerId: 'player' } } },
    invalidateReads() {}
  }
  const privacy = {
    authorize: async () => { calls.privacy += 1 },
    openContract() {}
  }
  let app
  const wx = {
    navigateTo: ({ url }) => calls.navigation.push(url),
    showToast() {},
    chooseAvatar: () => { calls.chooseAvatar += 1 },
    getPhoneNumber: () => { calls.getPhoneNumber += 1 }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
    App: value => { app = value },
    wx,
    Error,
    Promise,
    Object,
    require(name) {
      if (name === './utils/api') return api
      if (name === './utils/privacy') return privacy
      if (name === './utils/login-consent') return loginConsent
      if (name === './utils/message-notifier') return { start() {}, stop() {}, reset() {} }
      throw new Error(`Unexpected module: ${name}`)
    }
  })
  return { app, calls }
}

function mockModule(filename, exports) {
  const resolved = require.resolve(filename)
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports }
}

function instantiate(definition) {
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  page.setData = function setData(patch, callback) {
    Object.keys(patch).forEach((key) => {
      const parts = key.split('.')
      let cursor = this.data
      for (let index = 0; index < parts.length - 1; index += 1) {
        if (!cursor[parts[index]] || typeof cursor[parts[index]] !== 'object') cursor[parts[index]] = {}
        cursor = cursor[parts[index]]
      }
      cursor[parts.at(-1)] = patch[key]
    })
    if (callback) callback()
  }
  return page
}

function guestHome() {
  const stats = {
    sessionChecks: 0,
    privacy: 0,
    chooseAvatar: 0,
    getPhoneNumber: 0,
    loginOpens: 0,
    favoriteReads: 0,
    favoriteWrites: 0,
    favoriteWritePayloads: [],
    favoriteMarkedIds: [],
    matchReads: 0,
    venueReads: 0,
    readModes: [],
    navigation: []
  }
  let networkListener
  const app = {
    globalData: { session: null },
    hasSession: () => false,
    ensureSession: async (options = {}) => {
      stats.sessionChecks += 1
      if (options.interactive === true) app.openLogin()
      throw failure('LOGIN_REQUIRED', '请先登录')
    },
    openLogin: () => {
      stats.loginOpens += 1
      stats.navigation.push('/pages/login/login')
    },
    clearSession() {}
  }
  global.getApp = () => app
  global.wx = {
    getStorageSync() {},
    setStorageSync() {},
    removeStorageSync() {},
    showShareMenu() {},
    hideShareMenu() {},
    showToast() {},
    pageScrollTo() {},
    stopPullDownRefresh() {},
    onNetworkStatusChange(callback) { networkListener = callback },
    offNetworkStatusChange(callback) { if (callback === networkListener) networkListener = null },
    navigateTo({ url }) { stats.navigation.push(url) },
    switchTab({ url }) { stats.navigation.push(url) },
    requirePrivacyAuthorize({ success }) { stats.privacy += 1; if (success) success() },
    chooseAvatar() { stats.chooseAvatar += 1 },
    getPhoneNumber() { stats.getPhoneNumber += 1 }
  }
  const venue = {
    id: 'venue_public',
    name: '萧潮乒乓球馆',
    city: '杭州',
    district: '萧山区',
    address: '',
    listingMode: 'name_only',
    activityTags: ['切磋'],
    coverFileIds: []
  }
  const match = {
    id: 'match_public',
    title: '周末切磋',
    city: '杭州',
    district: '萧山区',
    date: '2099-09-12',
    startTime: '19:00',
    endTime: '20:30',
    capacity: 2,
    participantCount: 1,
    seats: 1,
    status: 'recruiting',
    expectedBallAge: '不限球龄',
    practiceIntent: '切磋球技',
    joinMode: 'direct',
    courtStatus: 'booked',
    feePerPerson: 0,
    venue,
    host: { playerId: 'player_public', displayName: '杭州球友' },
    participants: []
  }
  const api = {
    invalidateReads() {},
    venues: { list: async (_, options = {}) => { stats.venueReads += 1; stats.readModes.push(['venues.list', options.publicRead]); return { items: [venue] } } },
    matches: { list: async (_, options = {}) => { stats.matchReads += 1; stats.readModes.push(['matches.list', options.publicRead]); return { items: [match], hasMore: false } } },
    coaches: { list: async () => ({ items: [], hasMore: false }) },
    favorites: {
      status: async () => { stats.favoriteReads += 1; return { markedIds: stats.favoriteMarkedIds.slice() } },
      set: async (payload) => { stats.favoriteWrites += 1; stats.favoriteWritePayloads.push(payload) }
    },
    files: { resolve: async () => ({ urls: {} }) }
  }
  const privacy = { authorize: async () => { stats.privacy += 1 }, openContract() {} }
  mockModule(path.join(root, 'utils', 'api.js'), api)
  mockModule(path.join(root, 'utils', 'privacy.js'), privacy)
  let definition
  global.Page = value => { definition = value }
  const pagePath = path.join(root, 'pages', 'home', 'home.js')
  delete require.cache[require.resolve(pagePath)]
  require(pagePath)
  const page = instantiate(definition)
  page.onLoad()
  return { app, page, stats }
}

function guestActionRuntime() {
  const stats = { sessionChecks: 0, loginOpens: 0, privacy: 0, navigation: [], toasts: [] }
  const app = {
    globalData: { session: null },
    ensureSession: async (options = {}) => {
      stats.sessionChecks += 1
      assert.equal(options.interactive, true, '敏感操作必须标记为用户主动触发')
      stats.loginOpens += 1
      stats.navigation.push('/pages/login/login')
      throw failure('LOGIN_REQUIRED', '请先登录')
    }
  }
  global.getApp = () => app
  global.wx = {
    showShareMenu() {}, hideShareMenu() {}, stopPullDownRefresh() {}, showToast({ title }) { stats.toasts.push(title) },
    navigateTo({ url }) { stats.navigation.push(url) },
    navigateBack() {}, switchTab({ url }) { stats.navigation.push(url) },
    showActionSheet() {}, showModal() {},
    requirePrivacyAuthorize({ success }) { stats.privacy += 1; if (success) success() }
  }
  return { app, stats }
}

function loadPage(relativePath, api) {
  mockModule(path.join(root, 'utils', 'api.js'), api)
  const filename = path.join(root, relativePath)
  let definition
  global.Page = value => { definition = value }
  delete require.cache[require.resolve(filename)]
  require(filename)
  return instantiate(definition)
}

test('审核首屏固定为可浏览的找球局首页，模板不含头像或手机号授权入口', () => {
  const config = require('../app.json')
  assert.equal(config.pages[0], 'pages/home/home')
  const template = fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8')
  assert(!/open-type\s*=\s*["'](?:chooseAvatar|getPhoneNumber)["']/.test(template))
})
test('冷启动和被动会话检查不申请隐私权限、不取头像手机号、也不导航登录', async () => {
  const { app, calls } = loadApp()
  app.onLaunch()
  assert.deepEqual(calls, {
    cloudInit: 0,
    bootstrap: 0,
    privacy: 0,
    chooseAvatar: 0,
    getPhoneNumber: 0,
    navigation: []
  })
  await assert.rejects(app.ensureSession(), error => error.code === 'LOGIN_REQUIRED')
  assert.equal(calls.navigation.length, 0, '页面生命周期中的被动检查不能把游客带到登录页')
  assert.equal(calls.privacy, 0)
  assert.equal(calls.cloudInit, 0)
  assert.equal(calls.bootstrap, 0)
})

test('公开 API 显式传参才能携带游客读取标记，且不能与同 action 的登录读取合并', async () => {
  const calls = []
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    cloud: {
      init() {},
      callFunction: async ({ data }) => {
        calls.push(JSON.parse(JSON.stringify(data)))
        return { result: { ok: true, data: data.action === 'files.resolve' ? { urls: {} } : { items: [] }, requestId: data.requestId } }
      }
    }
  }
  const cloudPath = path.join(root, 'utils', 'cloud.js')
  const apiPath = path.join(root, 'utils', 'api.js')
  delete require.cache[require.resolve(cloudPath)]
  delete require.cache[require.resolve(apiPath)]
  const api = require(apiPath)
  const publicOptions = { publicRead: true }
  await api.venues.list({}, publicOptions)
  await api.venues.get({ venueId: 'venue_public' }, publicOptions)
  await api.matches.list({}, publicOptions)
  await api.matches.get({ matchId: 'match_public' }, publicOptions)
  await api.coaches.list({}, publicOptions)
  await api.coaches.get({ coachId: 'coach_public' }, publicOptions)
  await api.files.resolve(['cloud://public/file.jpg'], publicOptions)
  const publicActions = calls.map(item => item.action)
  assert.deepEqual(publicActions, [
    'venues.list', 'venues.get', 'matches.list', 'matches.get',
    'coaches.list', 'coaches.get', 'files.resolve'
  ])
  calls.forEach(item => assert.equal(item.publicRead, true, `${item.action} 必须显式请求游客只读模式`))

  calls.length = 0
  const cloud = require(cloudPath)
  await Promise.all([
    cloud.call('matches.get', { matchId: 'match_same' }, { publicRead: true }),
    cloud.call('matches.get', { matchId: 'match_same' }, { publicRead: false })
  ])
  assert.equal(calls.length, 2, '公开详情和带成员状态的详情不能共用同一个在途响应')
  assert.deepEqual(calls.map(item => item.publicRead), [true, false])
})

test('游客首次进入能加载球局与球馆，不触发登录、隐私授权或用户收藏读取', async () => {
  const { page, stats } = guestHome()
  try {
    await page.onShow()
    assert.equal(page.data.state, 'ready')
    assert.equal(page.data.matches.length, 1)
    assert.equal(page.data.matches[0].id, 'match_public')
    assert.equal(page.data.venues.length, 1)
    assert.equal(page.data.venues[0].id, 'venue_public')
    assert.equal(stats.matchReads, 1)
    assert.equal(stats.venueReads, 1)
    assert.deepEqual(stats.readModes, [['venues.list', true], ['matches.list', true]])
    assert.equal(stats.favoriteReads, 0, '游客不能先访问需要用户档案的收藏接口')
    assert.equal(stats.sessionChecks, 0, '公开首页不应通过 ensureSession 读取')
    assert.equal(stats.loginOpens, 0)
    assert.equal(stats.privacy, 0)
    assert.equal(stats.chooseAvatar, 0)
    assert.equal(stats.getPhoneNumber, 0)
    assert(!stats.navigation.includes('/pages/login/login'))
  } finally {
    page.onUnload()
  }
})

test('游客执行标记球馆时先进入交互式登录，登录前不写收藏', async () => {
  const { page, stats } = guestHome()
  try {
    await page.onShow()
    page.setData({ venues: page.data.venues.map(item => Object.assign({}, item, { favoriteKnown: true, favorited: false })) })
    await page.toggleVenueFavorite({ currentTarget: { dataset: { id: 'venue_public' } } })
    assert.equal(stats.loginOpens, 1, '敏感操作应由用户点击后再打开登录')
    assert.equal(stats.favoriteWrites, 0, '登录成功前不得提交用户收藏')
    assert.equal(stats.privacy, 0, '打开登录说明页本身不能立刻触发微信隐私弹窗')
  } finally {
    page.onUnload()
  }
})

test('已记忆登录的用户首次点标记先恢复真实收藏状态，不重复写入 set(true)', async () => {
  const { app, page, stats } = guestHome()
  try {
    await page.onShow()
    stats.favoriteMarkedIds = ['venue_public']
    app.ensureSession = async (options = {}) => {
      stats.sessionChecks += 1
      assert.equal(options.interactive, true)
      app.globalData.session = { profile: { playerId: 'returning_player' } }
      return app.globalData.session
    }
    await page.toggleVenueFavorite({ currentTarget: { dataset: { id: 'venue_public' } } })
    assert.equal(stats.sessionChecks, 1)
    assert.equal(stats.favoriteReads, 1, '恢复账号后必须先读取服务端收藏状态')
    assert.equal(stats.favoriteWrites, 0, '已有收藏不能被误判后再次写入 set(true)')
    assert.equal(page.data.venues[0].favoriteKnown, true)
    assert.equal(page.data.venues[0].favorited, true)
    assert.equal(stats.loginOpens, 0, '已记忆同意的账号可在明确操作时静默恢复会话')
  } finally {
    page.onUnload()
  }
})

test('游客主动标记并完成登录后，确认服务端未标记再自动完成原意图', async () => {
  const { app, page, stats } = guestHome()
  try {
    await page.onShow()
    await page.toggleVenueFavorite({ currentTarget: { dataset: { id: 'venue_public' } } })
    assert.equal(stats.loginOpens, 1)
    assert.equal(stats.favoriteWrites, 0)
    assert.equal(page.pendingFavoriteVenueId, 'venue_public')

    app.globalData.session = { profile: { playerId: 'newly_logged_in_player' } }
    await page.onShow()
    assert(stats.favoriteReads >= 1, '登录返回后必须重新读取服务端收藏状态')
    assert.equal(stats.favoriteWrites, 1)
    assert.deepEqual(stats.favoriteWritePayloads[0], { venueId: 'venue_public', marked: true })
    assert.equal(page.data.venues[0].favorited, true)
    assert.equal(page.pendingFavoriteVenueId, '')
    assert.equal(stats.loginOpens, 1, '返回首页不能再次自动打开登录页')
  } finally {
    page.onUnload()
  }
})

test('游客取消标记登录后清除原意图，之后登录不会误标球馆', async () => {
  const { app, page, stats } = guestHome()
  try {
    await page.onShow()
    await page.toggleVenueFavorite({ currentTarget: { dataset: { id: 'venue_public' } } })
    assert.equal(page.pendingFavoriteVenueId, 'venue_public')

    await page.onShow()
    assert.equal(page.pendingFavoriteVenueId, '')
    app.globalData.session = { profile: { playerId: 'later_login_player' } }
    await page.onShow()
    assert.equal(stats.favoriteWrites, 0, '取消登录留下的旧意图不得在未来执行')
    assert.equal(stats.loginOpens, 1, '页面显示阶段不能自动弹登录')
  } finally {
    page.onUnload()
  }
})

test('游客登录返回后重新校验球局并恢复加入确认，取消或失效不会提交', async () => {
  const { app, stats } = guestActionRuntime()
  let joins = 0
  const readModes = []
  const venue = { id: 'venue_public', name: '萧潮乒乓球馆', listingMode: 'name_only', coverFileIds: [] }
  const rawMatch = {
    id: 'match_public', title: '周末切磋', venueId: venue.id, venue,
    date: '2099-09-12', startTime: '19:00', endTime: '20:30',
    startAt: '2099-09-12T19:00:00+08:00', endAt: '2099-09-12T20:30:00+08:00',
    capacity: 2, participantCount: 1, seats: 1, status: 'recruiting',
    expectedBallAge: '不限球龄', practiceIntent: '切磋球技', joinMode: 'direct',
    courtStatus: 'booked', host: { playerId: 'host_public', displayName: '发起人' }, participants: []
  }
  let liveMatch = rawMatch
  const api = {
    createRequestId: () => 'review_join_01',
    matches: {
      get: async (_, options = {}) => { readModes.push(options.publicRead); return { match: liveMatch, membership: null } },
      join: async () => { joins += 1; return {} },
      confirmSchedule: async () => {}
    },
    venues: { get: async () => venue },
    favorites: { status: async () => ({ markedIds: [] }), set: async () => {} },
    files: { resolve: async () => ({ urls: {} }) }
  }
  const page = loadPage('pages/match-detail/match-detail.js', api)
  page.onLoad({ id: rawMatch.id })
  await page.loadMatch()
  assert.equal(page.data.state, 'ready')
  assert.deepEqual(readModes, [true], '游客详情必须显式使用公开读取')
  assert.equal(stats.sessionChecks, 0)
  assert.equal(stats.privacy, 0)
  await page.primaryAction()
  assert.equal(stats.loginOpens, 1)
  assert.equal(page.data.joinSheet, false)
  assert.deepEqual(page.pendingJoinIntent, { matchId: rawMatch.id })

  await page.onShow()
  assert.equal(page.pendingJoinIntent, null, '取消登录返回必须清除加入意图')
  assert.equal(page.data.joinSheet, false)

  await page.primaryAction()
  app.globalData.session = { profile: { playerId: 'joined_viewer' } }
  await page.onShow()
  assert.deepEqual(readModes, [true, true, false], '登录返回必须以登录身份重新读取球局')
  assert.equal(page.pendingJoinIntent, null)
  assert.equal(page.data.joinSheet, true, '仍可加入时应恢复确认面板，无需二次点击')
  assert.equal(joins, 0, '恢复确认面板不能自动提交加入')

  page.closeJoin()
  app.globalData.session = null
  page.setData({ loggedIn: false })
  await page.primaryAction()
  liveMatch = Object.assign({}, rawMatch, { status: 'cancelled' })
  app.globalData.session = { profile: { playerId: 'joined_viewer' } }
  await page.onShow()
  assert.equal(page.pendingJoinIntent, null)
  assert.equal(page.data.joinSheet, false, '球局失效后不得恢复确认面板')
  assert(stats.toasts.includes('球局状态已变化，请查看最新信息'))
  assert.equal(joins, 0)
})

test('游客登录返回后重新校验时段并恢复预约确认，取消或失效不会提交', async () => {
  const { app, stats } = guestActionRuntime()
  let bookings = 0
  const readModes = []
  const slot = {
    id: 'slot_public', venueId: 'venue_public',
    startAt: '2099-09-13T10:00:00+08:00', endAt: '2099-09-13T11:00:00+08:00',
    price: 180, remaining: 1, version: 1
  }
  let liveSlots = [slot]
  const api = {
    createRequestId: () => 'review_booking_01',
    coaches: { get: async (_, options = {}) => {
      readModes.push(options.publicRead)
      return { coach: { id: 'coach_public', name: '陈教练', venueIds: ['venue_public'], specialty: ['基本功'] }, slots: liveSlots }
    } },
    venues: { get: async () => ({ id: 'venue_public', name: '萧潮乒乓球馆', listingMode: 'name_only' }) },
    coachBookings: { create: async () => { bookings += 1 } },
    files: { resolve: async () => ({ urls: {} }) }
  }
  const page = loadPage('pages/coach-detail/coach-detail.js', api)
  page.onLoad({ id: 'coach_public' })
  await page.loadCoach()
  assert.equal(page.data.state, 'ready')
  assert.deepEqual(readModes, [true], '游客教练详情必须显式使用公开读取')
  assert.equal(stats.sessionChecks, 0)
  page.selectSlot({ currentTarget: { dataset: { id: slot.id } } })
  await page.openBooking()
  assert.equal(stats.loginOpens, 1)
  assert.equal(page.data.bookingSheet, false)
  assert.deepEqual(page.pendingBookingIntent, { coachId: 'coach_public', slotId: slot.id })

  await page.onShow()
  assert.equal(page.pendingBookingIntent, null, '取消登录返回必须清除预约意图')
  assert.equal(page.data.bookingSheet, false)

  await page.openBooking()
  app.globalData.session = { profile: { playerId: 'booking_viewer' }, policies: {} }
  await page.onShow()
  assert.deepEqual(readModes, [true, true, false], '登录返回必须以登录身份重新读取教练时段')
  assert.equal(page.pendingBookingIntent, null)
  assert.equal(page.data.bookingSheet, true, '时段仍存在时应恢复确认面板，无需二次点击')
  assert.equal(bookings, 0, '恢复确认面板不能自动创建预约')

  page.closeBooking()
  app.globalData.session = null
  page.setData({ loggedIn: false })
  await page.openBooking()
  liveSlots = []
  app.globalData.session = { profile: { playerId: 'booking_viewer' }, policies: {} }
  await page.onShow()
  assert.equal(page.pendingBookingIntent, null)
  assert.equal(page.data.bookingSheet, false, '时段失效后不得恢复确认面板')
  assert(stats.toasts.includes('该时段已不可约，请重新选择'))
  assert.equal(bookings, 0)
})

;(async () => {
  for (const item of tests) {
    await item.run()
    console.log(`PASS ${item.name}`)
  }
  console.log(`${tests.length} review compliance client checks passed`)
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
