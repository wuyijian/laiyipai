const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const app = require('../app.json')
const present = require('../utils/present')
const clientState = require('../utils/client-state')
const api = require('../utils/api')
const tabBar = require('../utils/tab-bar')
const scrolls = [], notices = []
global.wx = {
  getStorageSync() {}, setStorageSync() {}, removeStorageSync() {},
  pageScrollTo(value) { scrolls.push(value) }, showToast(value) { notices.push(value) },
  showShareMenu() {}, hideShareMenu() {},
  getAccountInfoSync() { return { miniProgram: { envVersion: 'develop' } } }
}
global.getApp = () => ({ ensureSession: async () => ({ policies: {} }) })
function page(name) {
  let definition
  global.Page = value => { definition = value }
  const filename = path.join(root, 'pages', name, `${name}.js`)
  delete require.cache[require.resolve(filename)]
  require(filename)
  const instance = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  instance.setData = function(patch, callback) {
    for (const [key, value] of Object.entries(patch)) {
      const keys = key.split('.'); let target = this.data
      while (keys.length > 1) { const part = keys.shift(); target = target[part] || (target[part] = {}) }
      target[keys[0]] = value
    }
    if (callback) callback()
  }
  return instance
}
const tests = []
function test(name, run) { tests.push({name, run}) }
test('所有页面均使用统一样式容器，底部导航使用无图片依赖的 CSS 图标', () => {
  assert.equal(app.pages.length, 21)
  assert(app.pages.includes('pages/update-detail/update-detail'), '旧分享链接保留下线提示页，不再提供动态内容')
  for (const route of app.pages) {
    const content = fs.readFileSync(path.join(root, `${route}.wxml`), 'utf8')
    assert(content.startsWith('<view class="ui-screen">'), route)
  }
  assert.equal(app.tabBar.custom, true)
  assert(app.tabBar.list.every((tab) => !tab.iconPath && !tab.selectedIconPath))
  const customTabTemplate = fs.readFileSync(path.join(root, 'custom-tab-bar', 'index.wxml'), 'utf8')
  const customTabStyle = fs.readFileSync(path.join(root, 'custom-tab-bar', 'index.wxss'), 'utf8')
  assert(!/<image\b|<cover-image\b|\bsrc\s*=/.test(customTabTemplate))
  for (const icon of ['home', 'publish', 'orders', 'profile']) {
    assert(customTabStyle.includes(`.tab-icon--${icon}`))
  }
  assert.deepEqual(app.tabBar.list.map(item => ({ pagePath: item.pagePath, text: item.text })),
    tabBar.TAB_ITEMS.map(item => ({ pagePath: item.pagePath, text: item.text })))
})
test('球友局加载失败时可直接退回全部球局，不把用户困在错误页', () => {
  const home = fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8')
  assert(home.includes('wx:if="{{friendsOnly && !loginRequired}}"'))
  assert(home.includes('bindtap="expandMatchSearch">查看全部球局</button>'))
})
test('四个主页面显示时主动同步底栏，路由格式差异不影响高亮', () => {
  const routes = app.tabBar.list.map(item => item.pagePath)
  routes.forEach((route, index) => {
    const source = fs.readFileSync(path.join(root, `${route}.js`), 'utf8')
    assert(source.includes(`tabBar.sync(this, '${route}')`), route)
    assert.equal(tabBar.indexForRoute(`/${route}?from=detail`), index)
    const component = {
      data: { selected: index === 0 ? 3 : 0 },
      setData(patch) { Object.assign(this.data, patch) }
    }
    assert.equal(tabBar.sync({ getTabBar: () => component }, route), true)
    assert.equal(component.data.selected, index)
  })
})
test('自定义底栏按当前页面高亮、切换失败回滚并支持重复点击回顶部', () => {
  const previousComponent = global.Component
  const previousGetCurrentPages = global.getCurrentPages
  const previousSwitchTab = wx.switchTab
  const previousPageScrollTo = wx.pageScrollTo
  const componentPath = require.resolve('../custom-tab-bar/index')
  let definition
  let route = 'pages/orders/orders'
  let switchedUrl = ''
  let scrolledTop = false
  try {
    global.Component = (value) => { definition = value }
    global.getCurrentPages = () => [{ route }]
    delete require.cache[componentPath]
    require(componentPath)
    const instance = {
      data: JSON.parse(JSON.stringify(definition.data)),
      setData(patch) { Object.assign(this.data, patch) }
    }
    Object.assign(instance, definition.methods)
    definition.lifetimes.attached.call(instance)
    assert.equal(instance.data.selected, 2)

    wx.switchTab = (options) => {
      switchedUrl = options.url
      route = 'pages/profile/profile'
      if (options.complete) options.complete()
    }
    instance.onTabTap({ currentTarget: { dataset: { index: 3 } } })
    assert.equal(switchedUrl, '/pages/profile/profile')
    assert.equal(instance.data.selected, 3)
    assert.equal(instance._switching, false)

    wx.pageScrollTo = (options) => { scrolledTop = options.scrollTop === 0 }
    instance.onTabTap({ currentTarget: { dataset: { index: 3 } } })
    assert.equal(scrolledTop, true)

    wx.switchTab = (options) => {
      if (options.fail) options.fail({ errMsg: 'switchTab:fail' })
      if (options.complete) options.complete()
    }
    instance.onTabTap({ currentTarget: { dataset: { index: 1 } } })
    assert.equal(instance.data.selected, 3)
  } finally {
    if (previousComponent === undefined) delete global.Component
    else global.Component = previousComponent
    if (previousGetCurrentPages === undefined) delete global.getCurrentPages
    else global.getCurrentPages = previousGetCurrentPages
    if (previousSwitchTab === undefined) delete wx.switchTab
    else wx.switchTab = previousSwitchTab
    wx.pageScrollTo = previousPageScrollTo
    delete require.cache[componentPath]
  }
})
test('球局和教练课分开展示日期与时段，不丢失原始安排', () => {
  const match = present.appointment({type:'match', match:{id:'m', date:'2030-01-02', startTime:'18:30', endTime:'20:00'}})
  assert.equal(match.timeRange, '18:30—20:00')
  assert(match.dateLabel)
  assert(match.scheduleText.includes(match.timeRange))
  const lesson = present.appointment({type:'coach',booking:{startAt:'2030-01-02T10:00:00Z',endAt:'2030-01-02T11:30:00Z'}})
  assert(lesson.dateLabel)
  assert.equal(lesson.timeRange, `${present.timeText('2030-01-02T10:00:00Z')}—${present.timeText('2030-01-02T11:30:00Z')}`)
})
test('发布校验信息紧邻固定发布按钮，球馆无照片不显示伪封面', () => {
  const publish = fs.readFileSync(path.join(root,'pages/publish/publish.wxml'),'utf8')
  const publishStyle = fs.readFileSync(path.join(root,'pages/publish/publish.wxss'),'utf8')
  assert(publish.indexOf('class="dock-error"') > publish.indexOf('class="submit-dock"'))
  assert(!publish.includes('其他设置可以后改'))
  assert(/\.capacity-control\s*\{[^}]*width:\s*100%[^}]*max-width:\s*520rpx/.test(publishStyle))
  assert(publish.includes('还没有可选球馆'))
  assert(publish.includes('bindtap="openVenueCreate">录入球馆</button>'))
  const venue = fs.readFileSync(path.join(root,'pages/venue-detail/venue-detail.wxml'),'utf8')
  assert(!venue.includes('class="venue-cover-empty"'))
  assert(venue.includes('class="venue-publish-dock"'))
})
test('正在进行的球局不再提示取消，免费球局不重复提示支付', () => {
  const now = Date.now()
  const item = present.appointment({type:'match', status:'host', membershipStatus:'host', match:{
    id:'active', capacity:4, startAt:new Date(now - 60000), endAt:new Date(now + 3600000),
    date:'2030-01-02', startTime:'18:30', endTime:'20:00', feePerPerson:0
  }})
  assert.equal(item.period, 'upcoming')
  assert.equal(item.statusLabel, '进行中')
  assert.equal(item.canCancel, false)
  assert.equal(item.canChat, true)
  assert.equal(item.paymentText, '免费')
})
test('找球馆入口只消费一次，首页始终保持找球局', async () => {
  const home = page('home')
  home.data.mode = 'coaches'; home.data.districtIndex = 2
  home.data.venues = [{id:'venue'}]
  home.loadContent = async () => true
  clientState.requestVenueDiscovery()
  await home.onShow()
  assert.equal(home.data.mode, 'matches')
  assert.equal(home.data.districtIndex, 0)
  assert.equal(scrolls.at(-1).selector, '#home-venues')
  const previous = scrolls.length
  home.data.mode = 'matches'
  await home.onShow()
  assert.equal(home.data.mode, 'matches')
  assert.equal(scrolls.length, previous)
})
test('重复点击当前教练日期保留时段；更换日期清理旧请求编号', () => {
  const coach = page('coach-detail')
  coach.data.selectedDate = '2030-01-02'; coach.data.selectedSlotId = 'slot-a'
  coach.data.selectedSlot = {id:'slot-a'}; coach.bookingRequestId = 'attempt-a'
  coach.selectDate({currentTarget:{dataset:{value:'2030-01-02'}}})
  assert.equal(coach.data.selectedSlotId, 'slot-a')
  assert.equal(coach.bookingRequestId, 'attempt-a')
  coach.selectDate({currentTarget:{dataset:{value:'2030-01-03'}}})
  assert.equal(coach.data.selectedSlot, null)
  assert.equal(coach.bookingRequestId, '')
})
test('教练预约重试保留同一选择，切换时段不会复用旧幂等编号', () => {
  const coach = page('coach-detail')
  coach.data.coach = {}
  coach.data.slots = [{id:'a',venueId:'venue-a',venueName:'球馆甲'}, {id:'b',venueId:'venue-b',venueName:'球馆乙'}, {id:'c',venueId:'venue-c',venueName:''}]
  coach.data.selectedSlotId = 'a'; coach.bookingRequestId = 'attempt-a'
  coach.selectSlot({currentTarget:{dataset:{id:'a'}}})
  assert.equal(coach.bookingRequestId, 'attempt-a')
  coach.selectSlot({currentTarget:{dataset:{id:'b'}}})
  assert.equal(coach.bookingRequestId, '')
  assert.equal(coach.data.coach.venueName, '球馆乙')
  assert.equal(coach.data.coach.venueId, 'venue-b')
  coach.selectSlot({currentTarget:{dataset:{id:'c'}}})
  assert.equal(coach.data.coach.venueName, '球馆资料待加载')
  assert.equal(coach.data.coach.venueId, 'venue-c')
  coach.data.booking = true
  coach.selectSlot({currentTarget:{dataset:{id:'a'}}})
  assert.equal(coach.data.selectedSlotId, 'c')
})
test('教练资料刷新失败保留内容；资源下架则关闭预约面板', async () => {
  const coach = page('coach-detail')
  coach.data.id = 'c'; coach.data.state = 'ready'; coach.data.coach = {id:'c'}
  coach.data.bookingSheet = true; coach.data.selectedSlot = {id:'a'}
  const original = api.coaches.get
  try {
    api.coaches.get = async () => { throw Object.assign(new Error('offline'),{code:'NETWORK_ERROR'}) }
    await coach.loadCoach()
    assert.equal(coach.data.state, 'ready')
    assert.equal(coach.data.selectedSlot.id, 'a')
    assert(notices.length)
    api.coaches.get = async () => { throw Object.assign(new Error('removed'),{code:'NOT_FOUND'}) }
    await coach.loadCoach()
    assert.equal(coach.data.state, 'error')
    assert.equal(coach.data.bookingSheet, false)
    assert.equal(coach.data.selectedSlot, null)
  } finally { api.coaches.get = original }
})
test('球馆默认头像按稳定编号生成，刷新和渲染次序不改变外观', () => {
  const { variant } = require('../utils/venue-avatar')
  const seeds = Array.from({length: 100}, (_, index) => `venue-${index}`)
  const first = seeds.map(seed => JSON.stringify(variant(seed)))
  assert.deepEqual(first, seeds.map(seed => JSON.stringify(variant(seed))))
  assert(new Set(first).size > 70)
  assert(new Set(seeds.map(seed => variant(seed).background)).size === 8)
  assert.deepEqual(variant(''), variant(null))
  assert.deepEqual(variant('venue-a'), variant('venue-a'))
  assert.notDeepEqual(variant('萧潮乒乓球馆'), variant('桂语朝阳乒乓球室'))
})

