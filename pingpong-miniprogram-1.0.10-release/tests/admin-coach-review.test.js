const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const apiPath = require.resolve(path.join(root, 'utils/api'))
let definition
let modal
let notices
let navigation
let listHandler
let getHandler
let reviewHandler
let venuesHandler
let requestSequence

function clone(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)) }
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function turn() { return new Promise((resolve) => setImmediate(resolve)) }
function error(code, details) {
  const value = Object.assign(new Error(code), { code })
  if (details) value.details = details
  return value
}
function application(id, values = {}) {
  return Object.assign({
    id,
    realName: `教练 ${id}`,
    mobile: '13800138000',
    experienceYears: 6,
    specialty: ['基本功', '实战陪练'],
    venueName: '核验球馆',
    qualification: '六年青少年乒乓球教学经历',
    introduction: '重视基本功与步法。',
    status: 'reviewing',
    version: 1,
    submittedAt: '2026-09-12T10:00:00+08:00'
  }, values)
}
function verifiedVenue(id = 'venue_verified', values = {}) {
  return Object.assign({
    id,
    name: '核验球馆',
    city: '杭州',
    district: '西湖区',
    listingMode: 'full',
    nameOnly: false,
    verified: true,
    partnerVerified: false
  }, values)
}

const api = {
  createRequestId() { requestSequence += 1; return `request_coach_${requestSequence}` },
  venues: {
    list(payload, options) { return venuesHandler(payload, options) }
  },
  admin: {
    pendingCoachApplications(payload, options) { return listHandler(payload, options) },
    getCoachApplication(payload, options) { return getHandler(payload, options) },
    reviewCoachApplication(payload, options) { return reviewHandler(payload, options) }
  }
}

require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: api }
global.Page = (value) => { definition = value }
global.getApp = () => ({
  ensureSession: async () => ({ capabilities: { adminCoachReview: true } }),
  openLogin() { navigation.push('/pages/login/login') }
})
global.wx = {
  hideShareMenu() {},
  stopPullDownRefresh() {},
  showToast(value) { notices.push(value) },
  navigateTo(value) { navigation.push(value.url) },
  showModal(value) {
    modal = value
    if (value.success) value.success({ confirm: true, cancel: false })
  }
}

delete require.cache[require.resolve(path.join(root, 'pages/admin-coach-review/admin-coach-review'))]
require(path.join(root, 'pages/admin-coach-review/admin-coach-review'))

function page() {
  modal = null
  notices = []
  navigation = []
  requestSequence = 0
  const instance = Object.assign({}, definition, { data: clone(definition.data) })
  instance.setData = function setData(patch, done) {
    Object.entries(patch).forEach(([key, value]) => {
      const parts = key.split('.')
      let target = this.data
      while (parts.length > 1) {
        const part = parts.shift()
        if (!target[part]) target[part] = {}
        target = target[part]
      }
      target[parts[0]] = value
    })
    if (done) done()
  }
  instance.onLoad()
  return instance
}

function resetHandlers() {
  listHandler = async (payload) => ({ items: [], page: payload.page, pageSize: payload.pageSize, hasMore: false })
  getHandler = async () => ({ application: null })
  reviewHandler = async () => ({})
  venuesHandler = async () => ({ items: [verifiedVenue()], page: 1, pageSize: 50 })
}

