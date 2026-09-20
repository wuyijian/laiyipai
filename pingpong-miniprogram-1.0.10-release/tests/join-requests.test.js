const assert = require('assert')
const path = require('path')
const fs = require('fs')
const root = path.resolve(__dirname, '..')
const apiPath = require.resolve('../utils/api')
const ordersPath = require.resolve('../pages/orders/orders')
const clientState = require('../utils/client-state')
const present = require('../utils/present')
const tests = []
const notices = []
const badges = []
let definition
let stopped = 0
let requestId = 0
global.Page = (value) => { definition = value }
global.getApp = () => ({ ensureSession: async () => ({}) })
global.wx = {
  showToast: (value) => notices.push(value.title),
  showModal: (value) => value.success({ confirm: true }),
  setTabBarBadge: (value) => badges.push(value.text),
  removeTabBarBadge: () => badges.push(''),
  stopPullDownRefresh: () => { stopped += 1 },
  pageScrollTo() {}
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function appointment(id, overrides = {}) {
  return {
    id: `appointment-${id}`, type: 'match', status: 'host', membershipStatus: 'host',
    match: Object.assign({
      id, title: '周末练球', date: '2099-09-12', startTime: '19:00', endTime: '21:00',
      startAt: '2099-09-12T19:00:00+08:00', endAt: '2099-09-12T21:00:00+08:00',
      status: 'recruiting', capacity: 2, participantCount: 1, joinMode: 'confirm',
      version: 1, scheduleVersion: 1, host: {}, participants: []
    }, overrides)
  }
}
function request(id = 'member-a', status = 'pending') {
  return { membershipId: id, status, player: { displayName: '申请球友', ballAge: '2 年', skills: ['正手'] } }
}
function load(options = {}) {
  const api = {
    createRequestId: () => `req_review_${++requestId}`,
    appointments: { list: options.list || (async () => ({ items: [appointment('match-a')] })) },
    matches: {
      pending: options.pending || (async () => ({ items: [request()] })),
      respondJoin: options.respond || (async () => ({}))
    }
  }
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: api }
  delete require.cache[ordersPath]
  require(ordersPath)
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback() }
  return page
}
async function refresh(page) { await page.loadAppointments(); await page.joinRequestsLoading }
function test(name, body) { tests.push({ name, body }) }

test('申请按球局串行读取，不再漏查第 21 场，并区分候补', async () => {
  let active = 0, maxActive = 0, calls = 0
  const page = load({
    list: async () => ({ items: Array.from({ length: 23 }, (_, i) => appointment(`match-${i}`)) }),
    pending: async ({ matchId }) => {
      calls += 1; active += 1; maxActive = Math.max(active, maxActive)
      await tick(); active -= 1
      return { items: [request(`member-${matchId}`, matchId === 'match-22' ? 'waitlisted' : 'pending')] }
    }
  })
  await refresh(page)
  assert.strictEqual(calls, 23)
  assert.strictEqual(maxActive, 1)
  assert.strictEqual(page.data.joinRequests.length, 23)
  assert.strictEqual(page.data.joinRequests[22].statusLabel, '候补申请')
  assert.strictEqual(badges.at(-1), '23')
})

test('先返回的加入申请立即可见，不必等待较慢的其他球局', async () => {
  const gate = deferred()
  const page = load({
    list: async () => ({ items: [appointment('match-a'), appointment('match-b')] }),
    pending: async ({ matchId }) => matchId === 'match-a' ? { items: [request()] } : gate.promise
  })
  await page.loadAppointments(); await tick()
  assert.strictEqual(page.data.joinRequests[0].id, 'member-a')
  assert.strictEqual(page.data.joinRequestsState, 'loading')
  gate.resolve({ items: [] }); await page.joinRequestsLoading
  assert.strictEqual(page.data.joinRequestsState, 'ready')
})

