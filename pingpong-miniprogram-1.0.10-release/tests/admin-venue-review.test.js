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
function submission(id, values = {}) {
  return Object.assign({
    id,
    name: `球馆 ${id}`,
    city: '杭州',
    activityTags: ['训练'],
    status: 'reviewing',
    version: 1,
    submitter: { playerId: `player_${id}`, displayName: `球友 ${id}` },
    submittedAt: '2026-09-10T10:00:00+08:00'
  }, values)
}

const api = {
  createRequestId() { requestSequence += 1; return `request_admin_${requestSequence}` },
  admin: {
    pendingVenueSubmissions(payload, options) { return listHandler(payload, options) },
    getVenueSubmission(payload, options) { return getHandler(payload, options) },
    reviewVenueSubmission(payload, options) { return reviewHandler(payload, options) }
  }
}

require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: api }
global.Page = (value) => { definition = value }
global.getApp = () => ({
  ensureSession: async () => ({ capabilities: { adminVenueReview: true } }),
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

delete require.cache[require.resolve(path.join(root, 'pages/admin-venue-review/admin-venue-review'))]
require(path.join(root, 'pages/admin-venue-review/admin-venue-review'))

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

async function run() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  const project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
  const template = fs.readFileSync(path.join(root, 'pages/admin-venue-review/admin-venue-review.wxml'), 'utf8')
  const style = fs.readFileSync(path.join(root, 'pages/admin-venue-review/admin-venue-review.wxss'), 'utf8')
  const profileSource = fs.readFileSync(path.join(root, 'pages/profile/profile.js'), 'utf8')
  const profileTemplate = fs.readFileSync(path.join(root, 'pages/profile/profile.wxml'), 'utf8')
  assert(app.pages.includes('pages/admin-venue-review/admin-venue-review'))
  assert(project.packOptions.include.some((item) => item.type === 'folder' && item.value === 'pages/admin-venue-review'))
  assert(template.startsWith('<view class="ui-screen">'))
  assert(template.includes('class="unknown-actions single-action"'))
  assert(!style.includes(':has('))
  assert(profileSource.includes('session.capabilities.adminVenueReview === true'))
  assert(profileTemplate.includes('wx:if="{{isAdmin}}" class="admin-review-row"'))
  assert(profileTemplate.includes('bindtap="openAdminVenueReview"'))
  assert.equal(require('../utils/request-policy').isRead('admin.venueSubmissions.get'), true)
  console.log('PASS 管理后台已注册，个人页只按服务端 capability 显示入口')

  let queue = [submission('first'), submission('second')]
  const listCalls = []
  listHandler = async (payload) => {
    listCalls.push(clone(payload))
    const start = (payload.page - 1) * payload.pageSize
    return { items: queue.slice(start, start + payload.pageSize), page: payload.page, pageSize: payload.pageSize, hasMore: start + payload.pageSize < queue.length }
  }
  reviewHandler = async () => ({})
  const loaded = page()
  await loaded.onShow()
  assert.equal(loaded.data.state, 'ready')
  assert.deepEqual(loaded.data.items.map((item) => item.id), ['first', 'second'])
  assert.equal(loaded.data.items[0].submitterName, '球友 first')
  assert.equal(listCalls[0].page, 1)
  assert.equal(listCalls[0].pageSize, 20)
  assert(template.includes('state === \'loading\''))
  assert(template.includes('state === \'error\''))
  assert(template.includes('state === \'forbidden\''))
  assert(template.includes('历史待审已清空'))
  assert(template.includes('新录入球馆已无需审核'))
  console.log('PASS 待审列表及加载、错误、无权限、空状态完整')

  queue = Array.from({ length: 21 }, (_, index) => submission(`page_${index + 1}`))
  const paged = page()
  await paged.onShow()
  assert.equal(paged.data.items.length, 20)
  assert.equal(paged.data.hasMore, true)
  await paged.loadMore()
  assert.equal(paged.data.items.length, 21)
  assert.equal(paged.data.page, 2)
  assert.equal(paged.data.hasMore, false)
  assert(template.includes("{{items.length}}{{hasMore ? '+' : ''}}"))
  console.log('PASS 后端返回 hasMore 时分页追加，计数不会伪装成总数')

  queue = [submission('approve_me')]
  const reviewCalls = []
  reviewHandler = async (payload, options) => {
    reviewCalls.push({ payload: clone(payload), options: clone(options) })
    queue = []
    return { submission: submission('approve_me', { status: 'approved', version: 2 }), venueCreated: true }
  }
  const approval = page()
  await approval.onShow()
  approval.openSubmission({ currentTarget: { dataset: { id: 'approve_me' } } })
  await approval.approveSubmission()
  assert(modal)
  assert(modal.title.includes('确认通过'))
  assert(modal.content.includes('立即公开'))
  assert.equal(reviewCalls.length, 1)
  assert.deepEqual(reviewCalls[0].payload, {
    submissionId: 'approve_me', expectedVersion: 1, decision: 'approve', reason: ''
  })
  assert.equal(reviewCalls[0].options.retry, false)
  assert(/^request_admin_1$/.test(reviewCalls[0].options.requestId))
  assert.equal(approval.data.detailVisible, false)
  assert.equal(approval.data.items.length, 0)
  console.log('PASS 通过审核有二次确认并携带版本与幂等请求编号')

  queue = [submission('reject_me')]
  reviewCalls.length = 0
  reviewHandler = async (payload, options) => {
    reviewCalls.push({ payload: clone(payload), options: clone(options) })
    queue = []
    return { submission: submission('reject_me', { status: 'rejected', version: 2 }) }
  }
  const rejection = page()
  await rejection.onShow()
  rejection.openSubmission({ currentTarget: { dataset: { id: 'reject_me' } } })
  rejection.beginReject()
  rejection.changeRejectionReason({ detail: { value: '短' } })
  await rejection.rejectSubmission()
  assert.equal(reviewCalls.length, 0)
  assert(rejection.data.reasonError.includes('至少 2 个字'))
  rejection.changeRejectionReason({ detail: { value: '请填写地图上的完整名称' } })
  await rejection.rejectSubmission()
  assert.equal(reviewCalls.length, 1)
  assert.equal(reviewCalls[0].payload.reason, '请填写地图上的完整名称')
  assert.equal(reviewCalls[0].payload.decision, 'reject')
  console.log('PASS 驳回原因在客户端校验并将明确建议提交云端')

  queue = [submission('conflict', { version: 1 })]
  let conflictWrites = 0
  let conflictReads = 0
  listHandler = async (payload) => {
    conflictReads += 1
    return { items: queue, page: payload.page, pageSize: payload.pageSize, hasMore: false }
  }
  getHandler = async ({ submissionId }) => {
    conflictReads += 1
    return { submission: queue.find((item) => item.id === submissionId) || null, venue: null }
  }
  reviewHandler = async () => {
    conflictWrites += 1
    queue = [submission('conflict', { version: 2 })]
    throw error('VERSION_CONFLICT', { currentStatus: 'reviewing', currentVersion: 2 })
  }
  const conflict = page()
  await conflict.onShow()
  conflict.openSubmission({ currentTarget: { dataset: { id: 'conflict' } } })
  await conflict.approveSubmission()
  assert.equal(conflictWrites, 1)
  assert.equal(conflictReads, 2)
  assert.equal(conflict.data.selectedSubmission.version, 2)
  assert.equal(conflict.data.conflictPending, false)
  assert.equal(conflict.data.outcomeUnknown, false)
  assert(conflict.data.detailError.includes('最新信息'))
  console.log('PASS VERSION_CONFLICT 只读刷新最新版本，不自动重放审核写操作')

  queue = Array.from({ length: 60 }, (_, index) => submission(`large_${index + 1}`))
  listHandler = async (payload) => ({ items: queue.slice(0, payload.pageSize), page: 1, pageSize: payload.pageSize, hasMore: true })
  getHandler = async ({ submissionId }) => ({ submission: submission(submissionId, { status: 'approved', version: 2 }), venue: { id: 'venue_large' } })
  const precise = page()
  await precise.onShow()
  precise.openSubmission({ currentTarget: { dataset: { id: 'large_1' } } })
  precise.setData({ outcomeUnknown: true, detailError: '结果待确认' })
  precise.reviewAttempt = { submissionId: 'large_1', expectedVersion: 1, decision: 'approve', reason: '', requestId: 'request_precise' }
  await precise.syncSelectedStatus()
  assert.equal(precise.data.detailVisible, false)
  assert.equal(precise.data.items.some((item) => item.id === 'large_1'), false)
  assert.equal(precise.data.hasMore, true)
  console.log('PASS 精确详情接口确认审核结果，不以待审前 50 条缺席作推断')

  queue = [submission('unknown')]
  const unknownRequests = []
  let unknownAttempt = 0
  listHandler = async (payload) => ({ items: queue, page: payload.page, pageSize: payload.pageSize, hasMore: false })
  reviewHandler = async (payload, options) => {
    unknownAttempt += 1
    unknownRequests.push(options.requestId)
    if (unknownAttempt === 1) throw error('REQUEST_TIMEOUT', { outcomeUnknown: true })
    queue = []
    return { submission: submission('unknown', { status: 'approved', version: 2 }), venueCreated: true }
  }
  const unknown = page()
  await unknown.onShow()
  unknown.openSubmission({ currentTarget: { dataset: { id: 'unknown' } } })
  await unknown.approveSubmission()
  assert.equal(unknown.data.outcomeUnknown, true)
  assert.equal(unknown.data.detailVisible, true)
  unknown.closeDetail()
  assert.equal(unknown.data.detailVisible, true)
  await unknown.retryUnknownReview()
  assert.deepEqual(unknownRequests, ['request_admin_1', 'request_admin_1'])
  assert.equal(unknown.data.outcomeUnknown, false)
  assert.equal(unknown.data.detailVisible, false)
  console.log('PASS 不确定结果锁定决策并以同一 requestId 安全重试')

  queue = [submission('read_race')]
  const staleRefresh = deferred()
  let raceReads = 0
  listHandler = async (payload) => {
    raceReads += 1
    if (raceReads === 2) return staleRefresh.promise
    return { items: queue, page: payload.page, pageSize: payload.pageSize, hasMore: false }
  }
  reviewHandler = async () => {
    queue = []
    return { submission: submission('read_race', { status: 'approved', version: 2 }), venueCreated: true }
  }
  const race = page()
  await race.onShow()
  race.openSubmission({ currentTarget: { dataset: { id: 'read_race' } } })
  const oldRefresh = race.loadPending({ preserve: true })
  await turn()
  await race.approveSubmission()
  staleRefresh.resolve({ items: [submission('read_race')], page: 1, pageSize: 20, hasMore: false })
  await oldRefresh
  assert(raceReads >= 3)
  assert.equal(race.data.items.some((item) => item.id === 'read_race'), false)
  console.log('PASS 审核写入会作废更早的列表读取，旧响应不会把待审项插回')

  queue = [submission('cached')]
  listHandler = async (payload) => ({ items: queue, page: payload.page, pageSize: payload.pageSize, hasMore: false })
  const resilient = page()
  await resilient.onShow()
  listHandler = async () => { throw error('SERVICE_UNAVAILABLE') }
  await resilient.loadPending({ preserve: true })
  assert.deepEqual(resilient.data.items.map((item) => item.id), ['cached'])
  assert(resilient.data.syncError)
  console.log('PASS 列表刷新失败保留上次结果并提供重试入口')

  const stale = deferred()
  let staleCalls = 0
  listHandler = async () => {
    staleCalls += 1
    return staleCalls === 1 ? stale.promise : { items: [submission('fresh')], page: 1, pageSize: 20, hasMore: false }
  }
  const lifecycle = page()
  const oldLoad = lifecycle.onShow()
  await turn()
  lifecycle.onHide()
  const freshLoad = lifecycle.onShow()
  await freshLoad
  stale.resolve({ items: [submission('stale')], page: 1, pageSize: 20, hasMore: false })
  await oldLoad
  assert.equal(staleCalls, 2)
  assert.deepEqual(lifecycle.data.items.map((item) => item.id), ['fresh'])
  console.log('PASS 离页作废请求后重新进入会真正发起新请求')

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
