const assert = require('assert')
const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const apiPath = path.join(projectRoot, 'utils', 'api.js')
const privacyPath = path.join(projectRoot, 'utils', 'privacy.js')
const memory = Object.create(null)
const navigation = []
const modals = []
const toasts = []
let modalResult = { confirm: true, cancel: false }
let failPrefillWrite = false
let capturedPage = null
let createCalls = 0
let lastCreatePayload = null
let appointmentItems = []
let venueItems = []

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

global.wx = {
  getStorageSync(key) { return memory[key] },
  setStorageSync(key, value) {
    if (failPrefillWrite && key === 'laiyipai_ui_publish_prefill_v2') throw new Error('storage full')
    memory[key] = clone(value)
  },
  removeStorageSync(key) { delete memory[key] },
  getStorageInfoSync() { return { currentSize: 1, limitSize: 10240, keys: Object.keys(memory) } },
  showModal(options) {
    modals.push(clone(options))
    if (options.success) options.success(modalResult)
  },
  showToast(options) { toasts.push(clone(options)) },
  navigateTo(options) { navigation.push({ type: 'navigateTo', url: options.url }) },
  switchTab(options) { navigation.push({ type: 'switchTab', url: options.url }) },
  pageScrollTo() {},
  stopPullDownRefresh() {}
}

global.Page = (definition) => { capturedPage = definition }
global.getApp = () => ({ ensureSession: async () => ({}) })

function mockModule(filename, exports) {
  const resolved = require.resolve(filename)
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] }
}

mockModule(apiPath, {
  createRequestId: () => 'req_rebook_test',
  venues: {
    list: async () => ({ items: venueItems }),
    get: async ({ venueId }) => {
      const item = venueItems.find((row) => row.id === venueId)
      if (!item) throw Object.assign(new Error('球馆不存在'), { code: 'NOT_FOUND' })
      return item
    }
  },
  appointments: { list: async () => ({ items: appointmentItems }) },
  matches: {
    create: async (payload) => { createCalls += 1; lastCreatePayload = clone(payload); return { match: {} } },
    pending: async () => ({ items: [] }),
    respondJoin: async () => ({}),
    cancel: async () => ({}),
    confirmSchedule: async () => ({})
  },
  coachBookings: { cancel: async () => ({}) }
})
mockModule(privacyPath, { openContract() {} })

function instantiate(definition) {
  const page = {}
  Object.keys(definition).forEach((key) => {
    page[key] = key === 'data' ? clone(definition[key]) : definition[key]
  })
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch)
    if (callback) callback()
  }
  return page
}

function loadPage(relativePath) {
  const filename = path.join(projectRoot, relativePath)
  delete require.cache[require.resolve(filename)]
  capturedPage = null
  require(filename)
  assert(capturedPage, `${relativePath} did not register Page()`)
  return instantiate(capturedPage)
}

function resetRuntime() {
  Object.keys(memory).forEach((key) => delete memory[key])
  navigation.splice(0)
  modals.splice(0)
  toasts.splice(0)
  modalResult = { confirm: true, cancel: false }
  failPrefillWrite = false
  createCalls = 0
  appointmentItems = []
  venueItems = []
}

function venue(id) {
  return {
    id,
    name: id === 'venue-active' ? '黄龙体育中心' : '已下架球馆',
    city: '杭州',
    district: '西湖区',
    address: '测试地址',
    verified: true,
    coverFileIds: []
  }
}

function historicalMatch(overrides = {}) {
  return {
    id: 'appointment-history',
    type: 'match',
    status: 'joined',
    membershipStatus: 'joined',
    match: Object.assign({
      id: 'match-history',
      title: '周末练反手',
      venueId: 'venue-active',
      venue: venue('venue-active'),
      date: '2026-08-01',
      startTime: '19:00',
      endTime: '20:30',
      startAt: '2026-08-01T19:00:00+08:00',
      endAt: '2026-08-01T20:30:00+08:00',
      capacity: 6,
      participantCount: 4,
      expectedBallAge: '球龄 2—5 年',
      skills: ['反手拧拉', '接发球'],
      feePerPerson: 28,
      courtStatus: 'booked',
      courtBookingNote: '二号台',
      joinMode: 'confirm',
      note: '旧时间到前台集合',
      status: 'finished',
      version: 3,
      participants: [{ playerId: 'player-old' }],
      messages: [{ text: '旧聊天' }]
    }, overrides),
    updatedAt: '2026-08-01T21:00:00+08:00'
  }
}