async function run() {
  resetHandlers()
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  const project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
  const template = fs.readFileSync(path.join(root, 'pages/admin-coach-review/admin-coach-review.wxml'), 'utf8')
  const style = fs.readFileSync(path.join(root, 'pages/admin-coach-review/admin-coach-review.wxss'), 'utf8')
  const profileSource = fs.readFileSync(path.join(root, 'pages/profile/profile.js'), 'utf8')
  const profileTemplate = fs.readFileSync(path.join(root, 'pages/profile/profile.wxml'), 'utf8')
  assert(app.pages.includes('pages/admin-coach-review/admin-coach-review'))
  assert(project.packOptions.include.some((item) => item.type === 'folder' && item.value === 'pages/admin-coach-review'))
  assert(template.startsWith('<view class="ui-screen">'))
  assert(template.includes('暂无可关联球馆'))
  assert(template.includes('bindtap="createVenue"'))
  assert(template.includes('end="{{maxVerificationDate}}"'), '核验日期上限必须固定为今天，不能随已选日期向前收缩')
  assert(style.includes('@import "../admin-venue-review/admin-venue-review.wxss"'))
  assert(profileSource.includes('capabilities.adminCoachReview === true'))
  assert(profileTemplate.includes('wx:if="{{canReviewCoaches}}" class="admin-review-row"'))
  assert(profileTemplate.includes('bindtap="openAdminCoachReview"'))
  assert.equal(require('../utils/request-policy').isRead('admin.coachApplications.get'), true)
  console.log('PASS 教练审核后台已注册、打包并按服务端 capability 显示入口')

  let queue = [application('first'), application('second')]
  const listCalls = []
  listHandler = async (payload) => {
    listCalls.push(clone(payload))
    const start = (payload.page - 1) * payload.pageSize
    return { items: queue.slice(start, start + payload.pageSize), page: payload.page, pageSize: payload.pageSize, hasMore: start + payload.pageSize < queue.length }
  }
  venuesHandler = async () => ({
    items: [
      verifiedVenue(),
      verifiedVenue('venue_name_only', { name: '社区球馆', listingMode: 'name_only', nameOnly: true, verified: false }),
      verifiedVenue('venue_community', { name: '社区完整馆', userContributed: true, verified: false, address: '江南大道 88 号' }),
      verifiedVenue('venue_unverified', { name: '待核验球馆', verified: false })
    ]
  })
  const loaded = page()
  await loaded.onShow()
  assert.equal(loaded.data.state, 'ready')
  assert.deepEqual(loaded.data.items.map((item) => item.id), ['first', 'second'])
  assert.deepEqual(loaded.data.venues.map((item) => item.id), ['venue_verified', 'venue_name_only', 'venue_community'])
  assert.equal(loaded.data.venues.find((item) => item.id === 'venue_name_only').meta, '名称记录 · 杭州')
  assert.equal(listCalls[0].page, 1)
  assert.equal(listCalls[0].pageSize, 20)
  assert(template.includes("state === 'loading'"))
  assert(template.includes("state === 'error'"))
  assert(template.includes("state === 'forbidden'"))
  assert(template.includes('待审申请已清空'))
  console.log('PASS 已公开名称馆及球友补充地址馆可关联，不伪称管理员认证')

  const venuePages = []
  venuesHandler = async (payload) => {
    venuePages.push(payload.page)
    if (payload.page === 1) {
      return { items: Array.from({ length: 50 }, (_, index) => verifiedVenue(`venue_bulk_${index + 1}`, { name: `核验球馆 ${index + 1}` })) }
    }
    return {
      items: [
        verifiedVenue('venue_bulk_50', { name: '核验球馆 50' }),
        verifiedVenue('venue_bulk_51', { name: '核验球馆 51' }),
        verifiedVenue('venue_tail_name_only', { name: '尾页社区馆', nameOnly: true, listingMode: 'name_only', verified: false })
      ]
    }
  }
  listHandler = async (payload) => ({ items: [], page: payload.page, pageSize: payload.pageSize, hasMore: false })
  const allVenues = page()
  await allVenues.onShow()
  assert.deepEqual(venuePages, [1, 2])
  assert.equal(allVenues.data.venues.length, 52)
  assert.equal(new Set(allVenues.data.venues.map((item) => item.id)).size, 52)
  console.log('PASS 可关联球馆连续翻页至不足 50 条并按编号去重')

  navigation = []
  allVenues.createVenue()
  assert.deepEqual(navigation, ['/pages/venue-create/venue-create?from=coach-review'])
  assert.equal(allVenues.reloadVenuesOnShow, true)
  console.log('PASS 关联列表可跳转录入新球馆并在返回时刷新目录')

  queue = [application('venue_limit', { venueName: '未匹配球馆' })]
  listHandler = async (payload) => ({ items: queue, page: payload.page, pageSize: payload.pageSize, hasMore: false })
  venuesHandler = async () => ({ items: Array.from({ length: 11 }, (_, index) => verifiedVenue(`venue_limit_${index + 1}`, { name: `可选球馆 ${index + 1}` })) })
  const venueLimit = page()
  await venueLimit.onShow()
  venueLimit.openApplication({ currentTarget: { dataset: { id: 'venue_limit' } } })
  venueLimit.data.venues.forEach((venue) => venueLimit.toggleVenue({ currentTarget: { dataset: { id: venue.id } } }))
  assert.equal(venueLimit.data.selectedVenueIds.length, 10)
  assert(notices.some((item) => item.title === '最多关联 10 家球馆'))
  console.log('PASS 最多关联 10 家球馆，第 11 家给出明确提示')

  queue = Array.from({ length: 21 }, (_, index) => application(`page_${index + 1}`))
  listHandler = async (payload) => {
    const start = (payload.page - 1) * payload.pageSize
    return { items: queue.slice(start, start + payload.pageSize), page: payload.page, pageSize: payload.pageSize, hasMore: start + payload.pageSize < queue.length }
  }
  const paged = page()
  await paged.onShow()
  assert.equal(paged.data.items.length, 20)
  assert.equal(paged.data.hasMore, true)
  await paged.loadMore()
  assert.equal(paged.data.items.length, 21)
  assert.equal(paged.data.page, 2)
  assert.equal(paged.data.hasMore, false)
  console.log('PASS 教练待审队列按 hasMore 分页追加')

  queue = [application('approve_me')]
  venuesHandler = async () => ({ items: [verifiedVenue()] })
  const reviewCalls = []
  reviewHandler = async (payload, options) => {
    reviewCalls.push({ payload: clone(payload), options: clone(options) })
    queue = []
    return { application: application('approve_me', { status: 'approved', version: 2 }) }
  }
  const approval = page()
  await approval.onShow()
  approval.openApplication({ currentTarget: { dataset: { id: 'approve_me' } } })
  assert.deepEqual(approval.data.selectedVenueIds, ['venue_verified'])
  approval.changeFeaturedRank({ detail: { value: '25' } })
  await approval.approveApplication()
  assert(modal)
  assert(modal.title.includes('确认通过'))
  assert.equal(reviewCalls.length, 1)
  assert.deepEqual(reviewCalls[0].payload, {
    applicationId: 'approve_me',
    expectedVersion: 1,
    decision: 'approve',
    reason: '',
    venueIds: ['venue_verified'],
    verificationDate: approval.data.verificationDate || reviewCalls[0].payload.verificationDate,
    featuredRank: 25
  })
  assert(/^\d{4}-\d{2}-\d{2}$/.test(reviewCalls[0].payload.verificationDate))
  assert.equal(reviewCalls[0].options.retry, false)
  assert.equal(reviewCalls[0].options.requestId, 'request_coach_1')
  assert.equal(approval.data.detailVisible, false)
  assert.equal(template.includes('内部核验编号'), false)
  console.log('PASS 通过前关联授课球馆，内部审核标识由服务端生成')

  queue = [application('reject_me')]
  reviewCalls.length = 0
  reviewHandler = async (payload, options) => {
    reviewCalls.push({ payload: clone(payload), options: clone(options) })
    queue = []
    return { application: application('reject_me', { status: 'rejected', version: 2 }) }
  }
  const rejection = page()
  await rejection.onShow()
  rejection.openApplication({ currentTarget: { dataset: { id: 'reject_me' } } })
  rejection.beginReject()
  rejection.changeRejectionReason({ detail: { value: '短' } })
  await rejection.rejectApplication()
  assert.equal(reviewCalls.length, 0)
  assert(rejection.data.reasonError.includes('至少 2 个字'))
  rejection.changeRejectionReason({ detail: { value: '请补充可核验的执教经历' } })
  await rejection.rejectApplication()
  assert.equal(reviewCalls.length, 1)
  assert.deepEqual(reviewCalls[0].payload, {
    applicationId: 'reject_me', expectedVersion: 1, decision: 'reject', reason: '请补充可核验的执教经历'
  })
  console.log('PASS 驳回原因校验且不携带通过审核专属字段')

  queue = [application('conflict', { version: 1 })]
  let conflictWrites = 0
  reviewHandler = async () => {
    conflictWrites += 1
    throw error('VERSION_CONFLICT', { currentStatus: 'reviewing', currentVersion: 2 })
  }
  getHandler = async ({ applicationId }) => ({ application: application(applicationId, { version: 2 }) })
  const conflict = page()
  await conflict.onShow()
  conflict.openApplication({ currentTarget: { dataset: { id: 'conflict' } } })
  await conflict.approveApplication()
  assert.equal(conflictWrites, 1)
  assert.equal(conflict.data.selectedApplication.version, 2)
  assert.equal(conflict.data.conflictPending, false)
  assert.equal(conflict.data.outcomeUnknown, false)
  assert(conflict.data.detailError.includes('最新信息'))
  console.log('PASS 版本冲突只精确读取最新申请，不自动重放写操作')

  queue = [application('unknown')]
  const unknownRequests = []
  let unknownAttempt = 0
  reviewHandler = async (payload, options) => {
    unknownAttempt += 1
    unknownRequests.push(options.requestId)
    if (unknownAttempt === 1) throw error('REQUEST_TIMEOUT', { outcomeUnknown: true })
    queue = []
    return { application: application('unknown', { status: 'approved', version: 2 }) }
  }
  getHandler = async ({ applicationId }) => ({ application: application(applicationId) })
  const unknown = page()
  await unknown.onShow()
  unknown.openApplication({ currentTarget: { dataset: { id: 'unknown' } } })
  await unknown.approveApplication()
  assert.equal(unknown.data.outcomeUnknown, true)
  unknown.closeDetail()
  assert.equal(unknown.data.detailVisible, true)
  await unknown.syncSelectedStatus()
  assert.equal(unknown.data.outcomeUnknown, true)
  await unknown.retryUnknownReview()
  assert.deepEqual(unknownRequests, ['request_coach_1', 'request_coach_1'])
  assert.equal(unknown.data.detailVisible, false)
  console.log('PASS 弱网结果先精确同步，并以同一 requestId 安全重试原审核')

  queue = [application('read_race')]
  const staleRefresh = deferred()
  let raceReads = 0
  listHandler = async (payload) => {
    raceReads += 1
    if (raceReads === 2) return staleRefresh.promise
    return { items: queue, page: payload.page, pageSize: payload.pageSize, hasMore: false }
  }
  reviewHandler = async () => {
    queue = []
    return { application: application('read_race', { status: 'approved', version: 2 }) }
  }
  const race = page()
  await race.onShow()
  race.openApplication({ currentTarget: { dataset: { id: 'read_race' } } })
  const oldRefresh = race.loadPending({ preserve: true })
  await turn()
  await race.approveApplication()
  staleRefresh.resolve({ items: [application('read_race')], page: 1, pageSize: 20, hasMore: false })
  await oldRefresh
  assert(raceReads >= 3)
  assert.equal(race.data.items.some((item) => item.id === 'read_race'), false)
  console.log('PASS 审核写入作废旧列表响应，离页与并发读取不会恢复已处理项')

  queue = [application('unload_success')]
  listHandler = async (payload) => ({ items: queue, page: payload.page, pageSize: payload.pageSize, hasMore: false })
  venuesHandler = async () => ({ items: [verifiedVenue()] })
  const reviewAfterUnload = deferred()
  reviewHandler = async () => reviewAfterUnload.promise
  const unloaded = page()
  await unloaded.onShow()
  unloaded.openApplication({ currentTarget: { dataset: { id: 'unload_success' } } })
  const pendingAfterUnload = unloaded.approveApplication()
  await turn()
  unloaded.onUnload()
  let updatesAfterUnload = 0
  const unloadedSetData = unloaded.setData
  unloaded.setData = function trackedSetData(...args) {
    updatesAfterUnload += 1
    return unloadedSetData.apply(this, args)
  }
  const noticesBeforeResolve = notices.length
  reviewAfterUnload.resolve({ application: application('unload_success', { status: 'approved', version: 2 }) })
  await pendingAfterUnload
  assert.equal(updatesAfterUnload, 0)
  assert.equal(notices.length, noticesBeforeResolve)

  queue = [application('unload_sync')]
  const syncAfterUnload = deferred()
  getHandler = async () => syncAfterUnload.promise
  const syncing = page()
  await syncing.onShow()
  syncing.openApplication({ currentTarget: { dataset: { id: 'unload_sync' } } })
  syncing.setData({ outcomeUnknown: true })
  syncing.reviewAttempt = { applicationId: 'unload_sync', expectedVersion: 1, decision: 'reject', reason: '资料待补充', requestId: 'request_unload_sync' }
  const pendingSync = syncing.syncSelectedStatus()
  await turn()
  syncing.onUnload()
  let syncUpdatesAfterUnload = 0
  const syncingSetData = syncing.setData
  syncing.setData = function trackedSetData(...args) {
    syncUpdatesAfterUnload += 1
    return syncingSetData.apply(this, args)
  }
  syncAfterUnload.resolve({ application: application('unload_sync') })
  await pendingSync
  assert.equal(syncUpdatesAfterUnload, 0)
  console.log('PASS 审核与精确同步完成时若已卸载，不再更新页面或弹出结果提示')

  listHandler = async () => { throw error('FORBIDDEN') }
  const forbidden = page()
  await forbidden.onShow()
  assert.equal(forbidden.data.state, 'forbidden')
  assert.equal(forbidden.data.items.length, 0)
  console.log('PASS 页面直达仍由云端管理员接口鉴权')
}

run().catch((failure) => {
  console.error(failure)
  process.exitCode = 1
})
