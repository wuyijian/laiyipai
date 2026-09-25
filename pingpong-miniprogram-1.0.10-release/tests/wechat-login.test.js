const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const root = path.resolve(__dirname, '..')
const tests = [], test = (name, run) => tests.push({ name, run })
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const session = () => ({ profile: { playerId: 'player_wechat', nickname: '原有昵称' }, policies: {} })

function runtime() {
  const calls = { init: 0, bootstrap: 0, privacy: 0, remembers: 0, nav: [], notifierStarts: 0, notifierStops: 0, scheduledDelays: [], readsInvalidated: 0 }
  let timerCallback = null
  const preference = { allowed: false }
  const consent = {
    accepted: () => preference.allowed,
    remember: () => { preference.allowed = true; calls.remembers++ },
    forget: () => { preference.allowed = false }
  }
  const api = {
    init: () => { calls.init++ },
    bootstrap: async () => { calls.bootstrap++; return session() },
    invalidateReads: () => { calls.readsInvalidated++ }
  }
  const privacy = { authorize: async () => { calls.privacy++ }, openContract() {} }
  const wx = {
    navigateTo: value => calls.nav.push({ type: 'to', url: value.url }),
    navigateBack: () => calls.nav.push({ type: 'back' }),
    switchTab: value => calls.nav.push({ type: 'tab', url: value.url }),
    showToast() {}
  }
  let app, page
  const sandbox = { wx, Error, Promise, Object,
    setTimeout: (callback, delay) => { timerCallback = callback; calls.scheduledDelays.push(delay); return 1 },
    clearTimeout: () => { timerCallback = null },
    getApp: () => app, getCurrentPages: () => [{route: 'pages/match-detail/match-detail'}, {route: 'pages/login/login'}],
    App: value => { app = value }, Page: value => { page = value },
    require(name) {
      if (name.endsWith('/api')) return api
      if (name.endsWith('/privacy')) return privacy
      if (name.endsWith('/login-consent')) return consent
      if (name.endsWith('/error')) return { message: error => error.message }
      if (name.endsWith('/share')) return { disable() {} }
      if (name.endsWith('/message-notifier')) return {
        start() { calls.notifierStarts++ },
        stop() { calls.notifierStops++ },
        reset() {}
      }
      throw Error(name)
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), sandbox)
  function loginPage() {
    vm.runInNewContext('(function(){' + fs.readFileSync(path.join(root, 'pages/login/login.js'), 'utf8') + '\n})()', sandbox)
    page.setData = patch => Object.assign(page.data, patch)
    page.onLoad()
    return page
  }
  return { app, api, privacy, calls, preference, wx, loginPage,
    fireTimer() { const callback = timerCallback; timerCallback = null; if (callback) callback() }
  }
}

test('未确认登录的被动检查不跳转，只有明确交互才打开一次登录页', async () => {
  const { app, calls } = runtime()
  await assert.rejects(app.ensureSession(), error => error.code === 'LOGIN_REQUIRED')
  await assert.rejects(app.ensureSession(), error => error.code === 'LOGIN_REQUIRED')
  assert.equal(calls.nav.length, 0); assert.equal(calls.bootstrap, 0); assert.equal(calls.init, 0); assert.equal(calls.privacy, 0)
  app.globalData.loginVisible = false
  await assert.rejects(app.ensureSession(), error => error.code === 'LOGIN_REQUIRED')
  assert.equal(calls.nav.length, 0)
  await assert.rejects(app.ensureSession({ interactive: true }), error => error.code === 'LOGIN_REQUIRED')
  assert.equal(calls.nav.length, 1)
  await assert.rejects(app.ensureSession({ interactive: true }), error => error.code === 'LOGIN_REQUIRED')
  assert.equal(calls.nav.length, 1)
})

test('未勾选协议或拒绝微信隐私授权均不调用云端', async () => {
  const { app, calls, privacy } = runtime()
  await assert.rejects(app.loginWithWechat(false), error => error.code === 'CONSENT_REQUIRED')
  privacy.authorize = async () => { throw Error('拒绝授权') }
  await assert.rejects(app.loginWithWechat(true), /拒绝授权/)
  assert.equal(calls.bootstrap, 0); assert.equal(calls.init, 0)
  assert.equal(app.globalData.session, null)
})

test('重复点击及同时加载页面合并一次登录，不缓存身份到本机', async () => {
  const { app, calls, api } = runtime(), waiting = deferred()
  api.bootstrap = () => { calls.bootstrap++; return waiting.promise }
  const first = app.loginWithWechat(true), second = app.loginWithWechat(true), third = app.ensureSession()
  await tick(); assert.equal(calls.bootstrap, 1)
  waiting.resolve(session())
  const result = await Promise.all([first, second, third])
  assert.equal(result[0].profile.playerId, result[2].profile.playerId)
  assert.equal(calls.remembers, 1)
  await app.ensureSession(); assert.equal(calls.bootstrap, 1)
})

test('已登录账号可显式刷新服务端能力且不重复触发隐私授权', async () => {
  const r = runtime()
  r.preference.allowed = true
  r.app.globalData.session = session()
  r.api.bootstrap = async () => {
    r.calls.bootstrap++
    return Object.assign(session(), { capabilities: { adminCoachReview: true } })
  }
  const refreshed = await r.app.ensureSession({ refresh: true })
  assert.equal(r.calls.bootstrap, 1)
  assert.equal(r.calls.privacy, 0)
  assert.equal(refreshed.capabilities.adminCoachReview, true)
  assert.equal(r.app.globalData.session.capabilities.adminCoachReview, true)
})

