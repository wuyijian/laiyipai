const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
let definition
let navigation = []
let updateListCalls = 0
const publishedUpdates = []
const storedPrefills = []
const commentListCalls = []
const sentReplies = []

function mock(relative, value) {
  const filename = require.resolve(path.join(root, relative))
  require.cache[filename] = { id: filename, filename, loaded: true, exports: value }
}

const rawUpdate = {
  id: 'update_one', kind: 'availability', district: '滨江区', availabilityText: '本周工作日晚间',
  timeNote: '19 点以后', venueName: '萧潮乒乓球馆', content: '想练接发球', commentCount: 2,
  author: { playerId: 'player_one', displayName: '林小拍', avatarFileId: '' }, createdAt: new Date().toISOString()
}

const api = {
  invalidateReads() {},
  friendUpdates: {
    list: async () => { updateListCalls++; return { items: [rawUpdate], page: 1, hasMore: false } },
    publish: async payload => { publishedUpdates.push(payload); return payload },
    get: async () => rawUpdate,
    remove: async () => ({ removed: true })
  },
  updateComments: {
    list: async payload => {
      commentListCalls.push(payload)
      const page = Number(payload.page || 1)
      return {
        update: rawUpdate,
        items: [{ id: `comment_${page}`, updateId: rawUpdate.id, content: `第 ${page} 页回复`, mine: false,
          author: { playerId: `commenter_${page}`, displayName: `球友 ${page}`, avatarFileId: '' }, createdAt: new Date().toISOString() }],
        page,
        hasMore: page === 1
      }
    },
    send: async payload => {
      sentReplies.push(payload)
      return { id: 'comment_new', updateId: payload.updateId, content: payload.content, mine: true,
        author: { playerId: 'player_self', displayName: '我', avatarFileId: '' }, createdAt: new Date().toISOString() }
    }
  },
  files: { resolve: async () => ({ urls: {} }) }
}

mock('utils/api.js', api)
mock('utils/client-state.js', {
  getHomeFilters: () => ({}), saveHomeFilters() {}, consumeHomeDestination: () => '',
  setPublishPrefill: value => { storedPrefills.push(value); return true }, hasPublishDraft: () => false,
  savePublishDraft() {}
})
mock('utils/share.js', { enable() {}, appMessage: value => value, timeline: value => value })
mock('utils/diagnostics.js', { record() {} })
mock('utils/map.js', { openLocation() {} })
mock('utils/tab-bar.js', { sync() {} })

global.Page = value => { definition = value }
global.getApp = () => ({
  globalData: { session: { profile: { district: '滨江区', ratingPlatform: '开球网', ratingValue: '1680' } } },
  ensureSession: async () => ({ profile: { district: '滨江区', ratingPlatform: '开球网', ratingValue: '1680' } })
})
global.wx = {
  onNetworkStatusChange() {}, offNetworkStatusChange() {}, stopPullDownRefresh() {},
  navigateTo: ({ url }) => navigation.push(url), switchTab: ({ url }) => navigation.push(url),
  navigateBack: () => navigation.push('back'), showToast() {}, pageScrollTo() {}, showModal() {}
}

function instance(value = definition) {
  const page = Object.assign({}, value, { data: JSON.parse(JSON.stringify(value.data)) })
  page.setData = function setData(patch, callback) {
    Object.entries(patch).forEach(([key, next]) => {
      const parts = key.split('.'); let target = this.data
      while (parts.length > 1) { const part = parts.shift(); target = target[part] || (target[part] = {}) }
      target[parts[0]] = next
    })
    if (callback) callback()
  }
  return page
}

