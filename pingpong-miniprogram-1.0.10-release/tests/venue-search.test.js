const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
let definition
let requestSequence = 0
const memory = {}
const navigation = []
const clone = (value) => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const failure = (code, outcomeUnknown = false) => Object.assign(new Error(code), {
  code,
  details: { outcomeUnknown }
})
const venue = (id, name, address = '') => ({
  id, name, address, city: '杭州', district: '滨江区',
  listingMode: 'full', activityTags: [], coverFileIds: []
})

let favoriteHandler = async () => ({ items: [] })
let createHandler = async () => ({ match: {} })
const venueCalls = []
const api = {
  createRequestId: () => `publish_request_${++requestSequence}`,
  venues: {
    list: async (payload) => {
      venueCalls.push(clone(payload))
      if (payload.keyword) {
        if (payload.page === 1) return { items: [venue('search_1', '远洋乒乓球馆', '上城区体育场路 1 号')], hasMore: true }
        return { items: [venue('search_2', '社区运动馆', '滨江区远洋街 8 号')], hasMore: false }
      }
      if (payload.page === 1) return { items: [venue('catalog_1', '阿里体育馆')], hasMore: true }
      return { items: [venue('catalog_2', '滨江全民健身中心')], hasMore: false }
    },
    get: async ({ venueId }) => {
      if (venueId === 'removed_venue') throw failure('NOT_FOUND')
      return venue(venueId, '已选球馆')
    }
  },
  favorites: { list: (payload) => favoriteHandler(payload) },
  matches: { create: (payload, options) => createHandler(payload, options) }
}

global.Page = (value) => { definition = value }
global.getApp = () => ({
  globalData: { session: { profile: {} } },
  ensureSession: async () => ({})
})
global.wx = {
  getStorageSync: (key) => memory[key],
  setStorageSync: (key, value) => { memory[key] = clone(value) },
  removeStorageSync: (key) => { delete memory[key] },
  navigateTo: (options) => navigation.push(options),
  switchTab() {}, pageScrollTo() {}, showToast() {}, hideShareMenu() {}, showShareMenu() {}
}

const apiFile = require.resolve(path.join(root, 'utils/api'))
require.cache[apiFile] = { id: apiFile, filename: apiFile, loaded: true, exports: api }

function page() {
  const filename = require.resolve(path.join(root, 'pages/publish/publish'))
  delete require.cache[filename]
  require(filename)
  const result = Object.assign({}, definition, { data: clone(definition.data) })
  result.setData = function (patch, done) {
    Object.assign(this.data, patch)
    if (done) done()
  }
  return result
}

async function loadedPage() {
  const result = page()
  result.onLoad({})
  await result.venueLoading
  return result
}

async function testCloudSearch() {
  const venues = require('../cloudfunctions/api/lib/venues')
  const directory = [
    { _id: 'by_name', name: '远洋乒乓球馆', address: '上城区体育场路 1 号', city: '杭州', active: true, verificationStatus: 'verified' },
    { _id: 'by_address', name: '社区运动馆', address: '滨江区远洋街 8 号', city: '杭州', active: true, verificationStatus: 'verified' },
    { _id: 'hidden', name: '远洋内部馆', address: '远洋街', city: '杭州', active: false, verificationStatus: 'verified' }
  ]
  let requestedLimit = 0
  let capturedCondition
  const context = {
    command: { or: (branches) => ({ $or: branches }) },
    db: {
      RegExp: ({ regexp, options }) => new RegExp(regexp, options),
      collection: () => ({
        where(condition) { capturedCondition = condition; return this },
        orderBy() { return this },
        skip() { return this },
        limit(value) { requestedLimit = value; return this },
        async get() {
          const matches = (row, branch) => Object.entries(branch).every(([key, expected]) => (
            expected instanceof RegExp ? expected.test(String(row[key] || '')) : row[key] === expected
          ))
          return { data: directory.filter((row) => capturedCondition.$or.some((branch) => matches(row, branch))) }
        }
      })
    }
  }
  const result = await venues.list(context, { keyword: '远洋', page: 1, pageSize: 2 })
  assert.strictEqual(requestedLimit, 3, '应多取一条探测 hasMore')
  assert.deepStrictEqual(result.items.map((item) => item.id), ['by_name', 'by_address'])
  assert.strictEqual(capturedCondition.$or.length, 2)
  assert(capturedCondition.$or.some((branch) => branch.name instanceof RegExp), '需要搜索球馆名称')
  assert(capturedCondition.$or.some((branch) => branch.address instanceof RegExp), '需要搜索完整地址')
  assert(capturedCondition.$or.every((branch) => branch.active === true && branch.verificationStatus === 'verified'))
  console.log('PASS 云端球馆搜索覆盖名称与完整地址，并保留公开状态过滤')
}

