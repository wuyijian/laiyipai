const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const read = name => fs.readFileSync(path.join(root, name), 'utf8')
let definition
global.Page = value => { definition = value }
global.wx = {
  switchTab({ url }) { assert.equal(url, '/pages/home/home') },
  enableShareAppMessage() {}, showShareMenu() {}
}
const api = require('../utils/api')
assert.equal(api.friendUpdates, undefined)
assert.equal(api.updateComments, undefined)
for (const name of ['home/home', 'friends/friends', 'update-detail/update-detail']) {
  const js = read('pages/' + name + '.js')
  const wxml = read('pages/' + name + '.wxml')
  assert(!/api\.(friendUpdates|updateComments)/.test(js), name + ' must not call retired APIs')
  assert(!/bindtap="(openUpdateComposer|submitUpdate|sendReply|useUpdate)"/.test(wxml))
}
const homeWxml = read('pages/home/home.wxml')
assert(!homeWxml.includes('data-mode="updates"'))
assert(!homeWxml.includes('球友动态'))
const homePath = require.resolve('../pages/home/home')
delete require.cache[homePath]
require(homePath)
const home = Object.assign({}, definition, {
  data: JSON.parse(JSON.stringify(definition.data)),
  setData(patch) { Object.assign(this.data, patch) }
})
home.onLoad({ mode: 'updates' })
assert.equal(home.data.mode, 'matches', 'legacy feed shares must fall back to find matches')
home.switchMode({ currentTarget: { dataset: { mode: 'updates' } } })
assert.equal(home.data.mode, 'matches', 'a stale tab cannot reopen the feed')
assert.equal(home.openUpdateComposer, undefined)
const retiredPath = require.resolve('../pages/update-detail/update-detail')
delete require.cache[retiredPath]
require(retiredPath)
assert.equal(definition.onLoad, undefined, 'old detail links must not read feed data')
assert.equal(definition.sendReply, undefined)
definition.goHome()
assert(read('pages/update-detail/update-detail.wxml').includes('该功能已下线'))
const config = JSON.parse(read('app.json'))
assert(config.pages.includes('pages/update-detail/update-detail'), 'keep an inert landing page for old shares')
console.log('retired public feed regression tests passed')