async function run() {
  delete require.cache[require.resolve(path.join(root, 'pages/home/home.js'))]
  require(path.join(root, 'pages/home/home.js'))
  const home = instance()
  home.onLoad({ mode: 'updates' })
  assert.strictEqual(home.data.mode, 'updates', '动态分享入口应直接落到动态 Tab')
  await home.loadContent({ showSkeleton: true })
  assert.strictEqual(updateListCalls, 1)
  assert.strictEqual(home.data.updates.length, 1)
  assert.strictEqual(home.data.updates[0].commentText, '2 条回复')
  home.openPrimaryAction()
  assert.strictEqual(navigation.pop(), '/pages/friends/friends?composer=1&from=home')
  assert.strictEqual(home.onShareAppMessage().path, '/pages/home/home?mode=updates')
  assert.deepStrictEqual(home.onShareTimeline().params, { mode: 'updates' })
  home.openUpdateDetail({ currentTarget: { dataset: { id: 'update_one' } } })
  assert.strictEqual(navigation.pop(), '/pages/update-detail/update-detail?id=update_one')
  home.openUpdate({ currentTarget: { dataset: { id: 'update_one' } } })
  assert.strictEqual(navigation.pop(), '/pages/update-detail/update-detail?id=update_one&reply=1')
  home.useUpdate({ currentTarget: { dataset: { id: 'update_one' } } })
  assert.deepStrictEqual(storedPrefills.at(-1), { source: 'player-update', district: '滨江区',
    availabilityText: '本周工作日晚间', timeNote: '19 点以后', venueName: '萧潮乒乓球馆' })
  assert.strictEqual(navigation.pop(), '/pages/publish/publish')

  delete require.cache[require.resolve(path.join(root, 'pages/friends/friends.js'))]
  require(path.join(root, 'pages/friends/friends.js'))
  const friends = instance()
  friends.onLoad()
  await friends.openComposer()
  assert.strictEqual(friends.data.ratingPlatformIndex, 0, '积分默认应为空')
  friends.changeKind({ currentTarget: { dataset: { kind: 'tip' } } })
  friends.setData({ content: '今天发现重心回收比单纯加力更重要', districtIndex: -1, date: '' })
  assert.strictEqual(friends.validateForm(), '', '心得技巧不应要求地区')
  await friends.submitUpdate()
  assert.strictEqual(publishedUpdates[0].kind, 'tip')
  assert(!Object.prototype.hasOwnProperty.call(publishedUpdates[0], 'district'), '心得动态请求不应携带地区')
  assert(!Object.prototype.hasOwnProperty.call(publishedUpdates[0], 'availabilityText'), '心得动态请求不应携带可约时间')
  assert(!Object.prototype.hasOwnProperty.call(publishedUpdates[0], 'date'), '心得动态请求不应携带日期')
  assert(!Object.prototype.hasOwnProperty.call(publishedUpdates[0], 'startTime'), '心得动态请求不应携带开始时间')
  assert(!Object.prototype.hasOwnProperty.call(publishedUpdates[0], 'endTime'), '心得动态请求不应携带结束时间')

  await friends.openComposer()
  friends.setData({ availabilityIndex: 4, date: '', content: '' })
  assert.strictEqual(friends.validateForm(), '', '宽泛可约时间不应要求精确日期')
  await friends.submitUpdate()
  assert.strictEqual(publishedUpdates[1].availabilityText, '时间可商量')
  assert(!Object.prototype.hasOwnProperty.call(publishedUpdates[1], 'date'), '可约动态请求不应携带精确日期')

  const composerTemplate = fs.readFileSync(path.join(root, 'pages/friends/friends.wxml'), 'utf8')
  const composerStyle = fs.readFileSync(path.join(root, 'pages/friends/friends.wxss'), 'utf8')
  assert(!composerTemplate.includes('mode="date"'), '动态发布面板不应出现日期选择器')
  assert(composerTemplate.includes('class="field-hint">无需选择日期</text>'))
  assert(/\.field-control\s*\{[^}]*width:\s*100%[^}]*box-sizing:\s*border-box/.test(composerStyle), '选择控件应统一撑满并按边框盒对齐')
  assert(/\.content-input\s*\{[^}]*width:\s*100%[^}]*box-sizing:\s*border-box/.test(composerStyle), '多行输入框不应因内边距横向溢出')

  delete require.cache[require.resolve(path.join(root, 'pages/update-detail/update-detail.js'))]
  require(path.join(root, 'pages/update-detail/update-detail.js'))
  const detail = instance()
  detail.onLoad({ id: 'update_one', reply: '1' })
  await detail.load()
  assert.strictEqual(detail.data.update.id, 'update_one')
  assert.strictEqual(detail.data.inputFocused, true, '明确点回复时才应自动聚焦输入框')
  assert.strictEqual(detail.data.comments.length, 1)
  assert.strictEqual(detail.data.hasMore, true)
  await detail.loadMoreComments()
  assert.strictEqual(commentListCalls.at(-1).page, 2)
  assert.strictEqual(detail.data.comments.length, 2, '评论翻页应追加而不是覆盖')
  detail.changeReply({ detail: { value: '   ' } })
  assert.strictEqual(detail.data.canSend, false, '纯空白回复不可发送')
  detail.changeReply({ detail: { value: '想问下你一般怎么练？' } })
  assert.strictEqual(detail.data.canSend, true)
  await detail.sendReply()
  assert.strictEqual(detail.data.replyText, '')
  assert.strictEqual(sentReplies.at(-1).content, '想问下你一般怎么练？')
  assert(detail.data.comments.some(item => item.id === 'comment_new'), '新回复应立即出现在列表末尾')
  assert.strictEqual(detail.data.update.commentCount, 3)
  assert.deepStrictEqual(detail.onShareTimeline().params, { id: 'update_one' })

  delete require.cache[require.resolve(path.join(root, 'pages/publish/publish.js'))]
  require(path.join(root, 'pages/publish/publish.js'))
  const publish = instance()
  publish.changed = () => {}
  publish.applyPrefill({ source: 'player-update', district: '滨江区', availabilityText: '本周工作日晚间',
    timeNote: '19 点以后', venueName: '萧潮乒乓球馆' })
  assert(publish.data.prefillNotice.includes('本周工作日晚间 · 19 点以后 · 萧潮乒乓球馆'), '约球发布页应承接动态中的时间和球馆上下文')
  console.log('player updates and replies client tests passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