test('球馆照片加载失败回退插画，换照片后允许重试，换编号更新头像', () => {
  const previousComponent = global.Component
  let definition
  try {
    global.Component = value => { definition = value }
    const componentPath = require.resolve('../components/venue-avatar/venue-avatar')
    delete require.cache[componentPath]
    require(componentPath)
    const instance = { data: JSON.parse(JSON.stringify(definition.data)), setData(patch) { Object.assign(this.data, patch) } }
    definition.methods.onImageError.call(instance)
    assert.equal(instance.data.imageFailed, true)
    definition.observers.src.call(instance)
    assert.equal(instance.data.imageFailed, false)
    definition.observers.seed.call(instance, 'venue-new')
    assert.deepEqual(instance.data.palette, require('../utils/venue-avatar').variant('venue-new'))
  } finally { global.Component = previousComponent }
  const template = fs.readFileSync(path.join(root, 'components/venue-avatar/venue-avatar.wxml'), 'utf8')
  assert(template.includes('src && !imageFailed'))
  assert(template.includes('binderror="onImageError"'))
})

test('五处球馆头像统一使用球馆编号，不覆盖真实封面展示', () => {
  assert.equal(app.usingComponents['venue-avatar'], '/components/venue-avatar/venue-avatar')
  for (const name of ['home', 'profile', 'publish', 'match-detail', 'venue-detail']) {
    const template = fs.readFileSync(path.join(root, 'pages', name, `${name}.wxml`), 'utf8')
    const avatar = template.match(/<venue-avatar\s[^>]*\/>/)
    assert(avatar, name)
    assert(['item.id', 'selectedVenue.id', 'match.venueId', 'venue.id'].some((token) => avatar[0].includes(token)), name)
    assert(avatar[0].includes('src='), name)
  }
  const venue = fs.readFileSync(path.join(root, 'pages/venue-detail/venue-detail.wxml'), 'utf8')
  assert(venue.includes('venue.imageUrls.length'))
})