test('下拉等待申请接口结束，连续下拉不重复发送，之后仍可再次刷新', async () => {
  let gate = deferred(), calls = 0
  const page = load({ pending: async () => { calls += 1; return gate.promise } })
  const first = page.onPullDownRefresh()
  const same = page.onPullDownRefresh()
  await tick()
  const before = stopped
  assert.strictEqual(page.data.state, 'ready')
  assert.strictEqual(page.data.refreshing, true)
  assert.strictEqual(calls, 1)
  gate.resolve({ items: [request()] })
  await Promise.all([first, same])
  assert.strictEqual(page.data.refreshing, false)
  assert.strictEqual(stopped, before + 2)
  gate = deferred()
  const next = page.onPullDownRefresh()
  await tick(); assert.strictEqual(calls, 2)
  gate.resolve({ items: [] }); await next
  assert.strictEqual(page.data.joinRequests.length, 0)
})

test('服务错误不会显示成没有申请，保留旧申请并停止本轮后续请求', async () => {
  let failing = false, calls = 0
  const page = load({
    list: async () => ({ items: [appointment('match-a'), appointment('match-b')] }),
    pending: async ({ matchId }) => {
      calls += 1
      if (failing) throw Object.assign(new Error('服务繁忙，请稍后重试'), { code: 'SERVICE_UNAVAILABLE' })
      return { items: [request(`member-${matchId}`)] }
    }
  })
  await refresh(page)
  failing = true; calls = 0
  await refresh(page)
  assert.strictEqual(calls, 1)
  assert.strictEqual(page.data.joinRequestsState, 'error')
  assert.strictEqual(page.data.joinRequestsError, '服务繁忙，请稍后重试')
  assert.strictEqual(page.data.joinRequests.length, 2)
  assert(page.data.joinRequests.every((item) => item.stale))
})

test('单场申请失败不影响其他球局，只有失败的旧申请不可审批', async () => {
  const page = load({
    list: async () => ({ items: [appointment('match-a'), appointment('match-b')] }),
    pending: async ({ matchId }) => {
      if (matchId === 'match-a') throw Object.assign(new Error('不可访问'), { code: 'FORBIDDEN' })
      return { items: [request('member-b')] }
    }
  })
  page.data.joinRequests = [{ id: 'member-a', matchId: 'match-a' }]
  await refresh(page)
  assert.strictEqual(page.data.joinRequests.length, 2)
  assert.strictEqual(page.data.joinRequests.find((item) => item.id === 'member-b').stale, false)
  assert.strictEqual(page.data.joinRequests.find((item) => item.id === 'member-a').stale, true)
})

test('页面打开自动刷新，切出停止，迟到响应不能覆盖下一次页面状态', async () => {
  const nativeSet = global.setTimeout, nativeClear = global.clearTimeout
  const timers = new Map(); let sequence = 0, gate = null, reads = 0
  global.setTimeout = (fn, ms) => { timers.set(++sequence, { fn, ms }); return sequence }
  global.clearTimeout = (id) => timers.delete(id)
  const page = load({ pending: async () => { reads += 1; return gate ? gate.promise : { items: [request()] } } })
  try {
    await page.onShow(); await page.joinRequestsLoading
    assert.strictEqual(timers.size, 1)
    const timer = timers.values().next().value
    assert.strictEqual(timer.ms, 15000)
    timer.fn(); await tick(); await page.joinRequestsLoading
    assert.strictEqual(reads, 2)
    gate = deferred()
    await page.loadAppointments()
    const old = page.joinRequestsLoading
    page.onHide(); assert.strictEqual(timers.size, 0)
    gate.resolve({ items: [request('stale-member')] }); await old
    assert(!page.data.joinRequests.some((item) => item.id === 'stale-member'))
    assert.strictEqual(timers.size, 0)
    gate = null
    await page.onShow(); await page.joinRequestsLoading
    assert.strictEqual(page.data.joinRequestsState, 'ready')
  } finally {
    page.onUnload(); global.setTimeout = nativeSet; global.clearTimeout = nativeClear
  }
})

