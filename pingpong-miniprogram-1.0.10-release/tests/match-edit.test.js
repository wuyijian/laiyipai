const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
let definition
let sequence = 0
const clone = (value) => JSON.parse(JSON.stringify(value))
const codedError = (code) => Object.assign(new Error(code), { code })
const toasts = []
const navigations = []
const timers = []

const originalSetTimeout = global.setTimeout
const originalClearTimeout = global.clearTimeout
global.setTimeout = (callback) => {
  const timer = { callback, cleared: false }
  timers.push(timer)
  return timer
}
global.clearTimeout = (timer) => { if (timer) timer.cleared = true }

const match = (patch = {}) => Object.assign({
  id: 'match_1', venueId: 'venue_1', venue: { id: 'venue_1', name: '滨江球馆', listingMode: 'name_only' },
  title: '晚上一起练球', date: '2099-09-12', startTime: '19:00', endTime: '21:00',
  startAt: '2099-09-12T11:00:00.000Z', capacity: 4, participantCount: 2,
  expectedBallAge: '不限球龄', practiceIntent: '随便练练', joinMode: 'direct',
  courtStatus: 'booked', feePerPerson: 30, note: '', status: 'full', version: 3
}, patch)

let serverMatch = match()
let getFailure = null
let venueItems = [
  { id: 'venue_1', name: '滨江球馆', city: '杭州', listingMode: 'name_only', activityTags: [] },
  { id: 'venue_2', name: '萧山球馆', city: '杭州', listingMode: 'name_only', activityTags: [] }
]
let updateCalls = []
let updateHandler = async () => ({ match: match({ version: 4 }), noop: false })
const api = {
  createRequestId: () => `request_${++sequence}`,
  matches: {
    get: async () => {
      if (getFailure) throw getFailure
      return { match: serverMatch, membership: { status: 'host' } }
    },
    update: async (payload, options) => {
      updateCalls.push({ payload: clone(payload), options })
      return updateHandler(payload, options)
    }
  },
  venues: {
    list: async () => ({ items: venueItems }),
    get: async () => null
  }
}

global.Page = (value) => { definition = value }
global.getApp = () => ({ ensureSession: async () => ({}) })
global.wx = {
  showToast: (options) => toasts.push(options),
  navigateBack: () => navigations.push('back'),
  hideShareMenu() {}
}
const apiFile = require.resolve(path.join(root, 'utils/api'))
require.cache[apiFile] = { id: apiFile, filename: apiFile, loaded: true, exports: api }

function page() {
  const filename = require.resolve(path.join(root, 'pages/match-edit/match-edit'))
  delete require.cache[filename]
  require(filename)
  const result = Object.assign({}, definition, { data: clone(definition.data) })
  result.setData = function (patch, done) { Object.assign(this.data, patch); if (done) done() }
  return result
}

async function editor(loaded = match()) {
  serverMatch = loaded
  getFailure = null
  venueItems = [
    { id: 'venue_1', name: '滨江球馆', city: '杭州', listingMode: 'name_only', activityTags: [] },
    { id: 'venue_2', name: '萧山球馆', city: '杭州', listingMode: 'name_only', activityTags: [] }
  ]
  updateCalls = []
  updateHandler = async () => ({ match: match({ version: 4 }), noop: false })
  const result = page()
  result.onLoad({ id: 'match_1' })
  await result.loading
  return result
}