test('首页发球局会沿用当前筛选，并支持从球馆卡片直接发起', () => {
  const home = page('home')
  home.onLoad()
  const selectedDate = home.data.dateOptions[2].value
  home.setData({ selectedDate, ballAgeIndex: 3 })
  const previousPrefill = clientState.setPublishPrefill
  const previousSwitchTab = wx.switchTab
  let prefill
  let destination
  try {
    clientState.setPublishPrefill = value => { prefill = value; return true }
    wx.switchTab = value => { destination = value.url }
    home.openPublish({ currentTarget: { dataset: { id: 'venue-fast' } } })
  } finally {
    clientState.setPublishPrefill = previousPrefill
    if (previousSwitchTab) wx.switchTab = previousSwitchTab
    else delete wx.switchTab
  }
  assert.deepEqual(prefill, {
    source: 'home', venueId: 'venue-fast', date: selectedDate, expectedBallAge: '球龄 2—5 年'
  })
  assert.equal(destination, '/pages/publish/publish')
  const template = fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8')
  assert(template.includes('在这里发球'))
  assert(template.includes('data-id="{{item.id}}" bindtap="openPublish"'))
})

test('首页续写草稿不静默改筛选，快捷球馆写入失败不跳转', () => {
  const home = page('home')
  home.onLoad()
  home.setData({ mode: 'matches', selectedDate: home.data.dateOptions[2].value, ballAgeIndex: 3 })
  const previousHasDraft = clientState.hasPublishDraft
  const previousPrefill = clientState.setPublishPrefill
  const previousSwitchTab = wx.switchTab
  let hasDraft = true
  let shouldStore = true
  const prefills = []
  let switches = 0
  try {
    clientState.hasPublishDraft = () => hasDraft
    clientState.setPublishPrefill = value => { prefills.push(value); return shouldStore }
    wx.switchTab = () => { switches += 1 }

    home.openPublish({ currentTarget: { dataset: {} } })
    assert.equal(prefills.length, 0)
    assert.equal(switches, 1)

    home.openPublish({ currentTarget: { dataset: { id: 'venue-draft' } } })
    assert.deepEqual(prefills[0], { source: 'home', venueId: 'venue-draft' })
    assert.equal(switches, 2)

    hasDraft = false
    shouldStore = false
    home.openPublish({ currentTarget: { dataset: { id: 'venue-failed' } } })
    assert.equal(switches, 2)
    assert(notices.at(-1).title.includes('无法准备'))
  } finally {
    clientState.hasPublishDraft = previousHasDraft
    clientState.setPublishPrefill = previousPrefill
    if (previousSwitchTab) wx.switchTab = previousSwitchTab
    else delete wx.switchTab
  }
})