async function run() {
  resetRuntime()
  const clientState = require(path.join(projectRoot, 'utils', 'client-state.js'))
  const queued = clientState.setRebookPrefill(historicalMatch().match)
  assert.strictEqual(queued.kind, 'rebook')
  assert.strictEqual(queued.venueId, 'venue-active')
  assert.strictEqual(queued.capacity, 6)
  assert.strictEqual(queued.practiceIntent, '随便练练')
  assert.strictEqual(
    clientState.setRebookPrefill(historicalMatch({ practiceIntent: '切磋球技' }).match).practiceIntent,
    '切磋球技'
  )
  ;['date', 'startTime', 'endTime', 'courtStatus', 'courtBookingNote', 'termsAccepted', 'note', 'participants', 'messages'].forEach((field) => {
    assert(!Object.prototype.hasOwnProperty.call(queued, field), `rebook prefill must not copy ${field}`)
  })

  resetRuntime()
  appointmentItems = [historicalMatch()]
  clientState.savePublishDraft({ title: '我还没发完的草稿', venueId: 'venue-active' })
  const originalDraft = clone(clientState.getPublishDraft())
  modalResult = { confirm: false, cancel: true }
  const orders = loadPage('pages/orders/orders.js')
  await orders.loadAppointments()
  assert.strictEqual(orders.data.allAppointments[0].canRebook, true)
  orders.openRebook({ currentTarget: { dataset: { id: 'appointment-history' } } })
  assert.strictEqual(modals.length, 1)
  assert.deepStrictEqual(clientState.getPublishDraft(), originalDraft)
  assert.strictEqual(memory.laiyipai_ui_publish_prefill_v2, undefined)
  assert.strictEqual(navigation.length, 0)

  modalResult = { confirm: true, cancel: false }
  orders.openRebook({ currentTarget: { dataset: { id: 'appointment-history' } } })
  assert.strictEqual(memory.laiyipai_ui_publish_prefill_v2.kind, 'rebook')
  assert.deepStrictEqual(navigation.pop(), { type: 'switchTab', url: '/pages/publish/publish' })

  venueItems = [venue('venue-active')]
  const publish = loadPage('pages/publish/publish.js')
  publish.setData({
    loadState: 'ready',
    venues: venueItems,
    venueNames: venueItems.map((item) => item.name),
    publishedMatch: { id: 'just-published' },
    courtStatus: 'booked',
    termsAccepted: true,
    note: '不能复用的旧备注'
  })
  publish.onShow()
  await publish.loadVenues()
  assert.strictEqual(publish.data.publishedMatch, null)
  assert.strictEqual(publish.data.selectedVenue.id, 'venue-active')
  assert.strictEqual(publish.data.capacity, 6)
  assert.strictEqual(publish.data.ballAgeIndex, 3)
  assert.strictEqual(publish.data.practiceIntent, '随便练练')
  assert.notStrictEqual(publish.data.date, '2026-08-01')
  assert(new Date(`${publish.data.date}T${publish.data.startTime}:00+08:00`).getTime() > Date.now())
  assert.strictEqual(publish.data.courtStatus, 'unbooked')
  assert.strictEqual(publish.data.termsAccepted, false)
  assert.strictEqual(publish.data.note, '')
  assert.strictEqual(publish.data.rebookTimeConfirmed, false)
  assert.strictEqual(publish.validate(), '请先确认本次约球时间')
  publish.confirmRebookTime()
  assert.strictEqual(publish.data.rebookTimeConfirmed, true)
  assert.strictEqual(publish.validate(), '请先阅读并同意用户协议和隐私保护指引')
  assert.strictEqual(createCalls, 0)

  publish.setData({ courtStatus: 'booked', rebookTimeConfirmed: true })
  publish.changeStartTime({ detail: { value: publish.data.startTime } })
  assert.strictEqual(publish.data.courtStatus, 'unbooked')
  assert.strictEqual(publish.data.rebookTimeConfirmed, false)

  resetRuntime()
  venueItems = [venue('venue-active')]
  clientState.setRebookPrefill(historicalMatch({ venueId: 'venue-removed', venue: venue('venue-removed') }).match)
  const unavailablePublish = loadPage('pages/publish/publish.js')
  unavailablePublish.setData({ loadState: 'ready', venues: [venue('venue-removed')], venueNames: ['旧缓存球馆'] })
  unavailablePublish.onShow()
  await unavailablePublish.loadVenues()
  assert.strictEqual(unavailablePublish.data.venueId, '')
  assert.strictEqual(unavailablePublish.data.selectedVenue, null)
  assert.strictEqual(unavailablePublish.data.rebookVenueUnavailable, true)
  assert(unavailablePublish.data.rebookNotice.includes('不可选择'))

  resetRuntime()
  venueItems = [venue('venue-active')]
  clientState.savePublishDraft({
    title: '过期的复约草稿',
    venueId: 'venue-active',
    date: '2026-08-01',
    startTime: '19:00',
    endTime: '20:30',
    courtStatus: 'booked',
    capacity: 4,
    ballAgeIndex: 0,
    selectedSkills: ['实战对抗'],
    joinMode: 'direct',
    feePerPerson: '',
    note: '',
    termsAccepted: false,
    rebookMode: true,
    rebookTimeConfirmed: true,
    rebookVenueUnavailable: false
  })
  const expiredPublish = loadPage('pages/publish/publish.js')
  expiredPublish.onLoad()
  await expiredPublish.loadVenues()
  assert.notStrictEqual(expiredPublish.data.date, '2026-08-01')
  assert.strictEqual(expiredPublish.data.courtStatus, 'unbooked')
  assert.strictEqual(expiredPublish.data.rebookTimeConfirmed, false)
  assert.strictEqual(expiredPublish.data.practiceIntent, '切磋球技')

  // 冷启动恢复已有复约草稿时，也要用最新球馆列表检查可用性。
  clientState.savePublishDraft(Object.assign({}, clientState.getPublishDraft(), {
    venueId: 'venue-removed',
    rebookMode: true
  }))
  const restoredPublish = loadPage('pages/publish/publish.js')
  restoredPublish.onLoad()
  await restoredPublish.loadVenues()
  assert.strictEqual(restoredPublish.data.venueId, '')
  assert.strictEqual(restoredPublish.data.selectedVenue, null)
  assert.strictEqual(restoredPublish.data.rebookVenueUnavailable, true)

  resetRuntime()
  appointmentItems = [historicalMatch()]
  failPrefillWrite = true
  const failedOrders = loadPage('pages/orders/orders.js')
  await failedOrders.loadAppointments()
  failedOrders.openRebook({ currentTarget: { dataset: { id: 'appointment-history' } } })
  assert.strictEqual(navigation.length, 0)
  assert.strictEqual(toasts[0].title, '暂时无法准备发布内容，请稍后重试')

  const publishTemplate = fs.readFileSync(path.join(projectRoot, 'pages', 'publish', 'publish.wxml'), 'utf8')
  assert(publishTemplate.indexOf('data-field="title"') < publishTemplate.indexOf('wx:if="{{showMoreOptions}}"'), '标题无需展开补充设置即可填写')
  resetRuntime()
  const custom = loadPage('pages/publish/publish.js')
  custom.selectVenue({ id: 'custom_venue', name: '未填地区球馆' })
  custom.changeField({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '开球网1500分左右，随便打打' } })
  custom.changeDistrict({ detail: { value: '2' } })
  assert.strictEqual(custom.data.district, '萧山区')
  const savedDraft = clientState.getPublishDraft()
  assert.strictEqual(savedDraft.title, '开球网1500分左右，随便打打')
  assert.strictEqual(savedDraft.district, '萧山区')
  venueItems = [{ id: 'custom_venue', name: '未填地区球馆', city: '杭州', listingMode: 'name_only' }]
  const restoredCustom = loadPage('pages/publish/publish.js')
  restoredCustom.onLoad()
  await restoredCustom.loadVenues()
  assert.strictEqual(restoredCustom.data.district, '萧山区', '重新打开页面恢复地区草稿')
  assert.strictEqual(restoredCustom.data.title, savedDraft.title)
  restoredCustom.setData({ date: '2099-01-01', startTime: '19:00', endTime: '20:30', termsAccepted: true })
  await restoredCustom.submit()
  assert.strictEqual(lastCreatePayload.title, savedDraft.title)
  assert.strictEqual(lastCreatePayload.district, '萧山区', '发布请求带入用户选择的地区')
  custom.persistDraft()
  assert.strictEqual(custom.data.district, '萧山区', '刷新同一球馆保留补填地区')
  custom.selectVenue({ id: 'another_venue', name: '另一家球馆' })
  assert.strictEqual(custom.data.district, '', '换球馆后不带入旧地区')
  custom.selectVenue(venue('known_venue'))
  assert.strictEqual(custom.data.district, '西湖区')
  custom.changeDistrict({ detail: { value: '1' } })
  assert.strictEqual(custom.data.district, '西湖区', '已知地区跟随球馆')
  custom.resetForm()
  assert.strictEqual(custom.data.district, '')
  assert.strictEqual(custom.data.title, '')
  assert.strictEqual(require('../utils/present').venue({ name: '测试球馆', listingMode: 'name_only', district: '滨江区' }).district, '滨江区', '名称型球馆可保留明确提供的行政区')
  console.log('PASS 标题直接填写、草稿保留地区、换馆不残留地区且已知地区不可改')
  assert(!publishTemplate.includes('检查云环境配置'))
  assert(publishTemplate.includes("{{errorMessage || '请检查网络后重试'}}"))
  console.log('PASS 再约一场仅复用安全字段并显式确认新时间')
  console.log('PASS 未提交草稿在用户确认替换前保持不变')
  console.log('PASS 缓存成功页与已下架球馆均可安全进入新发布流程')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