async function run() {
  await testCloudSearch()

  const favoriteGate = deferred()
  let favoriteReads = 0
  favoriteHandler = () => {
    favoriteReads += 1
    if (favoriteReads === 1) throw failure('NETWORK_ERROR')
    return favoriteGate.promise
  }
  const publish = await loadedPage()
  assert.strictEqual(publish.data.loadState, 'ready', '常去球馆失败不能阻塞公开目录')
  assert(publish.data.venues.some((item) => item.id === 'catalog_1'), '首页公开目录应立即可用')
  assert.strictEqual(favoriteReads, 2, '常去球馆应在后台自动重试一次')
  assert.deepStrictEqual(
    venueCalls.filter((call) => !call.keyword).map((call) => call.page),
    [1],
    '发布首屏只加载一页目录，不应在后台下载整个杭州球馆库'
  )
  const favoriteLoading = publish.favoriteLoading
  favoriteGate.resolve({ items: [venue('catalog_2', '滨江全民健身中心')] })
  await favoriteLoading
  assert.deepStrictEqual(publish.data.venues.map((item) => item.id), ['catalog_2', 'catalog_1'])
  assert.strictEqual(publish.data.venues[0].favorited, true)
  console.log('PASS 常去球馆后台重试不阻塞目录，恢复后自动优先排序')

  venueCalls.length = 0
  publish.inputVenueSearch({ detail: { value: '远洋' } })
  await publish.searchVenues()
  const searchPages = venueCalls.filter((call) => call.keyword === '远洋').map((call) => call.page)
  assert.deepStrictEqual(searchPages, [1], '搜索只读取可展示的首批结果，不应下载所有命中页')
  assert.deepStrictEqual(publish.data.filteredVenues.map((item) => item.id), ['search_1'])
  assert.strictEqual(publish.data.venueSearchHasMore, true)
  await publish.searchVenues()
  assert.deepStrictEqual(
    venueCalls.filter((call) => call.keyword === '远洋').map((call) => call.page),
    [1],
    '重复搜索相同名称或地址应复用页面内结果'
  )
  console.log('PASS 发布页全库搜索按需读取并复用相同关键词结果')

  publish.setData({ venueId: 'removed_venue', selectedVenue: null })
  publish.restoreVenueSelection()
  assert.strictEqual(publish.data.venueId, '')
  assert(publish.data.venueSelectionError.includes('已下架'), '失效已选球馆必须有明确提示')
  console.log('PASS 失效已选球馆会被清理并明确提示')

  const beforeDynamic = clone(publish.data)
  publish.applyPrefill({ source: 'friend-update', venueId: 'search_1', date: '2099-01-01', startTime: '19:00', endTime: '21:00' })
  assert.strictEqual(publish.data.venueId, beforeDynamic.venueId, '审核版不应从动态预填发球局表单')
  console.log('PASS 审核版不接受动态预填')

  const chosen = venue('catalog_1', '阿里体育馆')
  publish.setData({
    venueId: chosen.id, selectedVenue: chosen,
    date: '2099-09-12', dateLabel: '2099-09-12', startTime: '19:00', endTime: '21:00',
    title: '', capacity: 2, ballAgeIndex: 0, practiceIntent: '随便练练', joinMode: 'direct',
    courtStatus: 'unbooked', feePerPerson: '', note: '', termsAccepted: true,
    loadState: 'ready', publishOutcomeUnknown: false
  })
  const mutationCalls = []
  createHandler = async (payload, options) => {
    mutationCalls.push({ payload: clone(payload), requestId: options.requestId })
    if (mutationCalls.length <= 2) throw failure('REQUEST_TIMEOUT', true)
    return { match: Object.assign({
      id: 'match_created', participantCount: 1, status: 'recruiting', venueName: chosen.name,
      scheduleText: '2099-09-12 19:00—21:00'
    }, payload) }
  }
  await publish.submit()
  assert.strictEqual(publish.data.publishOutcomeUnknown, true)
  assert.strictEqual(mutationCalls.length, 2, '首次未知结果应自动用同一请求对账一次')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(mutationCalls[0].payload, 'title'), false, '标题应由后端根据结构化字段生成')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(mutationCalls[0].payload, 'note'), false, '发布球局不应夹带自由文本备注')
  assert.strictEqual(mutationCalls[0].requestId, mutationCalls[1].requestId)
  const reloaded = await loadedPage()
  assert.strictEqual(reloaded.data.publishOutcomeUnknown, true, '未知结果应跨页面重载保留对账信息')
  await reloaded.submit()
  assert.strictEqual(mutationCalls[2].requestId, mutationCalls[0].requestId, '手动确认必须复用原 requestId')
  assert.deepStrictEqual(mutationCalls[2].payload, mutationCalls[0].payload, '手动确认必须复用原始快照')
  assert.strictEqual(reloaded.data.publishedMatch.id, 'match_created')
  console.log('PASS 发布防重，且弱网未知结果使用原请求安全对账')

  const template = fs.readFileSync(path.join(root, 'pages/publish/publish.wxml'), 'utf8')
  assert(!template.includes('open-type="share"'), '发布成功页不应诱导分享')
  assert(!template.includes('<textarea') && !template.includes('球局标题'), '发布页只保留结构化信息')
  assert(template.includes('bindtap="openPublishedMatch"') && template.includes('查看球局'))
  console.log('PASS 成功页仅提供查看球局，不使用分享按钮')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
