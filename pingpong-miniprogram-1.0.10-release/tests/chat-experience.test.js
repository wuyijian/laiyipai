const assert = require('assert')
const path = require('path')
const chatState = require('../utils/chat-state')
const pagePath = path.resolve(__dirname, '../pages/chat/chat.js')
const apiPath = path.resolve(__dirname, '../utils/api.js')
let definition
let sequence = 0
global.Page = (value) => { definition = value }
global.getApp = () => ({ ensureSession: async () => ({}) })
global.wx = { showToast() {}, hideKeyboard() {}, navigateTo() {}, switchTab() {} }

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function message(number, extra = {}) {
  return Object.assign({ id: 'm' + number, text: '消息 ' + number, createdAt: new Date(Date.UTC(2030, 0, 1, 0, number)).toISOString(), sender: { playerId: 'p1', displayName: '球友' } }, extra)
}
function rawMatch(extra = {}) {
  return Object.assign({ id: 'match1', title: '周末约球', status: 'recruiting', version: 1, scheduleVersion: 1, date: '2030-01-01', startTime: '19:00', endTime: '20:30', capacity: 4, participantCount: 2, venueId: 'venue1', venue: { name: '萧潮乒乓球馆', nameOnly: true }, participants: [], host: { playerId: 'p1', displayName: '发起人' } }, extra)
}
function setup(overrides = {}) {
  const api = {
    createRequestId: () => 'request' + (++sequence),
    matches: {
      get: async () => ({ match: rawMatch(), membership: { status: 'joined', canChat: true, confirmedScheduleVersion: 1 }, confirmedCount: 2 }),
      confirmSchedule: async () => ({}), reschedule: async () => ({}), cancel: async () => ({})
    },
    messages: { list: async () => ({ items: [], nextCursor: null }), send: async () => ({ message: message(10, { mine: true }) }) },
    venues: { get: async () => ({ name: '萧潮乒乓球馆', nameOnly: true }) },
    files: { resolve: async () => ({ urls: {} }) }
  }
  Object.keys(overrides).forEach((key) => { api[key] = Object.assign(api[key], overrides[key]) })
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: api }
  delete require.cache[pagePath]
  require(pagePath)
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  page.setData = (patch, callback) => {
    Object.keys(patch).forEach((key) => {
      const parts = key.split('.')
      let target = page.data
      parts.slice(0, -1).forEach((part) => { target = target[part] })
      target[parts[parts.length - 1]] = patch[key]
    })
    if (callback) callback()
  }
  page.onLoad({ id: 'match1' })
  return { page, api }
}
const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('核心对话不等待球馆补充接口', async () => {
  const waiting = deferred()
  const { page } = setup({ venues: { get: () => waiting.promise } })
  await page.loadChat()
  assert.strictEqual(page.data.state, 'ready')
  assert.strictEqual(page.data.match.venueName, '萧潮乒乓球馆')
  assert.strictEqual(page.data.match.address, '')
  waiting.resolve({ nameOnly: true, name: '萧潮乒乓球馆' })
})

test('快捷短句只填入草稿，不自动发送或覆盖已有草稿', async () => {
  let calls = 0
  const { page } = setup({ messages: { send: async () => { calls++ } } })
  await page.loadChat()
  page.useQuickReply({ currentTarget: { dataset: { index: 0 } } })
  assert.strictEqual(page.data.inputValue, '球台订好了吗？')
  page.useQuickReply({ currentTarget: { dataset: { index: 1 } } })
  assert.strictEqual(page.data.inputValue, '球台订好了吗？')
  assert.strictEqual(calls, 0)
})

test('快捷短句根据订台状态优先提示下一步', async () => {
  const unbooked = setup()
  await unbooked.page.loadChat()
  assert.strictEqual(unbooked.page.data.quickReplies[0], '球台订好了吗？')

  const booked = setup({ matches: { get: async () => ({
    match: rawMatch({ courtStatus: 'booked' }),
    membership: { status: 'joined', canChat: true, confirmedScheduleVersion: 1 },
    confirmedCount: 2
  }) } })
  await booked.page.loadChat()
  assert.strictEqual(booked.page.data.quickReplies[0], '在哪张球台见？')
})

test('失败保留内容，同一消息重试复用请求编号', async () => {
  const requests = []
  const { page } = setup({ messages: { send: async (payload, options) => {
    requests.push(options.requestId)
    if (requests.length === 1) throw new Error('网络断开')
    return { message: message(10, { mine: true, text: payload.text }) }
  } } })
  await page.loadChat()
  page.changeInput({ detail: { value: '三号台见' } })
  await page.sendMessage()
  assert.strictEqual(page.data.inputValue, '三号台见')
  assert(page.data.sendError.includes('网络断开'))
  await page.sendMessage()
  assert.strictEqual(requests[0], requests[1])
  assert.strictEqual(page.data.inputValue, '')
  assert.strictEqual(page.data.messages.length, 1)
})

test('上一条消息发送完成不擦掉下一条草稿', async () => {
  const sent = deferred()
  const { page } = setup({ messages: { send: () => sent.promise } })
  await page.loadChat()
  page.changeInput({ detail: { value: '第一条' } })
  const sending = page.sendMessage()
  page.changeInput({ detail: { value: '还在写的下一条' } })
  sent.resolve({ message: message(10, { mine: true, text: '第一条' }) })
  await sending
  assert.strictEqual(page.data.inputValue, '还在写的下一条')
  assert.strictEqual(page.data.canSend, true)
})

