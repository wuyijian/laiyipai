const assert = require('assert')
const path = require('path')
const fs = require('fs')
const root = path.resolve(__dirname, '..')
let definition
let sequence = 0
let navigation = []
const memory = {}
const clone = (value) => JSON.parse(JSON.stringify(value))
const venue = (id = 'venue_new') => ({ id, name: '新录入球馆', city: '杭州', listingMode: 'name_only', userContributed: true, activityTags: [], coverFileIds: [] })
const submission = (status = 'reviewing', values = {}) => Object.assign({
  id: 'submission_new', venueId: status === 'approved' ? 'venue_new' : '', name: '新录入球馆', city: '杭州',
  activityTags: ['训练'], status, rejectionReason: status === 'rejected' ? '名称无法确认' : '', version: 1
}, values)
const input = (value) => ({ detail: { value } })
const error = (code) => Object.assign(new Error(code), { code })
const turn = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const api = {
  createRequestId: () => `request_${++sequence}`,
  venues: {
    list: async () => ({ items: [] }),
    get: async ({ venueId }) => venue(venueId),
    create: async () => ({ submission: submission(), venue: null, created: true, duplicateExisting: false }),
    submissions: {
      list: async () => ({ items: [] }),
      get: async () => ({ submission: submission(), venue: null }),
      resubmit: async () => ({ submission: submission(), venue: null })
    }
  }
}
global.Page = (value) => { definition = value }
global.getApp = () => ({ ensureSession: async () => ({}) })
global.wx = {
  hideShareMenu() {}, pageScrollTo() {}, showToast() {},
  getStorageSync: (key) => memory[key], setStorageSync: (key, value) => { memory[key] = clone(value) }, removeStorageSync: (key) => { delete memory[key] },
  navigateBack: (options) => navigation.push({ type: 'back', options }),
  redirectTo: (options) => navigation.push({ type: 'redirect', options }),
  navigateTo: (options) => navigation.push({ type: 'to', options }),
  switchTab: (options) => navigation.push({ type: 'tab', options })
}
const apiFile = require.resolve(path.join(root, 'utils/api'))
require.cache[apiFile] = { id: apiFile, filename: apiFile, loaded: true, exports: api }
function page(name = 'venue-create') {
  const filename = require.resolve(path.join(root, `pages/${name}/${name}`))
  delete require.cache[filename]
  require(filename)
  const result = Object.assign({}, definition, { data: clone(definition.data) })
  result.setData = function (patch, done) { Object.assign(this.data, patch); if (done) done() }
  return result
}
function form(from = '') { const result = page(); result.onLoad({ from }); result.changeName(input('新录入球馆')); return result }

