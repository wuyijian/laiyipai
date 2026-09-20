const assert = require('assert')
const fs = require('fs')
const path = require('path')

const events = []

global.wx = {
  showToast(options) { events.push({ type: 'toast', options }) },
  setClipboardData(options) {
    events.push({ type: 'copy', data: options.data })
    if (options.success) options.success()
  },
  openLocation(options) { events.push({ type: 'open', options }) }
}

const geo = require('../utils/geo')
const map = require('../utils/map')
const present = require('../utils/present')

function reset() { events.length = 0 }

function run() {
  assert.deepStrictEqual(geo.normalizePoint({ latitude: '30.2741', longitude: '120.1551' }), {
    latitude: 30.2741,
    longitude: 120.1551
  })
  assert.deepStrictEqual(geo.normalizePoint({ coordinates: [120.1551, 30.2741] }), {
    latitude: 30.2741,
    longitude: 120.1551
  })
  ;[
    null,
    {},
    { latitude: '', longitude: null },
    { latitude: 91, longitude: 120 },
    { latitude: 30, longitude: 181 },
    { coordinates: [120] }
  ].forEach(value => assert.strictEqual(geo.normalizePoint(value), null))

  const invalidVenue = present.venue({
    id: 'venue-invalid',
    name: '坐标待核对球馆',
    address: '测试路 1 号',
    location: { latitude: '', longitude: null }
  })
  assert.strictEqual(invalidVenue.hasLocation, false)
  assert.strictEqual(invalidVenue.location, null)

  const mappedMatch = present.match({
    venue: {
      id: 'venue-snapshot',
      name: '球局快照球馆',
      address: '测试路 3 号',
      location: { latitude: 30.29, longitude: 120.16 },
      listingMode: 'full'
    }
  })
  assert.strictEqual(mappedMatch.hasLocation, true)
  assert.deepStrictEqual(mappedMatch.location, { latitude: 30.29, longitude: 120.16 })
  assert(mappedMatch.venueLocationText.includes('测试路 3 号'))

  reset()
  map.openLocation('坐标待核对球馆', '测试路 1 号', { latitude: '', longitude: null }, true, { copyHint: true })
  assert(!events.some(item => item.type === 'open'))
  assert.deepStrictEqual(events.find(item => item.type === 'copy'), { type: 'copy', data: '测试路 1 号' })

  reset()
  map.openLocation('正常球馆', '测试路 2 号', { latitude: '30.28', longitude: '120.14' }, true, { copyHint: true })
  const opened = events.find(item => item.type === 'open').options
  assert.strictEqual(opened.latitude, 30.28)
  assert.strictEqual(opened.longitude, 120.14)
  opened.fail()
  assert.deepStrictEqual(events.find(item => item.type === 'copy'), { type: 'copy', data: '测试路 2 号' })

  reset()
  map.openLocation('名称球馆', '', null, false, { copyHint: true, noLocationMessage: '请在球局中确认' })
  assert(!events.some(item => item.type === 'copy' || item.type === 'open'))
  assert.strictEqual(events.find(item => item.type === 'toast').options.title, '请在球局中确认')

  const root = path.resolve(__dirname, '..')
  const homeTemplate = fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8')
  const venueTemplate = fs.readFileSync(path.join(root, 'pages/venue-detail/venue-detail.wxml'), 'utf8')
  const matchTemplate = fs.readFileSync(path.join(root, 'pages/match-detail/match-detail.wxml'), 'utf8')
  const chatTemplate = fs.readFileSync(path.join(root, 'pages/chat/chat.wxml'), 'utf8')
  assert(homeTemplate.includes('wx:if="{{item.locationText || item.hasLocation}}"'))
  assert(homeTemplate.includes("{{item.hasLocation ? '导航' : '复制'}}"))
  assert(homeTemplate.includes('catchtap="openMatchMap"'))
  assert(venueTemplate.includes('wx:if="{{venue.locationText || venue.hasLocation}}"'))
  assert(venueTemplate.includes("{{venue.hasLocation ? '地图导航' : '复制地址'}}"))
  assert(matchTemplate.includes('wx:if="{{match.venueLocationText || match.hasLocation}}"'))
  assert(matchTemplate.includes('catchtap="openMap"'))
  assert(chatTemplate.includes('class="summary-location"'))
  assert(chatTemplate.includes('catchtap="openMap"'))

  console.log('map and coordinate checks passed')
}

run()
