const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const root = path.resolve(__dirname, '..')
const app = require('../app.json')
const location = require('../utils/location')
const clientState = require('../utils/client-state')
const calls = []
let privacyAllowed = true
let locationFailure = null
let handler = async () => ({ items: [] })
let definition
const venue = (id, distanceMeters) => ({ id, name: id, location: { longitude: 120, latitude: 30 }, distanceMeters })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
global.wx = {
  requirePrivacyAuthorize(options) { calls.push('privacy'); privacyAllowed ? options.success() : options.fail() },
  getFuzzyLocation(options) { calls.push('location'); assert.strictEqual(options.type, 'gcj02'); locationFailure ? options.fail(locationFailure) : options.success({ longitude: 120, latitude: 30 }) },
  switchTab(options) { calls.push(options.url) },
  navigateTo(options) { calls.push(options.url) },
  openSetting() { calls.push('settings') },
  showToast() {}
}
vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/nearby-venues/nearby-venues.js'), 'utf8'), {
  Page(value) { definition = value }, wx: global.wx,
  require(name) {
    if (name === '../../utils/api') return { venues: { nearby(payload, options) {
      calls.push({ payload, options }); return handler(payload)
    } } }
    return require(path.resolve(root, 'pages/nearby-venues', name))
  }
})
function page() {
  const p = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  p.setData = patch => Object.assign(p.data, patch)
  p.onLoad()
  return p
}
async function run() {
  assert(app.permission['scope.userFuzzyLocation'].desc)
  assert(!app.permission['scope.userLocation'])
  assert(!app.requiredPrivateInfos.includes('getLocation'))
  assert(app.requiredPrivateInfos.includes('getFuzzyLocation'))
  assert(app.pages.includes('pages/nearby-venues/nearby-venues'))
  const p = page()
  assert.strictEqual(calls.length, 0, 'opening page must not trigger location or network')
  await p.changeRadius({ detail: { value: 1 } })
  assert.strictEqual(calls.length, 0)
  privacyAllowed = false
  await p.locateNearby()
  assert.deepStrictEqual(calls, ['privacy'])
  assert.strictEqual(p.data.state, 'error')
  privacyAllowed = true
  locationFailure = { errMsg: 'getFuzzyLocation:fail auth deny' }
  await p.retry()
  assert(p.data.permissionDenied)
  assert.strictEqual(p.position, null)
  locationFailure = null
  handler = async () => ({ items: [venue('far', 2500), venue('near', 100), { id: 'missing' }] })
  await p.locateNearby()
  assert.strictEqual(p.data.state, 'ready')
  assert.strictEqual(p.data.venues.map(v => v.id).join(','), 'near,far')
  assert.strictEqual(p.data.venues[0].distanceText, '约 1 公里内')
  assert.strictEqual(p.data.venues[1].distanceText, '约 3 公里')
  const request = calls.find(c => c.payload)
  assert.strictEqual(request.payload.radiusMeters, 5000)
  assert.strictEqual(request.options.publicRead, true)
  assert.strictEqual(request.payload.latitude, 30)
  assert(!Object.hasOwn(p.data, 'latitude') && !Object.hasOwn(p.data, 'longitude'), 'user position is not rendered')
  const old = deferred()
  handler = () => old.promise
  const first = p.changeRadius({ detail: { value: 2 } })
  handler = async () => ({ items: [venue('new', 4000)] })
  await p.changeRadius({ detail: { value: 3 } })
  old.resolve({ items: [venue('stale', 100)] })
  await first
  assert.strictEqual(p.data.venues[0].id, 'new', 'stale response cannot replace current radius')
  handler = async () => { throw new Error('网络错误') }
  await p.loadVenues()
  assert.strictEqual(p.data.state, 'error')
  assert.strictEqual(p.data.venues.length, 0)
  const locationsBefore = calls.filter(c => c === 'location').length
  handler = async () => ({ items: [] })
  await p.retry()
  assert.strictEqual(calls.filter(c => c === 'location').length, locationsBefore, 'query retry reuses session position')
  assert.strictEqual(p.data.state, 'ready')
  await p.expandRadius()
  assert.strictEqual(p.data.radiusIndex, 4)
  p.browseVenues()
  assert.strictEqual(clientState.consumeHomeDestination(), 'venues')
  assert(calls.includes('/pages/home/home'))
  const pending = deferred()
  handler = () => pending.promise
  const work = p.loadVenues()
  p.onUnload()
  pending.resolve({ items: [venue('late', 1)] })
  await work
  assert.strictEqual(p.position, null)
  assert.strictEqual(p.data.venues.length, 0)
  const original = wx.getFuzzyLocation
  wx.getFuzzyLocation = options => options.success({ longitude: 200, latitude: 30 })
  await assert.rejects(location.locate(), /有效位置/)
  wx.getFuzzyLocation = undefined
  const beforeUnsupported = calls.length
  await assert.rejects(location.locate(), error => error.code === 'LOCATION_UNSUPPORTED')
  assert.strictEqual(calls.length, beforeUnsupported, 'unsupported clients do not request privacy or exact location')
  wx.getFuzzyLocation = original
  wx.canIUse = () => false
  await assert.rejects(location.locate(), error => error.code === 'LOCATION_UNSUPPORTED')
  delete wx.canIUse
  const beforeCancelled = calls.filter(c => c === 'location').length
  await assert.rejects(location.locate(() => false), error => error.code === 'LOCATION_CANCELLED')
  assert.strictEqual(calls.filter(c => c === 'location').length, beforeCancelled)
  locationFailure = { errMsg: 'getFuzzyLocation:fail:system permission denied' }
  await assert.rejects(location.locate(), error => error.code === 'LOCATION_FAILED' && error.message.includes('系统设置'))
  locationFailure = null
  for (const value of [null, undefined, NaN, -1]) assert.strictEqual(location.fuzzyDistanceText(value), '')
  assert.strictEqual(location.fuzzyDistanceText(0), '约 1 公里内')
  assert.strictEqual(location.fuzzyDistanceText(12400), '约 12 公里')
  console.log('nearby venues: opt-in, privacy, denial, sorting, radius races, retry, fallback and unload passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
