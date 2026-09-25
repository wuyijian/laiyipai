const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const policy = require('../utils/request-policy')
const root = path.resolve(__dirname, '..')
const tests = [], test = (name, run) => tests.push({ name, run })
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const fixture = (historyCount = 3) => ({ historyCount, monthCount: Math.min(historyCount, 2), hostedCount: Math.min(historyCount, 1), month: '2026-09', asOf: '2026-09-22T12:00:00Z' })

function runtime() {
  let definition
  const profile = { playerId: 'player-me', nickname: '测试球友', skills: [], ballAge: '球龄 2—5 年' }
  const calls = { stats: 0, refreshStopped: 0, modal: null }
  const app = { globalData: { sessionGeneration: 0, session: { profile } }, ensureSession: async () => ({ profile }) }
  const api = {
    profile: { get: async () => profile, stats: async () => { calls.stats++; return fixture() } },
    favorites: { list: async () => ({ items: [], total: 0 }) },
    files: { resolve: async () => ({ urls: {} }) }
  }
  const deps = { api, present: { venue: value => value }, privacy: {}, error: { message: e => e.message, toast() {} }, 'client-state': {},
    'tab-bar': { sync() {} }, 'message-notifier': { start() {}, poll: async () => {}, subscribe: () => () => {} } }
  const box = { Page: value => { definition = value }, getApp: () => app, setTimeout, clearTimeout,
    wx: { showModal: value => { calls.modal = value }, stopPullDownRefresh: () => { calls.refreshStopped++ } },
    require: name => { const key = name.split('/').pop(); assert(deps[key], key); return deps[key] } }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/profile/profile.js'), 'utf8'), box)
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback() }
  page.onLoad()
  return { page, api, app, calls, profile }
}

test('统计慢请求不阻塞我的、球馆和消息，成功后局部更新', async () => {
  const r = runtime(), waiting = deferred()
  r.api.profile.stats = () => { r.calls.stats++; return waiting.promise }
  await r.page.loadProfile()
  assert.equal(r.page.data.state, 'ready')
  assert.equal(r.page.data.venuesState, 'ready')
  assert.equal(r.page.data.matchStatsState, 'loading')
  assert.equal(r.page.data.matchStats, null)
  const first = r.page.matchStatsLoading
  const second = r.page.loadMatchStats()
  assert.equal(r.calls.stats, 1, '重复点击只发一个请求')
  waiting.resolve(fixture())
  await Promise.all([first, second])
  assert.equal(r.page.data.matchStats.historyCount, 3)
  assert.equal(r.page.data.matchStatsState, 'ready')
})

test('刷新失败保留上次数字并标记过期，重试成功；真实零不显示横杠', async () => {
  const r = runtime()
  await r.page.loadProfile(); await r.page.matchStatsLoading
  r.api.profile.stats = async () => { throw Object.assign(Error('断网'), { code: 'NETWORK_ERROR' }) }
  await r.page.loadMatchStats()
  assert.equal(r.page.data.matchStats.historyCount, 3)
  assert.equal(r.page.data.matchStatsState, 'error')
  r.api.profile.stats = async () => fixture(0)
  await r.page.loadMatchStats()
  assert.equal(r.page.data.matchStats.historyCount, 0)
  assert.equal(r.page.data.matchStatsState, 'ready')
})

test('离开重进时旧响应不能覆盖新统计，重新进入会再次请求', async () => {
  const r = runtime(), old = deferred()
  r.api.profile.stats = () => old.promise
  await r.page.loadProfile()
  const pending = r.page.matchStatsLoading
  r.page.onHide()
  r.api.profile.stats = async () => fixture(5)
  await r.page.onShow(); await r.page.matchStatsLoading
  old.resolve(fixture(1)); await pending
  assert.equal(r.page.data.matchStats.historyCount, 5)
})

test('退出登录后迟到响应不回写，身份错误清除旧统计', async () => {
  const r = runtime(), waiting = deferred()
  r.api.profile.stats = () => waiting.promise
  await r.page.loadProfile()
  const pending = r.page.matchStatsLoading
  r.app.globalData.sessionGeneration++
  r.app.globalData.session = null
  waiting.resolve(fixture(99)); await pending
  assert.equal(r.page.data.matchStats, null)
  r.page.data.matchStats = fixture()
  r.api.profile.stats = async () => { throw Object.assign(Error('注销'), { code: 'ACCOUNT_DELETED' }) }
  await r.page.loadMatchStats()
  assert.equal(r.page.data.matchStats, null)
})

test('统计尚未部署或格式错误时不拖垮个人资料，也不冒充零场', async () => {
  const r = runtime()
  r.api.profile.stats = async () => { throw Object.assign(Error('旧服务'), { code: 'ACTION_NOT_FOUND' }) }
  await r.page.loadProfile(); await r.page.matchStatsLoading
  assert.equal(r.page.data.state, 'ready')
  assert.equal(r.page.data.matchStatsState, 'unavailable')
  assert.equal(r.page.data.matchStats, null)
  for (const bad of [{}, fixture(-1), Object.assign(fixture(), { monthCount: 10 }), Object.assign(fixture(), { historyCount: '3' })]) {
    r.api.profile.stats = async () => bad
    await r.page.loadMatchStats()
    assert.equal(r.page.data.matchStatsState, 'error')
    assert.equal(r.page.data.matchStats, null)
  }
})

test('下拉刷新等待统计完成；未登录不请求统计且不强制弹登录', async () => {
  const r = runtime(), waiting = deferred()
  r.api.profile.stats = () => waiting.promise
  const pending = r.page.onPullDownRefresh()
  await tick()
  assert.equal(r.calls.refreshStopped, 0)
  waiting.resolve(fixture()); await pending
  assert.equal(r.calls.refreshStopped, 1)
  const guest = runtime()
  guest.app.globalData.session = null
  guest.app.ensureSession = async () => { throw Object.assign(Error('登录后可查看'), { code: 'LOGIN_REQUIRED' }) }
  await guest.page.loadProfile()
  assert.equal(guest.calls.stats, 0)
  assert.equal(guest.page.data.loginRequired, true)
})

test('数字三列居中、明确口径、不伪造打卡；请求分类为安全只读', () => {
  const r = runtime()
  r.page.showStatsHelp()
  assert(r.calls.modal.content.includes('不代表签到或实际到场'))
  const template = fs.readFileSync(path.join(root, 'pages/profile/profile.wxml'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'pages/profile/profile.wxss'), 'utf8')
  for (const label of ['历史参与', '本月参与', '发起成局', '统计暂未载入']) assert(template.includes(label))
  assert(template.includes("matchStats ? matchStats.historyCount : '—'"))
  assert(css.includes('.match-stat { display: flex;'))
  assert.equal(policy.isRead('profile.stats.get'), true)
  assert.equal(policy.canRetry('profile.stats.get'), true)
  assert.equal(policy.timeoutMs('profile.stats.get', {}), 8000)
})

;(async () => { for (const t of tests) { await t.run(); console.log(`PASS ${t.name}`) } })().catch(e => { console.error(e); process.exitCode = 1 })
