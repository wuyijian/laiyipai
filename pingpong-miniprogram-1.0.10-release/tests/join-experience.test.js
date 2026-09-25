const assert = require('assert')
const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const apiPath = path.join(projectRoot, 'utils', 'api.js')
const detailPath = path.join(projectRoot, 'pages', 'match-detail', 'match-detail.js')
const present = require(path.join(projectRoot, 'utils', 'present.js'))
let capturedPage = null
let requestSequence = 0
const navigation = []
const notices = []
let actionSheetCalls = 0

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function setPath(target, key, value) {
  const parts = key.split('.')
  let cursor = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!cursor[parts[index]] || typeof cursor[parts[index]] !== 'object') cursor[parts[index]] = {}
    cursor = cursor[parts[index]]
  }
  cursor[parts[parts.length - 1]] = value
}

function instantiate(definition) {
  const page = {}
  Object.keys(definition).forEach((key) => {
    page[key] = key === 'data' ? clone(definition[key]) : definition[key]
  })
  page.setData = function setData(patch, callback) {
    Object.keys(patch).forEach((key) => setPath(this.data, key, patch[key]))
    if (callback) callback()
  }
  return page
}

global.Page = (definition) => { capturedPage = definition }
global.getApp = () => ({
  globalData: { session: { profile: { playerId: 'player-join-test' } } },
  ensureSession: async () => ({ profile: { playerId: 'player-join-test' } })
})
global.wx = {
  hideShareMenu() {},
  showShareMenu() {},
  stopPullDownRefresh() {},
  showToast(options) { notices.push(options) },
  showActionSheet() { actionSheetCalls += 1 },
  navigateTo(options) { navigation.push(options.url) },
  switchTab(options) { navigation.push(options.url) }
}

function rawMatch(overrides = {}) {
  return Object.assign({
    id: 'match-join-copy',
    title: '周末练球',
    venueId: 'venue-1',
    venue: { id: 'venue-1', name: '黄龙体育中心', address: '黄龙路 1 号' },
    date: '2026-09-12',
    startTime: '19:00',
    endTime: '20:30',
    capacity: 4,
    participantCount: 1,
    seats: 3,
    feePerPerson: 30,
    joinMode: 'direct',
    courtStatus: 'booked',
    status: 'recruiting',
    host: { playerId: 'host-1', displayName: '发起人' },
    participants: []
  }, overrides)
}

function installApi(api) {
  const resolved = require.resolve(apiPath)
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: api, children: [], paths: [] }
}

function loadDetail(api) {
  installApi(api)
  delete require.cache[require.resolve(detailPath)]
  capturedPage = null
  require(detailPath)
  assert(capturedPage, 'match-detail page should register')
  return instantiate(capturedPage)
}

function apiFor(match, status, canChat, options = {}) {
  let membership = null
  return {
    createRequestId() { requestSequence += 1; return `req_join_${requestSequence}` },
    matches: {
      get: async () => {
        if (membership && options.failRefresh) throw new Error('refresh failed')
        const refreshedMembership = membership && options.refreshCanChat !== undefined
          ? Object.assign({}, membership, { canChat: options.refreshCanChat })
          : membership
        return { match, membership: refreshedMembership, confirmedCount: match.participantCount }
      },
      join: async () => {
        membership = { status, canChat }
        return { match, membership }
      }
    },
    venues: { get: async () => match.venue },
    favorites: { status: async () => ({ markedIds: [] }) },
    files: { resolve: async () => ({ urls: {} }) }
  }
}

async function verifyOutcome(match, status, canChat, options) {
  const page = loadDetail(apiFor(match, status, canChat, options))
  page.onLoad({ id: match.id })
  await page.loadMatch()
  await page.confirmJoin()
  return page
}