test('球局已开始、已取消及单人练习不再出现可审批操作', () => {
  assert.strictEqual(present.appointment(appointment('future')).canReviewRequests, true)
  assert.strictEqual(present.appointment(appointment('solo', { capacity: 1 })).canReviewRequests, false)
  assert.strictEqual(present.appointment(appointment('closed', { status: 'cancelled' })).canReviewRequests, false)
  assert.strictEqual(present.appointment(appointment('started', { startAt: '2000-01-01T00:00:00Z' })).canReviewRequests, false)
})

test('审批冲突自动刷新申请版本，但不自动替用户再次同意', async () => {
  let version = 1
  const calls = []
  let accepted = false
  const page = load({
    list: async () => ({ items: [appointment('match-a', { version })] }),
    pending: async () => ({ items: accepted ? [] : [request()] }),
    respond: async (payload, options) => {
      calls.push({ payload, options })
      if (calls.length === 1) {
        version = 2
        throw Object.assign(new Error('球局信息已更新，请刷新后重试'), { code: 'VERSION_CONFLICT' })
      }
      accepted = true
    }
  })
  await refresh(page)
  await page.respondRequest('member-a', 'accept')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(page.data.joinRequests[0].matchVersion, 2)
  await page.respondRequest('member-a', 'accept')
  assert.strictEqual(calls[1].payload.expectedVersion, 2)
  assert.notStrictEqual(calls[1].options.requestId, calls[0].options.requestId)
  assert.strictEqual(page.data.joinRequests.length, 0)
})

test('审批结果未知时保留请求编号，阻止反向处理和双击重复提交', async () => {
  const gate = deferred(), calls = []
  const page = load({ respond: async (payload, options) => {
    calls.push({ payload, options })
    if (calls.length === 1) return gate.promise
    throw Object.assign(new Error('超时'), { code: 'REQUEST_TIMEOUT', details: { outcomeUnknown: true } })
  } })
  await refresh(page)
  const first = page.respondRequest('member-a', 'accept')
  await page.respondRequest('member-a', 'accept')
  assert.strictEqual(calls.length, 1)
  gate.reject(Object.assign(new Error('超时'), { code: 'REQUEST_TIMEOUT', details: { outcomeUnknown: true } }))
  await first
  await page.respondRequest('member-a', 'reject')
  assert.strictEqual(calls.length, 1)
  await page.respondRequest('member-a', 'accept')
  assert.strictEqual(calls.length, 2)
  assert.deepStrictEqual(calls[0], calls[1])
})

test('审批期间的旧查询不能重新插入已经处理的申请', async () => {
  const old = deferred(); let pendingCalls = 0, accepted = false
  const page = load({
    pending: async () => {
      pendingCalls += 1
      if (pendingCalls === 2) return old.promise
      return { items: accepted ? [] : [request()] }
    },
    respond: async () => { accepted = true }
  })
  await refresh(page)
  await page.loadAppointments()
  const previous = page.joinRequestsLoading
  await page.respondRequest('member-a', 'accept')
  old.resolve({ items: [request()] }); await previous
  assert.strictEqual(page.data.joinRequests.length, 0)
})

test('球局详情进入加入申请时不沿用历史记录或教练筛选', async () => {
  const page = load()
  page.setData({ period: 'history', type: 'coach' })
  clientState.requestJoinRequests()
  await page.onShow(); await page.joinRequestsLoading
  page.onHide()
  assert.strictEqual(page.data.period, 'upcoming')
  assert.strictEqual(page.data.type, 'all')
  assert.strictEqual(clientState.consumeJoinRequestsDestination(), false)
  const detail = fs.readFileSync(path.join(root, 'pages/match-detail/match-detail.wxml'), 'utf8')
  assert(detail.includes('查看加入申请'))
})

;(async () => {
  for (const item of tests) { await item.body(); console.log(`PASS ${item.name}`) }
  console.log(`${tests.length} join request checks passed`)
})().catch((error) => { console.error(error); process.exitCode = 1 })