test('切换预填日期或球馆会失效旧订台与复约确认', () => {
  const publish = page('publish')
  const dates = require('../utils/date').dateTabs(5)
  const venues = [
    { id: 'venue-a', name: '球馆甲', imageUrls: [], activityTags: [] },
    { id: 'venue-b', name: '球馆乙', imageUrls: [], activityTags: [] }
  ]
  publish.setData({
    date: dates[1].value,
    venueId: 'venue-a',
    selectedVenue: venues[0],
    venues,
    courtStatus: 'booked',
    rebookMode: true,
    rebookTimeConfirmed: true,
    rebookNotice: '旧提示'
  })
  publish.applyPrefill({ source: 'home', venueId: 'venue-b', date: dates[2].value })
  assert.equal(publish.data.venueId, 'venue-b')
  assert.equal(publish.data.courtStatus, 'unbooked')
  assert.equal(publish.data.rebookTimeConfirmed, false)
  assert(publish.data.rebookNotice.includes('重新确认'))

  publish.setData({ date: dates[2].value, startTime: '20:00', endTime: '21:30' })
  publish.changeStartTime({ detail: { value: '23:30' } })
  assert.equal(publish.data.endTime, '23:59')
  assert(publish.data.submitError.includes('30 分钟'))

  const source = fs.readFileSync(path.join(root, 'pages/publish/publish.js'), 'utf8')
  assert(!source.includes("noteLength: String(draft.note || '').length"))
})