async function run() {
  const editMarkup = fs.readFileSync(path.join(root, 'pages/match-edit/match-edit.wxml'), 'utf8')
  const detailMarkup = fs.readFileSync(path.join(root, 'pages/match-detail/match-detail.wxml'), 'utf8')
  assert(editMarkup.includes('见面备注') && editMarkup.includes('data-field="title"'), '编辑页应保留 1.0.7 的自由标题和备注')
  assert(detailMarkup.includes('match.note') && detailMarkup.includes('match.courtBookingNote'), '详情页应展示已审核通过版本支持的备注')
  console.log('PASS 编辑能力覆盖结构化字段、球局标题和见面备注')

  const ready = await editor()
  assert.strictEqual(ready.data.state, 'ready')
  assert.strictEqual(ready.data.dirty, false)
  await ready.save()
  assert.strictEqual(updateCalls.length, 0, '未修改内容不应发送更新请求')
  assert.strictEqual(toasts.at(-1).title, '没有需要保存的修改')
  console.log('PASS 未修改内容不会产生无效写入')

  const reset = await editor()
  reset.changeStart({ detail: { value: '20:00' } })
  assert.strictEqual(reset.data.arrangementChanged, true)
  assert.strictEqual(reset.data.courtStatus, 'unbooked', '改时间必须清除原订台状态')
  assert(reset.data.courtResetNotice.includes('重新确认球台'))
  reset.changeStart({ detail: { value: '19:00' } })
  assert.strictEqual(reset.data.arrangementChanged, false)
  assert.strictEqual(reset.data.courtStatus, 'booked', '恢复原时间时应恢复原订台状态')
  reset.changeVenue({ detail: { value: 1 } })
  assert.strictEqual(reset.data.venueId, 'venue_2')
  assert.strictEqual(reset.data.courtStatus, 'unbooked', '改球馆必须清除原订台状态')
  console.log('PASS 时间或球馆变化会明确重置订台状态')

  const duration = await editor()
  duration.changeEnd({ detail: { value: '19:20' } })
  assert(duration.validate().includes('30 分钟'))
  duration.changeEnd({ detail: { value: '19:30' } })
  assert.strictEqual(duration.validate(), '')
  console.log('PASS 编辑端严格校验最短 30 分钟')

  const unavailable = await editor(match({
    venueId: 'venue_old',
    venue: { id: 'venue_old', name: '已下架老球馆', listingMode: 'name_only' }
  }))
  venueItems = []
  // Reload with the old venue absent from the active catalog.
  unavailable.loading = null
  await unavailable.load()
  assert.strictEqual(unavailable.data.venueId, 'venue_old')
  assert.strictEqual(unavailable.data.venues[0].name, '已下架老球馆')
  assert.strictEqual(unavailable.data.venues[0].unavailable, true)
  assert.strictEqual(unavailable.data.currentVenueUnavailable, true)
  console.log('PASS 已下架的原球馆不会被静默替换成列表第一项')

  let conflicts = 1
  const conflicted = await editor()
  updateHandler = async () => {
    if (conflicts-- > 0) throw codedError('VERSION_CONFLICT')
    return { match: match({ version: 6 }), noop: false }
  }
  conflicted.changeNumeric({ detail: { value: '45' } })
  serverMatch = match({ version: 5, participantCount: 3 })
  await conflicted.save()
  assert.strictEqual(conflicted.data.saving, false)
  assert.strictEqual(conflicted.data.version, 5)
  assert.strictEqual(conflicted.data.feePerPerson, '45')
  await conflicted.save()
  assert.strictEqual(updateCalls[1].payload.expectedVersion, 5)
  assert.notStrictEqual(updateCalls[1].options.requestId, updateCalls[0].options.requestId)
  console.log('PASS 版本冲突刷新并保留用户输入')

  const leaving = await editor()
  leaving.changeNumeric({ detail: { value: '50' } })
  await leaving.save()
  const timer = timers.at(-1)
  assert(timer && !timer.cleared)
  leaving.onUnload()
  assert.strictEqual(timer.cleared, true, '页面卸载必须清理延迟导航')
  timer.callback()
  assert.strictEqual(navigations.length, 0, '已卸载页面的定时器不得再导航')
  console.log('PASS 保存成功后的导航定时器可安全清理')

  const detailState = require(path.join(root, 'utils/match-detail-state')).detailState
  assert.strictEqual(detailState(match(), { status: 'host' }).canEdit, true)
  assert.strictEqual(detailState(match({ startAt: '2020-01-01T00:00:00.000Z' }), { status: 'host' }).canEdit, false)
  assert.strictEqual(detailState(match(), { status: 'joined' }).canEdit, false)
  console.log('PASS 仅发起人且开球前显示编辑入口')
}

run().catch((reason) => {
  console.error(reason)
  process.exitCode = 1
}).finally(() => {
  global.setTimeout = originalSetTimeout
  global.clearTimeout = originalClearTimeout
})