test('失败不显示登录成功，重试返回原账号；已确认用户再次进入仍校验云端', async () => {
  const r = runtime()
  r.api.bootstrap = async () => { throw Error('断网') }
  await assert.rejects(r.app.loginWithWechat(true), /断网/)
  assert.equal(r.app.globalData.session, null); assert.equal(r.preference.allowed, false)
  r.api.bootstrap = async () => session()
  await r.app.loginWithWechat(true)
  assert.equal(r.app.globalData.session.profile.nickname, '原有昵称')
  r.app.globalData.session = null
  let restored = 0
  r.api.bootstrap = async () => { restored++; return session() }
  await r.app.ensureSession()
  assert.equal(restored, 1)
})

test('冷启动不抢占首页请求，首屏成功后才恢复登录和消息', async () => {
  const r = runtime()
  r.preference.allowed = true
  r.app.onLaunch()
  r.app.onShow()
  assert.equal(r.calls.bootstrap, 0)
  assert.equal(r.calls.notifierStarts, 0)
  assert.deepEqual(r.calls.scheduledDelays, [12000])
  assert.equal(r.app.restoreSessionAfterPrimary(), true)
  assert.equal(r.calls.bootstrap, 0)
  assert.deepEqual(r.calls.scheduledDelays, [12000, 250])
  r.fireTimer()
  await tick()
  assert.equal(r.calls.bootstrap, 1)
  assert.equal(r.calls.notifierStarts, 1)
})

test('清除会话后迟到登录不能恢复账号，返回格式不正确不视为成功', async () => {
  const r = runtime(), waiting = deferred()
  r.api.bootstrap = () => waiting.promise
  const pending = r.app.loginWithWechat(true)
  await tick(); r.app.clearSession()
  waiting.resolve(session())
  await assert.rejects(pending, error => error.code === 'LOGIN_CANCELLED')
  assert.equal(r.app.globalData.session, null); assert.equal(r.preference.allowed, false)
  r.api.bootstrap = async () => ({ profile: {} })
  await assert.rejects(r.app.loginWithWechat(true), error => error.code === 'INVALID_SERVER_RESPONSE')
})

test('登录页保留明确勾选和忙碌态，成功返回原页而非重建分享地址', async () => {
  const r = runtime(), page = r.loginPage(), waiting = deferred()
  await page.login(); assert(page.data.errorMessage); assert.equal(r.calls.bootstrap, 0)
  page.changeAgreement({ detail: { value: ['agree'] } })
  r.api.bootstrap = () => { r.calls.bootstrap++; return waiting.promise }
  const pending = page.login(); await page.login(); await tick()
  assert.equal(page.data.loading, true); assert.equal(r.calls.bootstrap, 1)
  waiting.resolve(session()); await pending
  assert.equal(page.data.complete, true); assert.equal(r.calls.nav.at(-1).type, 'back')
  page.onUnload(); assert(r.app.globalData.session)
})

test('登录中离开页面使本次登录失效，后台响应不更新页面', async () => {
  const r = runtime(), page = r.loginPage(), waiting = deferred()
  page.changeAgreement({ detail: { value: ['agree'] } })
  r.api.bootstrap = () => waiting.promise
  const pending = page.login(); await tick(); page.onUnload()
  waiting.resolve(session()); await pending
  assert.equal(r.app.globalData.session, null); assert.equal(page.data.complete, false)
  assert.equal(r.calls.nav.length, 0)
})

test('注销或停用账号恢复失败会撤销本机登录偏好', async () => {
  const r = runtime(); r.preference.allowed = true
  r.api.bootstrap = async () => { throw Object.assign(Error('账号已暂停'), { code: 'ACCOUNT_SUSPENDED' }) }
  await assert.rejects(r.app.ensureSession(), error => error.code === 'ACCOUNT_SUSPENDED')
  assert.equal(r.preference.allowed, false); assert.equal(r.app.globalData.session, null)
})

test('只记录协议版本与 AppID，更换小程序或协议需要重新确认', () => {
  let saved = null, appId = 'wx_current'
  const config = { privacyPolicyVersion: '2026-09-04', termsVersion: '2026-09-01' }
  const box = { module: { exports: {} }, wx: { getAccountInfoSync: () => ({ miniProgram: { appId } }) }, require: name => name === './storage'
    ? { read: () => saved, write: (_, value) => { saved = value }, remove: () => { saved = null } } : config }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/login-consent.js'), 'utf8'), box)
  const consent = box.module.exports
  assert.equal(consent.accepted(), false); consent.remember(); assert(consent.accepted())
  assert.deepEqual(Object.keys(saved).sort(), ['appId', 'privacyVersion', 'termsVersion'])
  appId = 'wx_other'; assert.equal(consent.accepted(), false)
  appId = 'wx_current'; config.privacyPolicyVersion = 'new'; assert.equal(consent.accepted(), false)
})

test('登录页打包与分享限制、微信头像昵称填写保持正确', () => {
  const config = require('../app.json'), project = require('../project.config.json')
  assert(config.pages.includes('pages/login/login'))
  assert(project.packOptions.include.some(item => item.value === 'pages/login'))
  const profile = fs.readFileSync(path.join(root, 'pages/profile/profile.wxml'), 'utf8')
  assert(!profile.includes('open-type="chooseAvatar"')); assert(profile.includes('type="nickname"'))
  const code = fs.readFileSync(path.join(root, 'pages/login/login.js'), 'utf8')
  assert(code.includes('share.disable()')); assert(!code.includes('onShareTimeline'))
})

;(async () => { for (const item of tests) { await item.run(); console.log('PASS ' + item.name) }; console.log(tests.length + ' WeChat login client checks passed') })().catch(error => { console.error(error); process.exitCode = 1 })