async function run() {
  const { detailState } = require('../utils/match-detail-state')
  const { variant } = require('../utils/avatar')
  assert.deepStrictEqual(variant('player-one'), variant('player-one'), '同一账号头像应跨页面一致')
  assert(new Set(Array.from({ length: 32 }, (_, index) => variant(`player-${index}`).blade)).size >= 6, '不同球友应获得有区分度的默认头像')
  const changed = detailState(present.match(rawMatch({ scheduleVersion: 2, status: 'changed' })), { status: 'joined', confirmedScheduleVersion: 1, canChat: true })
  assert.strictEqual(changed.actionKind, 'confirm')
  assert.strictEqual(changed.actionDisabled, false)
  const host = detailState(present.match(rawMatch()), { status: 'host', canChat: true })
  assert.strictEqual(host.actionKind, 'orders')
  const closed = detailState(present.match(rawMatch({ status: 'cancelled' })), null)
  assert.strictEqual(closed.actionKind, 'home')
  assert(!closed.seatSlots.some((seat) => seat.empty), '已取消球局不展示待加入空位')
  const privateMembers = detailState(present.match(rawMatch({ participantCount: 3, seats: 1, participants: [] })), null)
  assert.strictEqual(privateMembers.seatSlots.filter((seat) => seat.private).length, 3)
  assert.strictEqual(privateMembers.seatSlots.filter((seat) => seat.empty).length, 1)
  const booked = present.match(rawMatch())
  let releaseVenue
  const delayedVenue = new Promise((resolve) => { releaseVenue = resolve })
  const slowApi = apiFor(rawMatch(), 'joined', true)
  slowApi.venues.get = () => delayedVenue
  const fastDetail = loadDetail(slowApi)
  fastDetail.onLoad({ id: 'match-fast-detail' })
  const loadingDetail = fastDetail.loadMatch()
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(fastDetail.data.state, 'ready', '球馆和媒体加载不能阻塞时间、名额及主按钮')
  await fastDetail.primaryAction()
  assert.strictEqual(fastDetail.data.joinSheet, true)
  releaseVenue(rawMatch().venue)
  await loadingDetail
  assert.strictEqual(booked.courtStatusText, '发起人已订台')
  assert.strictEqual(booked.courtStatusMeta, '发起人填写 · 平台未核验')
  assert(booked.courtBookingNotice.includes('加入球局不等于向球馆预订'))
  assert(!booked.joinSheetCopy.includes('服务端'))
  assert(booked.joinSheetCopy.includes('名额确认后即可进入球局对话'))
  assert.strictEqual(booked.practiceIntentLabel, '随便练练')

  const fillingMatch = rawMatch({ scheduleVersion: 2 })
  const fullApi = apiFor(fillingMatch, 'waitlisted', false)
  const joinPayloads = []
  const originalJoin = fullApi.matches.join
  fullApi.matches.join = async (payload) => {
    joinPayloads.push(payload)
    if (joinPayloads.length === 1) {
      Object.assign(fillingMatch, { seats: 0, participantCount: 4, status: 'full' })
      throw Object.assign(new Error('球局已满'), { code: 'MATCH_FULL' })
    }
    return originalJoin(payload)
  }
  const fullPage = loadDetail(fullApi)
  fullPage.onLoad({ id: fillingMatch.id })
  await fullPage.loadMatch()
  await fullPage.confirmJoin()
  assert.strictEqual(joinPayloads.length, 1, '临时满员不自动提交候补')
  assert.strictEqual(joinPayloads[0].expectedScheduleVersion, 2)
  assert.strictEqual(joinPayloads[0].expectedFeePerPerson, 30)
  assert.strictEqual(joinPayloads[0].allowWaitlist, false)
  assert.strictEqual(fullPage.data.match.joinSubmitText, '确认加入候补')
  assert(fullPage.data.joinError.includes('请核对'))
  await fullPage.confirmJoin()
  assert.strictEqual(joinPayloads.length, 2)
  assert.strictEqual(joinPayloads[1].allowWaitlist, true)
  assert.strictEqual(fullPage.data.resultStatus, 'waitlisted')

  const changedApi = apiFor(rawMatch(), 'joined', true)
  let changedWrites = 0
  changedApi.matches.join = async () => { changedWrites++; throw Object.assign(new Error('球局费用已调整'), { code: 'ARRANGEMENT_CHANGED' }) }
  const changedPage = loadDetail(changedApi)
  changedPage.onLoad({ id: 'changed_match' })
  await changedPage.loadMatch()
  changedApi.matches.get = async () => { throw new Error('刷新断网') }
  await changedPage.confirmJoin()
  assert.strictEqual(changedPage.data.joinNeedsRefresh, true)
  await changedPage.confirmJoin()
  assert.strictEqual(changedWrites, 1, '未核对最新安排时按钮只读刷新，不重复写入')
  assert.strictEqual(changedPage.data.resultSheet, false)

  let completeJoin
  let duplicateCalls = 0
  const doubleApi = apiFor(rawMatch(), 'joined', true)
  doubleApi.matches.join = () => { duplicateCalls++; return new Promise((resolve) => { completeJoin = resolve }) }
  const doublePage = loadDetail(doubleApi)
  doublePage.onLoad({ id: 'double_click_match' })
  await doublePage.loadMatch()
  const first = doublePage.confirmJoin()
  const second = doublePage.confirmJoin()
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(duplicateCalls, 1, '在会话检查期间连点也只有一次提交')
  completeJoin({ match: rawMatch(), membership: { status: 'joined', canChat: true } })
  await Promise.all([first, second])
  let copiedArrangement = ''
  wx.setClipboardData = ({ data, success }) => { copiedArrangement = data; success() }
  doublePage.copyArrangement()
  assert(copiedArrangement.includes('19:00—20:30'), '仅在主动点击后复制完整时间')
  assert(copiedArrangement.includes('黄龙路 1 号'))
  assert.strictEqual(notices[notices.length - 1].title, '安排已复制')
  const copy = require('../utils/match-arrangement').text(present.match(rawMatch()))
  assert(copy.includes('19:00—20:30'))
  assert(copy.includes('黄龙路 1 号'))
  assert(copy.includes('加入球局不等于预订球台'))
  assert(!copy.includes('host-1'))
  assert(require('../utils/match-arrangement').text({}).includes('未填写，请与发起人确认'))

  const legacyCompetitive = present.match(rawMatch({ skills: ['实战对抗'] }))
  assert.strictEqual(legacyCompetitive.practiceIntentLabel, '切磋球技')
  const explicitCompetitive = present.match(rawMatch({ practiceIntent: '切磋球技', skills: ['基本功'] }))
  assert.strictEqual(explicitCompetitive.practiceIntentLabel, '切磋球技')

  const unbooked = present.match(rawMatch({ courtStatus: 'unbooked' }))
  assert.strictEqual(unbooked.courtStatusText, '发起人尚未订台')
  assert(unbooked.courtBookingNotice.includes('还需确认球台'))

  const joined = await verifyOutcome(rawMatch(), 'joined', true)
  assert.strictEqual(joined.data.resultTitle, '加入成功')
  assert.strictEqual(joined.data.resultToneClass, 'success')
  assert(joined.data.resultCopy.includes('平台未核验'))
  assert.strictEqual(joined.data.resultActionText, '沟通时间和球台')
  assert.strictEqual(joined.data.resultCanChat, true)

  const pending = await verifyOutcome(rawMatch({ joinMode: 'confirm' }), 'pending', true)
  assert.strictEqual(pending.data.resultTitle, '申请已发送')
  assert.strictEqual(pending.data.resultToneClass, 'pending')
  assert(pending.data.resultCopy.includes('尚未加入球局'))
  assert(pending.data.resultCopy.includes('不能进入球局对话'))
  assert.strictEqual(pending.data.resultActionText, '查看申请状态')
  assert.strictEqual(pending.data.resultCanChat, false)
  assert.strictEqual(pending.data.canChat, false)

  const waitlisted = await verifyOutcome(rawMatch({ participantCount: 4, seats: 0, status: 'full' }), 'waitlisted', false)
  assert.strictEqual(waitlisted.data.resultTitle, '已加入候补')
  assert(waitlisted.data.resultCopy.includes('还没有获得名额'))
  assert(waitlisted.data.resultCopy.includes('不能进入球局对话'))
  assert.strictEqual(waitlisted.data.match.actionText, '查看候补状态')
  assert.strictEqual(waitlisted.data.match.actionDisabled, false)
  waitlisted.primaryAction()
  assert.strictEqual(navigation[navigation.length - 1], '/pages/orders/orders')

  const joinedWithoutChat = await verifyOutcome(rawMatch(), 'joined', false)
  assert.strictEqual(joinedWithoutChat.data.resultTitle, '加入成功')
  assert.strictEqual(joinedWithoutChat.data.resultCanChat, false)
  assert.strictEqual(joinedWithoutChat.data.resultActionText, '查看预约状态')
  assert.strictEqual(joinedWithoutChat.data.match.actionText, '查看预约状态')
  assert.strictEqual(joinedWithoutChat.data.match.actionDisabled, false)
  joinedWithoutChat.primaryAction()
  assert.strictEqual(navigation[navigation.length - 1], '/pages/orders/orders')

  const refreshFailed = await verifyOutcome(rawMatch(), 'joined', true, { failRefresh: true })
  assert.strictEqual(refreshFailed.data.state, 'ready')
  assert.strictEqual(refreshFailed.data.membership.status, 'joined')
  assert.strictEqual(refreshFailed.data.match.actionText, '打开球局沟通')
  assert.strictEqual(refreshFailed.data.match.actionDisabled, false)
  assert.strictEqual(refreshFailed.data.resultSheet, true)

  const chatEnabledByRefresh = await verifyOutcome(rawMatch(), 'joined', false, { refreshCanChat: true })
  assert.strictEqual(chatEnabledByRefresh.data.resultCanChat, true)
  assert.strictEqual(chatEnabledByRefresh.data.resultActionText, '沟通时间和球台')

  let staleResolve
  let staleStartedResolve
  const staleStarted = new Promise((resolve) => { staleStartedResolve = resolve })
  const staleResponse = new Promise((resolve) => { staleResolve = resolve })
  const concurrentMatch = rawMatch({ id: 'match-concurrent-join' })
  let concurrentMembership = null
  let getCount = 0
  const concurrentPage = loadDetail({
    createRequestId() { requestSequence += 1; return `req_join_${requestSequence}` },
    matches: {
      get: async () => {
        getCount += 1
        if (getCount === 2) {
          staleStartedResolve()
          return staleResponse
        }
        return { match: concurrentMatch, membership: concurrentMembership, confirmedCount: 1 }
      },
      join: async () => {
        concurrentMembership = { status: 'joined', canChat: true }
        return { match: concurrentMatch, membership: concurrentMembership }
      }
    },
    venues: { get: async () => concurrentMatch.venue },
    favorites: { status: async () => ({ markedIds: [] }) },
    files: { resolve: async () => ({ urls: {} }) }
  })
  concurrentPage.onLoad({ id: concurrentMatch.id })
  await concurrentPage.loadMatch()
  const staleLoad = concurrentPage.loadMatch()
  await staleStarted
  await concurrentPage.confirmJoin()
  assert.strictEqual(concurrentPage.data.membership.status, 'joined')
  assert.strictEqual(concurrentPage.data.match.actionText, '打开球局沟通')
  staleResolve({ match: concurrentMatch, membership: null, confirmedCount: 1 })
  await staleLoad
  assert.strictEqual(concurrentPage.data.membership.status, 'joined')
  assert.strictEqual(concurrentPage.data.match.actionText, '打开球局沟通')
  assert.strictEqual(concurrentPage.data.match.actionDisabled, false)

  let refreshResolve
  let refreshStartedResolve
  const refreshStarted = new Promise((resolve) => { refreshStartedResolve = resolve })
  const delayedRefresh = new Promise((resolve) => { refreshResolve = resolve })
  const dismissApi = apiFor(rawMatch(), 'joined', true)
  const originalGet = dismissApi.matches.get
  let dismissGetCount = 0
  dismissApi.matches.get = async () => {
    dismissGetCount += 1
    if (dismissGetCount === 2) {
      refreshStartedResolve()
      return delayedRefresh
    }
    return originalGet()
  }
  const dismissPage = loadDetail(dismissApi)
  dismissPage.onLoad({ id: 'match-dismiss-result' })
  await dismissPage.loadMatch()
  const pendingJoin = dismissPage.confirmJoin()
  await refreshStarted
  dismissPage.closeResult()
  refreshResolve({ match: rawMatch(), membership: { status: 'joined', canChat: true } })
  await pendingJoin
  assert.strictEqual(dismissPage.data.resultSheet, false, '用户关闭成功提示后，后台刷新不能把弹层重新打开')

  const withdrawnApi = apiFor(rawMatch(), 'joined', true)
  withdrawnApi.matches.get = async () => ({ match: rawMatch(), membership: { status: 'cancelled', canChat: false } })
  const withdrawnPage = loadDetail(withdrawnApi)
  withdrawnPage.onLoad({ id: 'match-withdrawn-after-join' })
  withdrawnPage.setData({ resultSheet: true, resultStatus: 'joined', resultCanChat: true })
  await withdrawnPage.loadMatch()
  assert.strictEqual(withdrawnPage.data.resultCanChat, false, '最新详情已无聊天权限时，结果弹层也必须关闭聊天入口')

  const hostPage = loadDetail(apiFor(rawMatch(), 'joined', true))
  hostPage.setData({ membership: { status: 'host' }, match: { isHost: true } })
  const actionSheetsBefore = actionSheetCalls
  hostPage.openMoreActions()
  assert.strictEqual(actionSheetCalls, actionSheetsBefore)
  assert.strictEqual(notices[notices.length - 1].title, '不能举报或屏蔽自己')

  const wxml = fs.readFileSync(path.join(projectRoot, 'pages', 'match-detail', 'match-detail.wxml'), 'utf8')
  assert(wxml.includes('{{match.courtBookingNotice}}'))
  assert(wxml.includes('{{match.joinSheetCopy}}'))
  assert(wxml.includes('{{match.joinSubmitText}}'))
  assert(wxml.includes('{{match.practiceIntentLabel}}'))
  assert(!wxml.includes('wx:for="{{match.skills}}"'))
  assert(wxml.includes('wx:if="{{!match.isHost}}"'))
  console.log('join experience checks passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
