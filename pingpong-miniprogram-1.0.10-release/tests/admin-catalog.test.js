const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const apiPath = require.resolve(path.join(root, 'utils/api'))
let definition
let venuesHandler
let coachesHandler
let removeVenueHandler
let removeCoachHandler
let upsertVenueHandler
let requestSequence
let modals
let notices
let navigation

function clone(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)) }
function error(code, details) { return Object.assign(new Error(code), { code, details }) }

const api = {
  createRequestId() { requestSequence += 1; return `request_catalog_${requestSequence}` },
  admin: {
    listVenues(payload) { return venuesHandler(payload) },
    listCoaches(payload) { return coachesHandler(payload) },
    removeVenue(payload, options) { return removeVenueHandler(payload, options) },
    removeCoach(payload, options) { return removeCoachHandler(payload, options) }
    ,upsertVenue(payload, options) { return upsertVenueHandler(payload, options) }
  }
}
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: api }
global.Page = (value) => { definition = value }
global.getApp = () => ({ ensureSession: async () => ({ capabilities: { adminVenueReview: true } }) })
global.wx = {
  hideShareMenu() {}, stopPullDownRefresh() {},
  showToast(value) { notices.push(value) },
  showModal(value) { modals.push(value); value.success({ confirm: true, cancel: false }) },
  navigateTo(value) { navigation.push(value.url) }
}
delete require.cache[require.resolve(path.join(root, 'pages/admin-catalog/admin-catalog'))]
require(path.join(root, 'pages/admin-catalog/admin-catalog'))

function page() {
  requestSequence = 0
  modals = []
  notices = []
  navigation = []
  venuesHandler = async (payload) => ({
    items: [{ id: 'venue_1', name: '萧潮乒乓', listingMode: 'full', district: '滨江区', address: '滨江区江南大道 1 号', location: { coordinates: [120.2, 30.2] }, verificationStatus: 'verified', verificationDate: '2026-09-01', sourceUrls: ['https://example.com/venue'], active: true }],
    page: payload.page, pageSize: payload.pageSize, hasMore: false
  })
  coachesHandler = async (payload) => ({
    items: [{ id: 'coach_1', name: '陈教练', specialty: ['基本功'], venueIds: ['venue_1'], active: false }],
    page: payload.page, pageSize: payload.pageSize, hasMore: false
  })
  removeVenueHandler = async () => ({ id: 'venue_1', deleted: true })
  removeCoachHandler = async () => ({ id: 'coach_1', deleted: true })
  upsertVenueHandler = async payload => payload
  const instance = Object.assign({}, definition, { data: clone(definition.data) })
  instance.setData = function setData(patch, done) { Object.assign(this.data, patch); if (done) done() }
  instance.onLoad()
  return instance
}

