const assert = require('assert')
const path = require('path')
const Module = require('module')

const root = path.resolve(__dirname, '..')
const tests = []
const test = (name, run) => tests.push({ name, run })
const virtualModules = new Map()
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (virtualModules.has(request)) return virtualModules.get(request)
  return originalLoad.call(this, request, parent, isMain)
}

function mock(filename, exports) {
  if (filename === 'wx-server-sdk') {
    virtualModules.set(filename, exports)
    return
  }
  const resolved = require.resolve(filename)
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports }
}

function routeModule(methods, onCall) {
  return Object.fromEntries(methods.map(name => [name, async (context, payload) => {
    onCall(context, payload)
    return name === 'get' ? { id: payload.venueId || payload.matchId || payload.coachId || 'public' } : { items: [] }
  }]))
}

function loadApi() {
  const calls = { identity: [], handlers: [], rateLimit: [] }
  const wxContext = { OPENID: 'openid_from_wechat_context', APPID: 'wx_review_test' }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    database: () => ({}),
    getWXContext: () => wxContext
  }
  mock('wx-server-sdk', cloud)

  mock(path.join(root, 'lib', 'auth.js'), {
    attachPublicIdentity: (context) => {
      context.openid = context.wxContext.OPENID
      context.publicRead = true
      return context.openid
    },
    requireIdentity: async (context, options) => {
      calls.identity.push({ action: context.action, options })
      context.openid = context.wxContext.OPENID
      context.user = { _id: context.openid, status: 'active', profile: {} }
    },
    bootstrap: async () => ({ profile: { playerId: 'player' } }),
    isAdmin: () => false,
    requireAdmin() {},
    privacyVersion: () => 'test'
  })
  mock(path.join(root, 'lib', 'rate-limit.js'), {
    consume: async (context, action) => { calls.rateLimit.push({ action, openid: context.openid }) }
  })
  const record = action => context => calls.handlers.push({ action, openid: context.openid, apiVersion: context.apiVersion })
  mock(path.join(root, 'lib', 'venues.js'), routeModule(['list', 'nearby', 'get'], record('venues')))
  mock(path.join(root, 'lib', 'matches.js'), routeModule([
    'list', 'get', 'create', 'join', 'pending', 'respondJoin', 'cancel', 'reschedule', 'confirmSchedule'
  ], record('matches')))
  mock(path.join(root, 'lib', 'coaches.js'), routeModule(['list', 'get'], record('coaches')))
  mock(path.join(root, 'lib', 'files.js'), routeModule(['resolve'], record('files')))
  mock(path.join(root, 'lib', 'favorites.js'), routeModule(['list', 'status', 'set'], record('favorites')))

  const indexPath = path.join(root, 'index.js')
  delete require.cache[require.resolve(indexPath)]
  const api = require(indexPath)
  return { api, calls, wxContext }
}

function event(action, payload = {}, publicRead = false, apiVersion = 1) {
  return { apiVersion, action, payload, publicRead, requestId: `review_${action.replace(/\W/g, '_')}` }
}

test('云函数滚动升级期间同时接受 API v1 与 v2，并把版本传给业务路由', async () => {
  const { api, calls } = loadApi()
  const oldClient = await api.main(event('venues.list', {}, true, 1))
  const newClient = await api.main(event('venues.list', {}, true, 2))
  assert.equal(oldClient.ok, true)
  assert.equal(newClient.ok, true)
  assert.deepEqual(calls.handlers.slice(-2).map(item => item.apiVersion), [1, 2])

  const futureClient = await api.main(event('venues.list', {}, true, 3))
  assert.equal(futureClient.ok, false)
  assert.equal(futureClient.error.code, 'API_VERSION_UNSUPPORTED')
  assert.equal(futureClient.error.message, '服务正在更新，请稍后重试')
})

test('公开发现接口不要求用户建档，但仍只使用可信微信上下文标识做限流', async () => {
  const { api, calls, wxContext } = loadApi()
  const publicReads = [
    ['venues.list', {}],
    ['venues.get', { venueId: 'venue_public' }],
    ['matches.list', {}],
    ['matches.get', { matchId: 'match_public' }],
    ['coaches.list', {}],
    ['coaches.get', { coachId: 'coach_public' }],
    ['files.resolve', { fileIds: ['cloud://public/file.jpg'] }]
  ]
  for (const [action, payload] of publicReads) {
    const before = calls.identity.length
    const response = await api.main(event(action, payload, true))
    assert.equal(response.ok, true, `${action} 应允许游客读取`)
    assert.equal(calls.identity.length, before, `${action} 不应先调用 requireIdentity 或创建 users 文档`)
    assert.equal(calls.rateLimit.at(-1).openid, wxContext.OPENID, `${action} 的服务端标识必须来自 wxContext`)
  }
})

test('同一公开 action 未显式请求游客模式时仍走完整身份检查', async () => {
  const { api, calls } = loadApi()
  const response = await api.main(event('matches.get', { matchId: 'match_member' }))
  assert.equal(response.ok, true)
  assert.deepEqual(calls.identity.map(item => item.action), ['matches.get'])
  assert.equal(calls.handlers.at(-1).action, 'matches')
})

test('用户收藏等私有写操作继续强制身份检查', async () => {
  const { api, calls } = loadApi()
  const response = await api.main(event('favorites.set', { venueId: 'venue_public', marked: true }, true))
  assert.equal(response.ok, true)
  assert.deepEqual(calls.identity.map(item => item.action), ['favorites.set'])
  assert.equal(calls.handlers.at(-1).action, 'favorites')
})

;(async () => {
  for (const item of tests) {
    await item.run()
    console.log(`PASS ${item.name}`)
  }
  console.log(`${tests.length} review compliance cloud checks passed`)
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