test('发布页接住首页筛选、改开始时间自动顺延，并把错误定位到字段', async () => {
  const publish = page('publish')
  const tomorrow = require('../utils/date').dateTabs(2)[2].value
  publish.setData({ startTime: '18:00', endTime: '19:30' })
  publish.applyPrefill({ source: 'home', date: tomorrow, expectedBallAge: '新手友好' })
  assert.equal(publish.data.date, tomorrow)
  assert.equal(publish.data.ballAgeIndex, 1)
  assert(publish.data.prefillNotice.includes('首页'))

  publish.changeStartTime({ detail: { value: '20:00' } })
  assert.equal(publish.data.endTime, '21:30')
  assert.equal(publish.data.prefillNotice, '')

  const before = scrolls.length
  await publish.submit()
  assert.equal(publish.data.submitError, '请选择球馆')
  assert.equal(scrolls[before].selector, '#publish-venue')

  publish.setData({
    venueId: 'venue-ready',
    selectedVenue: { id: 'venue-ready', name: '测试球馆' },
    feePerPerson: '-1',
    termsAccepted: true
  })
  await publish.submit()
  assert(publish.data.submitError.includes('费用'))
  assert.equal(publish.data.showMoreOptions, true)
  assert.equal(scrolls.at(-1).selector, '#publish-more')
})

test('游客在发布页显式登录返回后自动恢复球馆加载', async () => {
  const publish = page('publish')
  const previousGetApp = global.getApp
  let session = null
  let loads = 0
  publish.setData({ loadState: 'error', publishedMatch: null })
  publish.loadVenues = async () => {
    loads += 1
    publish.setData({ loadState: 'ready' })
    return true
  }
  try {
    global.getApp = () => ({ globalData: { session } })
    await publish.onShow()
    assert.equal(loads, 0, '未登录时不能在页面显示阶段主动拉起登录或私有读取')

    session = { profile: { playerId: 'player-returned' } }
    await publish.onShow()
    assert.equal(loads, 1, '登录返回后应自动恢复此前中断的球馆读取')
    assert.equal(publish.data.loadState, 'ready')

    await publish.onShow()
    assert.equal(loads, 1, '列表已经可用时不应重复加载')
  } finally {
    global.getApp = previousGetApp
  }
})
;(async () => {
  for (const item of tests) { await item.run(); console.log(`PASS ${item.name}`) }
  console.log(`${tests.length} UI experience checks passed`)
})().catch(error => { console.error(error); process.exitCode = 1 })
