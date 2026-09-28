const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
function page(name, api) {
  let definition
  const sandbox = {
    Page: value => { definition = value }, module: { exports: {} },
    getApp: () => ({ globalData: { session: {} }, ensureSession: async () => ({}) }),
    wx: { showToast() {}, navigateBack() {}, navigateTo() {}, stopPullDownRefresh() {} },
    setInterval: () => 1, clearInterval() {},
    require: name => name.endsWith('/api') ? api : name.endsWith('/error') ? { message: error => error.message } : require('../utils/player-levels')
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages', name, name + '.js'), 'utf8'), sandbox)
  const value = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), active: true })
  value.setData = patch => Object.entries(patch).forEach(([key, data]) => {
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
    let target = value.data
    parts.slice(0, -1).forEach(part => { target = target[part] })
    target[parts[parts.length - 1]] = data
  })
  return { value, exported: sandbox.module.exports }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function run() {
  const pending = [], payloads = []
  let failure = false
  const api = {
    players: { list: payload => { payloads.push(payload); if (failure) return Promise.reject(new Error('offline')); const task = deferred(); pending.push(task); return task.promise } },
    files: { resolve: async () => { throw new Error('media offline') } }
  }
  const directory = page('player-directory', api)
  const p = directory.value
  const first = p.load(false)
  const second = p.changeFilter({ currentTarget: { dataset: { key: 'gradeIndex' } }, detail: { value: '5' } })
  assert.strictEqual(payloads[1].grade, 'C')
  pending[1].resolve({ items: [{ playerId: 'new', avatarFileId: 'file', availability: { available: false } }], cursor: 'new', hasMore: true })
  await second
  pending[0].resolve({ items: [{ playerId: 'old' }], cursor: 'old', hasMore: false })
  await first
  assert.strictEqual(p.data.items[0].playerId, 'new', 'stale filter response discarded')
  failure = true
  await p.loadMore()
  assert.strictEqual(p.data.items.length, 1)
  assert.strictEqual(p.data.cursor, 'new', 'failed append preserves retry cursor')
  failure = false
  const more = p.loadMore()
  pending[2].resolve({ items: [{ playerId: 'new' }, { playerId: 'next' }], cursor: 'next', hasMore: false })
  await more
  assert.strictEqual(p.data.items.length, 2, 'deduplicate append')
  const last = p.load(false)
  p.onHide()
  pending[3].resolve({ items: [{ playerId: 'hidden' }] })
  await last
  assert.strictEqual(p.data.items.length, 0, 'hidden page ignores late data')
  assert.strictEqual(directory.exported.expire([{ availability: { available: true, endAt: 100 } }], 100)[0].availability.available, false)

  let saved, saveFailure = false, legacy = false
  const editApi = {
    profile: {
      get: async () => ({ availability: { available: false, note: '休息中' } }),
      update: async payload => { saved = payload; if (saveFailure) throw new Error('保存失败'); return legacy ? {} : payload }
    },
    venues: { list: async () => ({ items: [{ id: 'venue', name: '球馆' }], hasMore: false }) }
  }
  const editor = page('availability-edit', editApi).value
  editor.onLoad()
  await editor.load()
  assert.strictEqual(editor.data.note, '休息中')
  editor.toggleAvailable({ detail: { value: true } })
  assert.strictEqual(await editor.save(), false, 'venue required')
  await editor.search()
  editor.chooseVenue({ currentTarget: { dataset: { id: 'venue' } } })
  assert.strictEqual(editor.data.venueId, 'venue')
  saveFailure = true
  assert.strictEqual(await editor.save(), false)
  assert.strictEqual(editor.data.note, '休息中', 'failed save retains draft')
  assert.strictEqual(editor.data.saving, false)
  saveFailure = false; legacy = true
  assert.strictEqual(await editor.save(), false, 'old server cannot claim save')
  legacy = false
  assert.strictEqual(await editor.save(), true)
  assert.strictEqual(saved.availability.venueId, 'venue')
  editor.toggleAvailable({ detail: { value: false } })
  assert.strictEqual(await editor.save(), true)
  assert.strictEqual(saved.availability.venueId, undefined, 'turning off drops schedule')
  assert.strictEqual(saved.availability.note, '休息中')
  console.log('player directory UI: stale reads, pagination retry, expiry, venue choice and save recovery passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
