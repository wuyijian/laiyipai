const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
let definition

function mock(relative, value) {
  const filename = require.resolve(path.join(root, relative))
  require.cache[filename] = { id: filename, filename, loaded: true, exports: value }
}

mock('utils/api.js', {
  invalidateReads() {},
  venues: { list: async () => ({ items: [] }) },
  matches: { list: async () => ({ items: [], hasMore: false }) },
  favorites: { status: async () => ({ markedIds: [] }), set: async () => ({}) },
  files: { resolve: async () => ({ urls: {} }) }
})
mock('utils/client-state.js', {
  getHomeFilters: () => ({}), saveHomeFilters() {}, consumeHomeDestination: () => '',
  setPublishPrefill: () => true, hasPublishDraft: () => false
})
mock('utils/share.js', { enable() {}, appMessage: value => value, timeline: value => value })
mock('utils/diagnostics.js', { record() {} })
mock('utils/map.js', { openLocation() {} })
mock('utils/tab-bar.js', { sync() {} })

global.Page = value => { definition = value }
global.getApp = () => ({ globalData: { session: null } })
global.wx = {
  onNetworkStatusChange() {}, offNetworkStatusChange() {}, stopPullDownRefresh() {},
  showToast() {}, pageScrollTo() {}, navigateTo() {}, switchTab() {}
}

delete require.cache[require.resolve(path.join(root, 'pages/home/home.js'))]
require(path.join(root, 'pages/home/home.js'))
const home = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
home.setData = function setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback() }
home.onLoad({ mode: 'updates' })
assert.strictEqual(home.data.mode, 'matches', '旧动态深链必须回到找球局')
assert.strictEqual(home.loadUpdatesContent, undefined)
assert.strictEqual(home.openUpdateComposer, undefined)
assert.strictEqual(home.onShareAppMessage().path, '/pages/home/home')

const homeTemplate = fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8')
const friendsTemplate = fs.readFileSync(path.join(root, 'pages/friends/friends.wxml'), 'utf8')
const profileTemplate = fs.readFileSync(path.join(root, 'pages/profile/profile.wxml'), 'utf8')
const settingsTemplate = fs.readFileSync(path.join(root, 'pages/settings/settings.wxml'), 'utf8')
const loginTemplate = fs.readFileSync(path.join(root, 'pages/login/login.wxml'), 'utf8')
const profileScript = fs.readFileSync(path.join(root, 'pages/profile/profile.js'), 'utf8')
const appConfig = require('../app.json')

for (const source of [homeTemplate, friendsTemplate, profileTemplate, settingsTemplate]) {
  assert(!/(发布动态|球友动态|公开回复|心得技巧)/.test(source))
}
assert(!appConfig.pages.includes('pages/update-detail/update-detail'))
assert(!fs.existsSync(path.join(root, 'pages/update-detail/update-detail.js')))
assert(!/chooseAvatar|bindchooseavatar|头像审核|保存新头像/.test(profileTemplate))
assert(!/chooseAvatar|uploadAvatar|avatarStatus|retryAvatar/.test(profileScript))
assert(loginTemplate.includes('系统头像，无需授权微信头像'))
assert(!settingsTemplate.includes('头像昵称可在“我的”编辑'))

console.log('public community removal client tests passed')