async function run() {
  const project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
  assert(project.packOptions.include.some((item) => item.type === 'folder' && item.value === 'pages/venue-create'), '新页面必须显式打包，避免开发工具未使用文件过滤误判')
  const policy = require('../utils/request-policy')
  assert.strictEqual(policy.isRead('venues.submissions.list'), true)
  assert.strictEqual(policy.isRead('venues.submissions.get'), true)
  assert.strictEqual(policy.isRead('admin.venueSubmissions.pending'), true)
  assert.strictEqual(policy.isRead('admin.venueSubmissions.get'), true)
  assert.strictEqual(policy.isRead('venues.submissions.resubmit'), false)
  const apiSource = fs.readFileSync(path.join(root, 'utils/api.js'), 'utf8')
  assert(apiSource.includes("pendingVenueSubmissions: action('admin.venueSubmissions.pending')"))
  assert(apiSource.includes("getVenueSubmission: action('admin.venueSubmissions.get')"))
  assert(apiSource.includes("reviewVenueSubmission: action('admin.venueSubmissions.review')"))
  console.log('PASS 审核进度按只读请求处理，重提与运营审核保持写操作')
  let calls = []
  let pending = deferred()
  api.venues.create = async (payload, options) => { calls.push({ payload: clone(payload), options }); return pending.promise }
  const draft = form('publish')
  draft.changeAddress(input('江南大道 88 号 2 楼'))
  draft.changeDistrict(input(1))
  const events = []
  draft.getOpenerEventChannel = () => ({ emit: (name, data) => events.push({ name, data }) })
  draft.toggleTag({ currentTarget: { dataset: { value: '训练' } } })
  const saving = draft.save()
  draft.save()
  draft.changeName(input('不应生效'))
  draft.changeAddress(input('不应在提交期间修改'))
  await turn()
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(draft.data.name, '新录入球馆')
  assert.strictEqual(draft.data.address, '江南大道 88 号 2 楼')
  assert.strictEqual(calls[0].payload.address, draft.data.address)
  assert.strictEqual(calls[0].payload.district, '滨江区')
  assert.strictEqual(calls[0].options.retry, false)
  assert.deepStrictEqual(calls[0].payload.activityTags, ['训练'])
  pending.resolve({
    submission: submission('approved', { venueId: 'venue_new' }),
    venue: venue(),
    created: true,
    venueCreated: true,
    duplicateExisting: false
  })
  await saving
  assert.strictEqual(draft.data.submission, null)
  assert.strictEqual(draft.data.savedVenue.id, 'venue_new')
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].name, 'venueCreated')
  assert.strictEqual(events[0].data.venue.id, 'venue_new')
  assert.strictEqual(navigation.length, 1)
  assert.strictEqual(navigation[0].type, 'back')
  await draft.save()
  assert.strictEqual(calls.length, 1)
  const defensivePending = form('publish')
  defensivePending.attempt = { type: 'create' }
  defensivePending.applyResult({ submission: submission('reviewing'), venue: venue('must_not_select'), created: true })
  assert.strictEqual(defensivePending.data.savedVenue, null)
  assert.strictEqual(defensivePending.data.submission, null)
  assert(defensivePending.data.errorMessage.includes('旧审核流程'))
  console.log('PASS 保存防连点，直接录入成功后立即回传发布页，旧审核响应不伪装成功')

  navigation = []
  const defaultGetApp = global.getApp
  let resumedWrites = 0
  const loginApp = {
    globalData: { session: null },
    ensureSession: async () => {
      if (!loginApp.globalData.session) throw error('LOGIN_REQUIRED')
      return loginApp.globalData.session
    }
  }
  global.getApp = () => loginApp
  api.venues.create = async () => {
    resumedWrites += 1
    return { submission: submission('approved', { venueId: 'venue_after_login' }), venue: venue('venue_after_login'), created: true }
  }
  const resumed = form('publish')
  const resumedEvents = []
  resumed.getOpenerEventChannel = () => ({ emit: (name, data) => resumedEvents.push({ name, data }) })
  await resumed.save()
  assert.strictEqual(resumedWrites, 0)
  assert.strictEqual(resumed.data.errorMessage, '')
  loginApp.globalData.session = { profile: { playerId: 'player-returning' } }
  await resumed.onShow()
  assert.strictEqual(resumedWrites, 1)
  assert.strictEqual(resumedEvents[0].data.venue.id, 'venue_after_login')
  assert.strictEqual(navigation.pop().type, 'back')

  loginApp.globalData.session = null
  const cancelled = form()
  await cancelled.save()
  await cancelled.onShow()
  loginApp.globalData.session = { profile: { playerId: 'player-later' } }
  await cancelled.onShow()
  assert.strictEqual(resumedWrites, 1, '选择先逛逛后，未来登录不能补做旧的球馆保存')
  global.getApp = defaultGetApp
  console.log('PASS 录入球馆登录返回后接续保存，取消登录不会延迟写入')

  navigation = []
  api.venues.create = async () => ({ venue: venue('legacy_existing'), created: false })
  const legacyExisting = form('publish')
  const existingEvents = []
  legacyExisting.getOpenerEventChannel = () => ({ emit: (name, data) => existingEvents.push({ name, data }) })
  await legacyExisting.save()
  assert.strictEqual(legacyExisting.data.savedVenue.id, 'legacy_existing')
  assert.strictEqual(legacyExisting.data.reused, true)
  assert.strictEqual(existingEvents[0].data.venue.id, 'legacy_existing')
  assert.strictEqual(navigation.pop().type, 'back')
  api.venues.create = async () => ({ venue: venue('legacy_created'), created: true })
  const legacyCreated = form('publish')
  const legacyEvents = []
  legacyCreated.getOpenerEventChannel = () => ({ emit: (name, data) => legacyEvents.push({ name, data }) })
  await legacyCreated.save()
  assert.strictEqual(legacyCreated.data.savedVenue.id, 'legacy_created')
  assert.strictEqual(legacyCreated.data.submission, null)
  assert.strictEqual(legacyCreated.data.errorMessage, '')
  assert.strictEqual(legacyEvents[0].data.venue.id, 'legacy_created')
  assert.strictEqual(navigation.pop().type, 'back')
  console.log('PASS 兼容直接返回球馆的服务端响应并自动回填')

  let unlockCalls = 0
  api.venues.create = async () => {
    unlockCalls += 1
    if (unlockCalls === 1) throw error('REQUEST_TIMEOUT')
    throw error('CONTENT_REJECTED')
  }
  const unlock = form()
  await unlock.save()
  assert.strictEqual(unlock.data.outcomeUnknown, true)
  await unlock.save()
  assert.strictEqual(unlock.data.outcomeUnknown, false)
  assert.strictEqual(unlock.attempt, null)
  unlock.changeName(input('明确失败后可以修改'))
  assert.strictEqual(unlock.data.name, '明确失败后可以修改')
  console.log('PASS 未知结果重试若明确失败，会解除锁定并允许修改')

  calls = []
  api.venues.create = async (payload, options) => {
    calls.push({ payload: clone(payload), options })
    if (calls.length === 1) throw error('REQUEST_TIMEOUT')
    return { submission: null, venue: venue(), created: false, duplicateExisting: true }
  }
  const retry = form()
  retry.changeAddress(input('江南大道 88 号'))
  await retry.save()
  assert.strictEqual(retry.data.outcomeUnknown, true)
  retry.changeName(input('不能更改未确认请求'))
  retry.changeAddress(input('不能更改未确认地址'))
  retry.changeDistrict(input(2))
  retry.toggleTag({ currentTarget: { dataset: { value: '比赛' } } })
  await retry.save()
  assert.strictEqual(calls.length, 2)
  assert.deepStrictEqual(calls[1], calls[0])
  assert.strictEqual(calls[1].payload.address, '江南大道 88 号')
  assert.strictEqual(calls[1].payload.district, '')
  assert.strictEqual(retry.data.reused, true)
  assert.strictEqual(navigation.length, 0)
  await retry.save()
  const destination = navigation.pop()
  assert(destination.options.url.endsWith('id=venue_new'))
  destination.options.fail()
  await retry.save()
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(navigation.pop().type, 'redirect')
  console.log('PASS 结果未知保留原请求，重复公开馆明确选用且不重复提交')

  navigation = []
  for (const code of ['CONTENT_REJECTED', 'ACTION_NOT_FOUND']) {
    api.venues.create = async () => { throw error(code) }
    const failed = form()
    await failed.save()
    assert.strictEqual(failed.data.savedVenue, null)
    assert.strictEqual(failed.data.outcomeUnknown, false)
    assert.strictEqual(failed.attempt, null)
    assert.strictEqual(failed.data.name, '新录入球馆')
    if (code === 'ACTION_NOT_FOUND') assert(failed.data.errorMessage.includes('更新 api 云函数'))
    failed.changeName(input('可修改再试'))
    assert.strictEqual(failed.data.name, '可修改再试')
  }
  api.venues.create = async () => ({})
  const incomplete = form()
  await incomplete.save()
  assert.strictEqual(incomplete.data.savedVenue, null)
  assert.strictEqual(incomplete.data.outcomeUnknown, true)
  assert.strictEqual(navigation.length, 0)
  console.log('PASS 保存失败、旧云函数、缺失响应均不显示虚假成功')

  const originalGetApp = global.getApp
  let passiveSessionChecks = 0
  let publicListOptions
  let publicGetOptions
  global.getApp = () => ({
    globalData: { session: null },
    ensureSession: async () => { passiveSessionChecks += 1; throw error('LOGIN_REQUIRED') }
  })
  api.venues.list = async (_payload, options) => { publicListOptions = options; return { items: [venue('guest_existing')] } }
  api.venues.get = async ({ venueId }, options) => { publicGetOptions = options; return venue(venueId) }
  const guestLookup = form()
  await guestLookup.searchExisting()
  assert.strictEqual(guestLookup.data.suggestions[0].id, 'guest_existing')
  await guestLookup.useExisting({ currentTarget: { dataset: { id: 'guest_existing' } } })
  assert.strictEqual(passiveSessionChecks, 0)
  assert.strictEqual(publicListOptions.publicRead, true)
  assert.strictEqual(publicGetOptions.publicRead, true)
  assert(navigation.pop().options.url.endsWith('id=guest_existing'))
  global.getApp = originalGetApp
  console.log('PASS 游客可先查重并查看已有球馆，不被登录打断')

  pending = deferred()
  api.venues.list = async () => pending.promise
  const search = form()
  const searching = search.searchExisting()
  await turn()
  search.changeName(input('另一个球馆'))
  pending.resolve({ items: [venue('stale')] })
  await searching
  assert.deepStrictEqual(search.data.suggestions, [])
  assert.strictEqual(search.data.searchState, 'idle')
  pending = deferred()
  const leaving = search.searchExisting()
  await turn()
  search.onUnload()
  pending.resolve({ items: [venue('late')] })
  await leaving
  assert.deepStrictEqual(search.data.suggestions, [])
  console.log('PASS 旧搜索结果与离页后的响应不会覆盖当前状态')

  api.venues.create = async () => { throw new Error('不应创建已有球馆') }
  api.venues.get = async ({ venueId }) => venue(venueId)
  const existing = form()
  existing.setData({ suggestions: [venue('existing')] })
  await existing.useExisting({ currentTarget: { dataset: { id: 'existing' } } })
  assert.strictEqual(existing.data.savedVenue.id, 'existing')
  assert.strictEqual(existing.data.reused, true)
  assert(navigation.pop().options.url.endsWith('id=existing'))
  console.log('PASS 选用已有记录只查询，不创建、不覆盖')

  let resubmitCall
  api.venues.submissions.get = async () => ({ submission: submission('rejected'), venue: null })
  api.venues.submissions.resubmit = async (payload, options) => {
    resubmitCall = { payload: clone(payload), options }
    return { submission: submission('reviewing', { version: 2, activityTags: ['训练', '切磋'] }), venue: null }
  }
  const rejected = page()
  rejected.onLoad({ submissionId: 'submission_new' })
  await turn()
  await turn()
  assert.strictEqual(rejected.data.submission.status, 'rejected')
  assert.strictEqual(rejected.data.submission.rejectionReason, '名称无法确认')
  rejected.editRejected()
  assert.strictEqual(rejected.data.editingRejected, true)
  rejected.changeName(input('不允许在原申请改名'))
  assert.strictEqual(rejected.data.name, '新录入球馆')
  rejected.toggleTag({ currentTarget: { dataset: { value: '切磋' } } })
  await rejected.save()
  assert.strictEqual(resubmitCall.payload.submissionId, 'submission_new')
  assert.strictEqual(resubmitCall.payload.expectedVersion, 1)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(resubmitCall.payload, 'name'), false)
  assert.deepStrictEqual(resubmitCall.payload.activityTags, ['训练', '切磋'])
  assert.strictEqual(rejected.data.submission.status, 'reviewing')
  assert.strictEqual(rejected.data.editingRejected, false)
  assert.strictEqual(navigation.length, 0, '驳回重提不应自动跳转或回填发布页')
  console.log('PASS 驳回原因可查看，仅修改允许字段并带版本号重新提交')

  let conflictWrites = 0
  let conflictReads = 0
  api.venues.submissions.resubmit = async () => {
    conflictWrites += 1
    const conflictError = error('VERSION_CONFLICT')
    conflictError.details = { outcomeUnknown: true }
    throw conflictError
  }
  api.venues.submissions.get = async () => {
    conflictReads += 1
    return { submission: submission('rejected', { version: 2, rejectionReason: '请去掉简称' }), venue: null }
  }
  const conflict = page()
  conflict.onLoad()
  conflict.submissionId = 'submission_new'
  conflict.setData({ submission: submission('rejected'), name: '新录入球馆', editingRejected: true })
  await conflict.save()
  assert.strictEqual(conflictWrites, 1)
  assert.strictEqual(conflictReads, 1)
  assert.strictEqual(conflict.data.submission.version, 2)
  assert.strictEqual(conflict.data.submission.rejectionReason, '请去掉简称')
  assert.strictEqual(conflict.data.editingRejected, false)
  assert.strictEqual(conflict.data.outcomeUnknown, false)
  assert.strictEqual(conflict.attempt, null)

  api.venues.submissions.get = async () => {
    conflictReads += 1
    throw error('NETWORK_ERROR')
  }
  const conflictRecovery = page()
  conflictRecovery.onLoad()
  conflictRecovery.submissionId = 'submission_new'
  conflictRecovery.setData({ submission: submission('rejected'), name: '新录入球馆', editingRejected: true })
  await conflictRecovery.save()
  assert.strictEqual(conflictWrites, 2)
  assert.strictEqual(conflictReads, 2)
  assert.strictEqual(conflictRecovery.data.outcomeUnknown, false)
  assert.strictEqual(conflictRecovery.attempt, null)
  assert(conflictRecovery.data.submissionLoadError)
  const venueCreateTemplate = fs.readFileSync(path.join(root, 'pages/venue-create/venue-create.wxml'), 'utf8')
  assert(venueCreateTemplate.includes('bindtap="loadSubmission"'), '版本冲突刷新失败后必须保留可见重试入口')
  assert(venueCreateTemplate.includes('保存并关联授课球馆'))
  navigation = []
  const coachReviewEntry = form('coach-review')
  coachReviewEntry.setData({ savedVenue: venue() })
  coachReviewEntry.continueWithVenue()
  assert.strictEqual(coachReviewEntry.data.fromCoachReview, true)
  assert.strictEqual(navigation[0].type, 'back')
  console.log('PASS 教练审核录入球馆后直接返回关联页，不绕到球馆详情')
  api.venues.submissions.get = async () => ({ submission: submission('rejected', { version: 3 }), venue: null })
  await conflictRecovery.loadSubmission()
  assert.strictEqual(conflictRecovery.data.submission.version, 3)
  assert.strictEqual(conflictRecovery.data.submissionLoadError, '')
  assert.strictEqual(conflictWrites, 2, '恢复入口只能读取最新状态，不能重放写操作')
  console.log('PASS 重提版本冲突只读刷新，刷新失败保留恢复入口且不重放写操作')

  api.venues.submissions.list = async () => ({ items: [
    submission('reviewing'),
    submission('rejected', { id: 'submission_rejected', name: '待修改球馆', rejectionReason: '名称不完整' }),
    submission('approved', { id: 'submission_approved', name: '已公开球馆' })
  ] })
  const profile = page('profile')
  await profile.loadVenueSubmissions()
  assert.deepStrictEqual(profile.data.venueSubmissions.map((item) => item.statusLabel), ['处理中', '需修改', '已处理'])
  assert(profile.data.venueSubmissions[1].statusCopy.includes('名称不完整'))
  profile.openVenueSubmission({ currentTarget: { dataset: { id: 'submission_rejected' } } })
  assert(navigation.pop().options.url.includes('submissionId=submission_rejected'))
  console.log('PASS 我的页面展示本人提交状态、驳回原因并可进入处理')

  const firstSubmissionRead = deferred()
  const latestSubmissionRead = deferred()
  let submissionReadCount = 0
  api.venues.submissions.list = async () => {
    submissionReadCount += 1
    return submissionReadCount === 1 ? firstSubmissionRead.promise : latestSubmissionRead.promise
  }
  const concurrentProfile = page('profile')
  concurrentProfile.onLoad()
  const firstRead = concurrentProfile.loadVenueSubmissions()
  const latestRead = concurrentProfile.loadVenueSubmissions()
  latestSubmissionRead.resolve({ items: [submission('approved', { id: 'latest_submission', name: '最新球馆' })] })
  await latestRead
  firstSubmissionRead.resolve({ items: [submission('rejected', { id: 'stale_submission', name: '旧球馆' })] })
  await firstRead
  assert.deepStrictEqual(concurrentProfile.data.venueSubmissions.map((item) => item.id), ['latest_submission'])

  const leavingRead = deferred()
  api.venues.submissions.list = async () => leavingRead.promise
  const leavingProfile = page('profile')
  leavingProfile.onLoad()
  const leavingTask = leavingProfile.loadVenueSubmissions()
  leavingProfile.onUnload()
  leavingRead.resolve({ items: [submission('approved', { id: 'late_after_unload' })] })
  await leavingTask
  assert.deepStrictEqual(leavingProfile.data.venueSubmissions, [])
  console.log('PASS 我的球馆提交忽略旧代次和离页后的响应')

  api.venues.submissions.list = async () => ({ items: [submission('reviewing', { id: 'cached_submission', name: '保留的球馆' })] })
  const resilientProfile = page('profile')
  resilientProfile.onLoad()
  await resilientProfile.loadVenueSubmissions()
  api.venues.submissions.list = async () => { throw error('SERVICE_UNAVAILABLE') }
  await resilientProfile.loadVenueSubmissions()
  assert.deepStrictEqual(resilientProfile.data.venueSubmissions.map((item) => item.id), ['cached_submission'])
  assert.strictEqual(resilientProfile.data.venueSubmissionsState, 'error')
  api.venues.submissions.list = async () => { throw error('ACTION_NOT_FOUND') }
  await resilientProfile.loadVenueSubmissions()
  assert.deepStrictEqual(resilientProfile.data.venueSubmissions.map((item) => item.id), ['cached_submission'])
  assert.strictEqual(resilientProfile.data.venueSubmissionsState, 'error')
  const profileTemplate = fs.readFileSync(path.join(root, 'pages/profile/profile.wxml'), 'utf8')
  assert(profileTemplate.includes('更新失败，当前显示上次结果'))
  assert(profileTemplate.includes('bindtap="loadVenueSubmissions"'))
  assert(profileTemplate.includes('历史球馆记录'))
  console.log('PASS 审核列表刷新失败保留上次结果，并明确标记待更新与重试入口')

  assert(venueCreateTemplate.includes('保存后立即加入球馆库'))
  assert(venueCreateTemplate.includes('保存并用于本次球局'))
  assert(!venueCreateTemplate.includes('提交后先由平台审核'))
  assert(!venueCreateTemplate.includes("'提交审核'"))
  console.log('PASS 新录入页面明确保存即用，审核文案仅保留在历史状态区')

  pending = deferred()
  api.venues.list = async () => pending.promise
  const publish = page('publish')
  publish.setData({ title: '练球草稿', date: '2099-09-12', startTime: '19:00', endTime: '21:00', capacity: 6, courtStatus: 'booked' })
  const loading = publish.loadVenues()
  await turn()
  publish.openVenueCreate()
  const opener = navigation.pop().options
  assert(opener.url.includes('from=publish'))
  opener.events.venueCreated({ venue: venue() })
  pending.resolve({ items: [venue('old_list')] })
  await loading
  assert.strictEqual(publish.data.venueId, 'venue_new')
  assert.strictEqual(publish.data.selectedVenue.id, 'venue_new')
  assert.strictEqual(publish.data.loadState, 'ready')
  assert.strictEqual(publish.data.title, '练球草稿')
  assert.strictEqual(publish.data.capacity, 6)
  assert.strictEqual(publish.data.date, '2099-09-12')
  assert.strictEqual(publish.data.startTime, '19:00')
  assert.strictEqual(publish.data.endTime, '21:00')
  assert.strictEqual(publish.data.courtStatus, 'unbooked')
  assert.strictEqual(require('../utils/client-state').getPublishDraft().venueId, 'venue_new')
  console.log('PASS 新球馆回传保留发布草稿，过期列表响应不能撤销选中项')

  api.venues.list = async () => ({ items: Array.from({ length: 50 }, (_, i) => venue(`existing_${i}`)) })
  const restored = page('publish')
  restored.setData({ venueId: 'venue_beyond_page_1' })
  await restored.loadVenues()
  assert.strictEqual(restored.data.selectedVenue.id, 'venue_beyond_page_1')
  assert.strictEqual(restored.data.venues.length, 51)
  api.venues.get = async () => { throw error('NETWORK_ERROR') }
  restored.setData({ venues: [] })
  await restored.loadVenues()
  assert.strictEqual(restored.data.loadState, 'error')
  assert.strictEqual(restored.data.venueId, 'venue_beyond_page_1')
  api.venues.get = async () => { throw error('NOT_FOUND') }
  await restored.loadVenues()
  assert.strictEqual(restored.data.venueId, '')
  assert.strictEqual(restored.data.selectedVenue, null)
  console.log('PASS 列表前 50 条之外仍可选用，仅明确下架时清除选择')

  api.venues.list = async () => ({ items: [] })
  api.venues.get = async ({ venueId }) => venue(venueId)
  const empty = page('publish')
  empty.setData({ loadState: 'ready' })
  empty.applyPrefill({ venueId: 'venue_new' })
  await empty.loadVenues()
  assert.strictEqual(empty.data.selectedVenue.id, 'venue_new')
  console.log('PASS 先前空列表也能接收球馆详情页的发布入口')
}

run().catch((failure) => { console.error(failure); process.exitCode = 1 })
