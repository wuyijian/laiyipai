const assert = require('assert')
const auth = require('../lib/auth')
const tests = [], test = (name, run) => tests.push({ name, run })
const version = auth.privacyVersion()
const consent = { allowCreate: true, consentAccepted: true, consentVersion: version }
function database() {
  const records = new Map(); let serial = Promise.resolve(), sets = 0
  const db = { collection(name) {
    assert.equal(name, 'users')
    return { doc(id) { return {
      get: async () => ({ data: records.get(id) || null }),
      set: async ({ data }) => { sets++; records.set(id, Object.assign({ _id: id }, data)) },
      update: async ({ data }) => { records.set(id, Object.assign({}, records.get(id), data)) }
    } } }
  }, runTransaction(callback) {
    const work = serial.then(() => callback(db)); serial = work.catch(() => {})
    return work
  } }
  return { records, db, get sets() { return sets } }
}
function context(store, openid = 'trusted_openid', appid = 'wx_current') {
  return { db: store.db, wxContext: { OPENID: openid, APPID: appid }, serverDate: () => new Date() }
}
test('身份只取微信云函数上下文，未登录不能建档', async () => {
  const store = database(), c = context(store, '')
  c.openid = 'forged'; c.userId = 'forged'
  await assert.rejects(auth.requireIdentity(c, consent), error => error.code === 'UNAUTHENTICATED')
  assert.equal(store.records.size, 0)
  const real = context(store); real.openid = 'forged'
  await auth.requireIdentity(real, consent)
  assert.equal(real.openid, 'trusted_openid'); assert(!store.records.has('forged'))
})
test('首次登录必须确认当期隐私版本，无同意不建档', async () => {
  const store = database()
  await assert.rejects(auth.requireIdentity(context(store), Object.assign({}, consent, { consentAccepted: false })), error => error.code === 'CONSENT_REQUIRED')
  await assert.rejects(auth.requireIdentity(context(store), Object.assign({}, consent, { consentVersion: 'old' })), error => error.code === 'CONSENT_VERSION_MISMATCH')
  assert.equal(store.records.size, 0)
})
test('并发登录只建一份账号，重登保留昵称积分角色与原 publicId', async () => {
  const store = database(), a = context(store), b = context(store)
  const users = await Promise.all([auth.requireIdentity(a, consent), auth.requireIdentity(b, consent)])
  assert.equal(store.sets, 1); assert.equal(users[0].publicId, users[1].publicId)
  const record = store.records.get('trusted_openid')
  record.profile.nickname = '原有球友'; record.profile.ratingValue = '1850'; record.role = 'admin'
  const again = await auth.requireIdentity(context(store), consent)
  assert.equal(again.publicId, record.publicId); assert.equal(again.profile.nickname, '原有球友')
  assert.equal(again.profile.ratingValue, '1850'); assert.equal(again.role, 'admin'); assert.equal(store.sets, 1)
})
test('不同微信账号隔离，小程序归属错误与已关闭账号拒绝登录', async () => {
  const store = database(), a = await auth.requireIdentity(context(store, 'a'), consent), b = await auth.requireIdentity(context(store, 'b'), consent)
  assert.notEqual(a.publicId, b.publicId)
  await assert.rejects(auth.requireIdentity(context(store, 'a', 'wx_other'), consent), error => error.code === 'UNAUTHENTICATED')
  for (const status of ['deleted', 'suspended']) {
    store.records.get('a').status = status
    await assert.rejects(auth.requireIdentity(context(store, 'a'), consent), error => error.code === (status === 'deleted' ? 'ACCOUNT_DELETED' : 'ACCOUNT_SUSPENDED'))
  }
})
test('登录返回脱敏资料与真实登录来源，错误版本不能覆盖已同意版本', async () => {
  const store = database(), c = context(store)
  await auth.requireIdentity(c, consent)
  await assert.rejects(auth.bootstrap(c, { consentAccepted: true, consentVersion: 'old' }), error => error.code === 'CONSENT_VERSION_MISMATCH')
  assert.equal(store.records.get(c.openid).consentVersion, version)
  const result = await auth.bootstrap(c, { consentAccepted: true, consentVersion: version })
  assert.equal(result.authentication.provider, 'wechat'); assert(result.authentication.authenticated)
  assert(result.profile.playerId); assert(!JSON.stringify(result).includes('trusted_openid'))
  assert.equal(result.profile.role, undefined)
  assert.equal(result.capabilities.adminVenueReview, false)
  assert.equal(result.capabilities.adminCoachReview, false)
  assert.equal(store.records.get(c.openid).loginProvider, 'wechat'); assert(store.records.get(c.openid).lastLoginAt)
})
test('登录只返回服务端计算的审核能力，数据库角色和管理员白名单均生效', async () => {
  const previous = process.env.LAIYIPAI_ADMIN_OPENIDS
  try {
    const store = database(), adminContext = context(store, 'role_admin')
    await auth.requireIdentity(adminContext, consent)
    store.records.get('role_admin').role = 'admin'
    await auth.requireIdentity(adminContext, consent)
    const roleAdmin = await auth.bootstrap(adminContext, {})
    assert.equal(roleAdmin.capabilities.adminVenueReview, true)
    assert.equal(roleAdmin.capabilities.adminCoachReview, true)

    process.env.LAIYIPAI_ADMIN_OPENIDS = ' allowlisted_admin , another_admin '
    const allowlistedContext = context(store, 'allowlisted_admin')
    await auth.requireIdentity(allowlistedContext, consent)
    const allowlisted = await auth.bootstrap(allowlistedContext, {})
    assert.equal(allowlisted.profile.role, undefined)
    assert.equal(allowlisted.capabilities.adminVenueReview, true)
    assert.equal(allowlisted.capabilities.adminCoachReview, true)
    assert.doesNotThrow(() => auth.requireAdmin(allowlistedContext))
  } finally {
    if (previous === undefined) delete process.env.LAIYIPAI_ADMIN_OPENIDS
    else process.env.LAIYIPAI_ADMIN_OPENIDS = previous
  }
})
;(async () => { for (const item of tests) { await item.run(); console.log('PASS ' + item.name) }; console.log(tests.length + ' WeChat login cloud checks passed') })().catch(error => { console.error(error); process.exitCode = 1 })