async function run() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  const project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
  const template = fs.readFileSync(path.join(root, 'pages/admin-catalog/admin-catalog.wxml'), 'utf8')
  const profileTemplate = fs.readFileSync(path.join(root, 'pages/profile/profile.wxml'), 'utf8')
  assert(app.pages.includes('pages/admin-catalog/admin-catalog'))
  assert(project.packOptions.include.some((item) => item.value === 'pages/admin-catalog'))
  assert(template.includes('bindtap="requestRemove"'))
  assert(template.includes('bindtap="openVenueEditor"'))
  assert(template.includes('bindchange="changeDistrictFilter"'))
  assert(template.includes('历史球局和预约仍会保留'))
  assert(profileTemplate.includes('bindtap="openAdminCatalog"'))

  const catalog = page()
  await catalog.onShow()
  assert.strictEqual(catalog.data.state, 'ready')
  assert.deepStrictEqual(catalog.data.items.map((item) => item.id), ['venue_1'])
  await catalog.changeDistrictFilter({ detail: { value: 1 } })
  assert.strictEqual(catalog.data.districtIndex, 1)
  catalog.openVenueEditor({ currentTarget: { dataset: { id: 'venue_1' } } })
  assert.strictEqual(catalog.data.editorVisible, true)
  const venueSaves = []
  upsertVenueHandler = async payload => { venueSaves.push(payload); return payload }
  await catalog.saveVenue()
  assert.strictEqual(venueSaves[0].district, '滨江区')
  assert.strictEqual(venueSaves[0].verificationStatus, 'verified')
  assert.strictEqual(venueSaves[0].longitude, 120.2)
  assert.strictEqual(venueSaves[0].adminVerified, true)
  await catalog.switchType({ currentTarget: { dataset: { type: 'coaches' } } })
  assert.deepStrictEqual(catalog.data.items.map((item) => item.id), ['coach_1'])

  const coachCalls = []
  removeCoachHandler = async (payload, options) => { coachCalls.push({ payload, options }); return { id: payload.coachId, deleted: true } }
  await catalog.requestRemove({ currentTarget: { dataset: { id: 'coach_1' } } })
  assert.strictEqual(modals[0].title, '删除教练？')
  assert.deepStrictEqual(coachCalls[0], {
    payload: { coachId: 'coach_1', reason: '管理员在内容管理页删除' },
    options: { requestId: 'request_catalog_1', retry: false }
  })
  assert.strictEqual(catalog.data.items.length, 0)
  assert(notices.some(item => item.title === '已删除'))

  const retryCatalog = page()
  await retryCatalog.onShow()
  const attempts = []
  removeVenueHandler = async (payload, options) => {
    attempts.push(options.requestId)
    if (attempts.length === 1) throw error('REQUEST_TIMEOUT', { outcomeUnknown: true })
    return { id: payload.venueId, deleted: true }
  }
  await retryCatalog.requestRemove({ currentTarget: { dataset: { id: 'venue_1' } } })
  assert(retryCatalog.data.removalError.includes('尚未确认'))
  assert.strictEqual(retryCatalog.data.items.length, 1)
  await retryCatalog.requestRemove({ currentTarget: { dataset: { id: 'venue_1' } } })
  assert.deepStrictEqual(attempts, ['request_catalog_1', 'request_catalog_1'])
  assert.strictEqual(retryCatalog.data.items.length, 0)

  const communityCatalog = page()
  venuesHandler = async () => ({ items: [{ id: 'community_1', name: '球友新馆', address: '长河路 88 号 2 楼', listingMode: 'full', verified: false, userContributed: true, verificationStatus: 'verified', active: true }], page: 1 })
  await communityCatalog.onShow()
  assert.strictEqual(communityCatalog.data.items[0].statusLabel, '未认证 · 公开可用')
  communityCatalog.openVenueEditor({ currentTarget: { dataset: { id: 'community_1' } } })
  assert.strictEqual(communityCatalog.data.verificationIndex, 3)
  assert.strictEqual(communityCatalog.data.editDistrictIndex, 0, '不能静默把未知区域设成滨江区')
  communityCatalog.changeVerification({ detail: { value: 1 } })
  let certifiedPayload
  upsertVenueHandler = async payload => { certifiedPayload = payload; return payload }
  await communityCatalog.saveVenue()
  assert.strictEqual(certifiedPayload.adminVerified, true)
  assert.strictEqual(certifiedPayload.longitude, undefined)
  assert.strictEqual(certifiedPayload.latitude, undefined)
  assert.deepStrictEqual(certifiedPayload.sourceUrls, [])
  assert.strictEqual(certifiedPayload.district, '')
  assert.strictEqual(communityCatalog.data.editorVisible, false)
  communityCatalog.openVenueEditor({ currentTarget: { dataset: { id: 'community_1' } } })
  communityCatalog.changeVerification({ detail: { value: 1 } })
  communityCatalog.changeEditField({ currentTarget: { dataset: { field: 'address' } }, detail: { value: '' } })
  await communityCatalog.saveVenue()
  assert(communityCatalog.data.saveError.includes('完整球馆地址'))
  console.log('PASS 球友录入不会显示已认证，管理员填写地址即可认证，不自动补坐标或区域')
  console.log('admin catalog client tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