test('轮询保留翻页历史，阅读旧消息时只提示新消息', async () => {
  let poll = 0
  const { page } = setup({ messages: { list: async (payload) => {
    if (payload.before) return { items: [message(1), message(2), message(3)], nextCursor: null }
    return ++poll === 1 ? { items: [message(4), message(5)], nextCursor: message(4).createdAt }
      : { items: [message(5), message(6)], nextCursor: message(5).createdAt }
  } } })
  await page.loadChat()
  await page.loadOlderMessages()
  const anchor = page.data.scrollIntoView
  await page.refreshMessages()
  assert.deepStrictEqual(page.data.messages.map((m) => m.id), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  assert.strictEqual(page.data.nextCursor, null)
  assert.strictEqual(page.data.scrollIntoView, anchor)
  assert.strictEqual(page.data.newMessageCount, 1)
  page.scrollToLatest()
  assert.strictEqual(page.data.scrollIntoView, 'message-m6')
  assert.strictEqual(page.data.newMessageCount, 0)
})

test('滞后的轮询响应不会移除刚发送成功的消息', async () => {
  const delayed = deferred()
  let poll = 0
  const { page } = setup({ messages: {
    list: async () => ++poll === 1 ? { items: [message(5)], nextCursor: null } : delayed.promise,
    send: async () => ({ message: message(6, { mine: true }) })
  } })
  await page.loadChat()
  const refreshing = page.refreshMessages()
  page.changeInput({ detail: { value: '到馆了' } })
  await page.sendMessage()
  delayed.resolve({ items: [message(5)], nextCursor: null })
  await refreshing
  assert.deepStrictEqual(page.data.messages.map((m) => m.id), ['m5', 'm6'])
})

test('时间调整在消息轮询同步，保留正在选择的改期草稿', async () => {
  let reads = 0
  const { page } = setup({ matches: { get: async () => ({
    match: rawMatch(++reads > 1 ? { scheduleVersion: 2, status: 'changed', startTime: '18:00' } : {}),
    membership: { status: 'joined', canChat: true, confirmedScheduleVersion: 1 }, confirmedCount: 1
  }) } })
  await page.loadChat()
  page.openReschedule()
  page.changeRescheduleStartTime({ detail: { value: '17:00' } })
  await page.refreshMessages()
  assert.strictEqual(page.data.match.startTime, '18:00')
  assert.strictEqual(page.data.match.needsConfirmation, true)
  assert.strictEqual(page.data.rescheduleStartTime, '17:00')
})

test('旧轮询不能撤回已成功确认的新时间', async () => {
  const oldPoll = deferred()
  let reads = 0
  const result = (confirmed) => ({ match: rawMatch({ scheduleVersion: 2, status: 'changed' }),
    membership: { status: 'joined', canChat: true, confirmedScheduleVersion: confirmed }, confirmedCount: confirmed })
  const { page } = setup({ matches: { get: async () => ++reads === 2 ? oldPoll.promise : result(reads > 2 ? 2 : 1) } })
  await page.loadChat()
  const refreshing = page.refreshMessages()
  await page.confirmSchedule()
  oldPoll.resolve(result(1))
  await refreshing
  assert.strictEqual(page.data.match.myScheduleConfirmed, true)
  assert.strictEqual(page.data.match.needsConfirmation, false)
})

test('球局开球后隐藏改期与取消，仍允许有效期内沟通', async () => {
  const { page } = setup({ matches: { get: async () => ({ match: rawMatch({ status: 'started' }),
    membership: { status: 'host', canChat: true }, confirmedCount: 1 }) } })
  await page.loadChat()
  assert.strictEqual(page.data.match.canArrange, false)
  page.openCancel()
  assert.strictEqual(page.data.sheet, '')
  page.openReschedule()
  assert.strictEqual(page.data.sheet, '')
  assert.strictEqual(page.data.state, 'ready')
})

test('权限关闭后停止输入与轮询', async () => {
  const { page, api } = setup()
  await page.loadChat()
  api.messages.list = async () => { throw Object.assign(new Error('球局结束 24 小时后对话关闭'), { code: 'CHAT_CLOSED' }) }
  await page.refreshMessages()
  assert.strictEqual(page.data.state, 'error')
  assert.strictEqual(page.data.forbidden, true)
  assert.strictEqual(page.pollTimer, null)
})

test('页面离开后延迟加载完成不会重新启动定时器', async () => {
  const loading = deferred()
  const { page } = setup({ messages: { list: () => loading.promise } })
  page.onShow()
  page.onHide()
  loading.resolve({ items: [], nextCursor: null })
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(page.pollTimer, null)
  page.onUnload()
})

test('最新窗口内已撤下消息被剔除，头像沿用球友公开标识', () => {
  const merged = chatState.reconcileMessages([message(1), message(4), message(5)], [message(5)], message(4).createdAt)
  assert.deepStrictEqual(merged.map((m) => m.id), ['m1', 'm5'])
  const decorated = chatState.decorateMessages([message(1), message(2), message(9)], {}, 'p1')
  assert.strictEqual(decorated[0].avatarSeed, 'p1')
  assert.strictEqual(decorated[0].isHost, true)
  assert.strictEqual(decorated[1].showTime, false)
  assert.strictEqual(decorated[2].showTime, true)
})

;(async () => {
  for (const item of tests) { await item.fn(); console.log('PASS ' + item.name) }
  console.log(tests.length + ' chat experience checks passed')
})().catch((error) => { console.error(error); process.exitCode = 1 })
