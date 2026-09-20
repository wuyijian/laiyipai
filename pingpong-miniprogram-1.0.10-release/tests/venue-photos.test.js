const assert = require('assert')
const fs = require('fs')
const path = require('path')
const api = require('../utils/api')
const cloud = require('../utils/cloud')
let definition, modalConfirm = true
const previews = [], notices = []
global.Page = value => { definition = value }
global.getApp = () => ({ ensureSession: async () => ({}) })
global.wx = {
  showModal: options => options.success({ confirm: modalConfirm }),
  showToast: options => notices.push(options.title),
  previewImage: options => previews.push(options),
  chooseMedia() { throw new Error('photo picker must never open') }
}
require('../pages/venue-detail/venue-detail')
function page() {
  const instance = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  instance.data.id = 'venue_a'
  instance.data.venue = { id: 'venue_a', imageUrls: [] }
  instance.setData = function(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = this.data
      while (parts.length > 1) { const key = parts.shift(); target = target[key] || (target[key] = {}) }
      target[parts[0]] = value
    }
  }
  return instance
}
const tests = [], test = (name, run) => tests.push({ name, run })
test('审核版移除视频、场馆照片和用户头像上传', () => {
  assert.equal(api.videos, undefined)
  assert.equal(api.venuePhotos.upload, undefined)
  assert.equal(cloud.uploadVideo, undefined)
  assert.equal(cloud.uploadVenuePhoto, undefined)
  assert.equal(api.profile.uploadAvatar, undefined)
  const p = page()
  for (const key of ['choosePhotos', 'uploadPhotos', 'removeDraft', 'updateDraft']) assert.equal(p[key], undefined)
  for (const key of ['photoDrafts', 'photoUploading', 'photoChoosing']) assert.equal(p.data[key], undefined)
  const template = fs.readFileSync(path.join(__dirname, '../pages/venue-detail/venue-detail.wxml'), 'utf8')
  assert(!/choosePhotos|uploadPhotos|photoDrafts|分享一张实拍|上传照片/.test(template))
  assert(template.includes('暂无场地照片'))
})
test('已有照片仅在展开管理时查询，关闭再开不重复请求', async () => {
  const p = page(); let calls = 0
  api.venuePhotos.list = async () => { calls++; return { items: [{ id: 'old_photo', status: 'reviewing' }] } }
  assert.equal(p.data.photosState, 'idle')
  assert.equal(calls, 0)
  await p.toggleOwnPhotos()
  assert.equal(calls, 1)
  assert.equal(p.data.photoItems[0].statusText, '待审核')
  p.toggleOwnPhotos(); await p.toggleOwnPhotos()
  assert.equal(calls, 1)
})
test('历史照片预览与加载失败重试保留，旧数据不被清空', async () => {
  const p = page(); p.data.photoItems = [{ id: 'existing', url: 'https://test/photo.jpg' }]
  p.data.venue.imageUrls = ['https://test/cover.jpg']
  api.venuePhotos.list = async () => { throw new Error('offline') }
  await p.toggleOwnPhotos()
  assert.equal(p.data.photosState, 'error')
  assert.equal(p.data.photoItems.length, 1)
  p.previewPhoto({ currentTarget: { dataset: { url: 'https://test/photo.jpg' } } })
  assert.deepEqual(previews.at(-1).urls, ['https://test/cover.jpg', 'https://test/photo.jpg'])
  api.venuePhotos.list = async () => ({ items: [] })
  await p.loadPhotos()
  assert.equal(p.data.photosState, 'ready')
})
test('历史照片仍只能确认后移除，失败时保留记录', async () => {
  const p = page(); p.data.photoItems = [{ id: 'photo', url: 'https://test/photo.jpg' }]
  p.data.venue.imageUrls = ['https://test/photo.jpg']
  let calls = 0
  api.venuePhotos.remove = async () => { calls++; throw new Error('offline') }
  modalConfirm = false
  await p.removePhoto({ currentTarget: { dataset: { id: 'photo' } } })
  assert.equal(calls, 0); modalConfirm = true
  await p.removePhoto({ currentTarget: { dataset: { id: 'photo' } } })
  assert.equal(p.data.photoItems.length, 1)
  api.venuePhotos.remove = async () => ({ deleted: true })
  api.venues.get = async () => ({ coverFileIds: [] })
  await p.removePhoto({ currentTarget: { dataset: { id: 'photo' } } })
  assert.equal(p.data.photoItems.length, 0)
  assert.deepEqual(p.data.venue.imageUrls, [])
})
test('审核版云存储不允许客户端直读或直写', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '../database/security-rules/storage-owner-only.json'), 'utf8'))
  const write = new Function('auth', 'resource', 'return (' + rules.write + ')')
  const read = new Function('auth', 'resource', 'return (' + rules.read + ')')
  const auth = { openid: 'owner', uid: 'uid_owner' }
  const resource = { openid: 'owner', path: 'user-avatars/test.jpg', size: 100 }
  assert(!write(auth, resource))
  assert(!write(null, resource))
  assert(!write({ openid: 'other', uid: 'other' }, resource))
  assert(!write(auth, Object.assign({}, resource, { size: 6 * 1024 * 1024 })))
  for (const file of ['user-videos/test.mp4', 'venue-photos/test.jpg', 'public/test.jpg']) {
    assert(!write(auth, Object.assign({}, resource, { path: file })))
  }
  assert(!read(auth, Object.assign({}, resource, { path: 'user-videos/old.mp4' })))
  assert(!read(auth, Object.assign({}, resource, { path: 'venue-photos/old.jpg' })))
  assert(!read({ openid: 'other', uid: 'other' }, resource))
})
;(async () => {
  for (const item of tests) { await item.run(); console.log('PASS ' + item.name) }
  console.log(tests.length + ' retained media client checks passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
