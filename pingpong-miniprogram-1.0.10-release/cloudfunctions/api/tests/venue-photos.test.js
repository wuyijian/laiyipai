const assert = require('assert')
const photos = require('../lib/venue-photos')
const uploads = require('../lib/uploads')
const presenters = require('../lib/presenters')
const files = require('../lib/files')
const { stableId } = require('../lib/database')

function fixture() {
  const stores = {}
  const deleted = [], downloads = []
  const bytes = Buffer.from('ffd8ffe000104a464946', 'hex')
  const getStore = name => stores[name] || (stores[name] = new Map())
  function matches(document, condition) {
    return Object.entries(condition).every(([key, value]) => {
      const actual = key.split('.').reduce((obj, part) => obj && obj[part], document)
      if (value && value.in) return Array.isArray(actual) ? actual.some(item => value.in.includes(item)) : value.in.includes(actual)
      if (value && Object.hasOwn(value, 'neq')) return actual !== value.neq
      return actual === value
    })
  }
  function collection(name) {
    const store = getStore(name)
    return {
      doc(id) { return {
        async get() { return { data: store.get(id) || null } },
        async set({ data }) { store.set(id, Object.assign({ _id: id }, data)) },
        async update({ data }) { assert(store.has(id)); store.set(id, Object.assign({}, store.get(id), data)) }
      } },
      async add({ data }) { store.set(`audit-${store.size}`, data) },
      where(condition) {
        let cap = 100
        return {
          orderBy() { return this }, limit(value) { cap = value; return this },
          async get() { return { data: Array.from(store.values()).filter(item => matches(item, condition)).slice(0, cap) } }
        }
      }
    }
  }
  let tail = Promise.resolve()
  const db = { collection, runTransaction(work) {
    const result = tail.then(() => work({ collection }))
    tail = result.catch(() => {})
    return result
  } }
  for (const id of ['venue_a', 'venue_b']) getStore('venues').set(id, { _id: id, name: '球馆', active: true, verificationStatus: 'verified', listingMode: 'name_only' })
  getStore('users').set('owner', { _id: 'owner', status: 'active' })
  const context = {
    db, openid: 'owner', user: { role: 'player' }, requestId: 'request_photo_1',
    command: { in: value => ({ in: value }), neq: value => ({ neq: value }) },
    serverDate: () => new Date(),
    cloud: {
      downloadFile: async ({ fileID }) => { downloads.push(fileID); return { fileContent: bytes } },
      deleteFile: async ({ fileList }) => { deleted.push(...fileList) },
      getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(fileID => ({ fileID, status: 0, tempFileURL: `https://test.invalid/${encodeURIComponent(fileID)}` })) })
    }
  }
  const admin = Object.assign({}, context, { openid: 'admin', user: { role: 'admin' }, requestId: 'request_review_1' })
  // Simulate historical records, never create them through the retired upload API.
  function seed() {
    const id = stableId('venue-photo', 'owner', 'historical_photo')
    const fileId = 'cloud://test.bucket/venue-photos/historical.jpg'
    const data = { _id: id, userId: 'owner', venueId: 'venue_a', purpose: 'venue_photo', fileId,
      status: 'reviewing', moderationMode: 'manual', deleted: false, createdAt: new Date() }
    getStore('user_media').set(id, data)
    getStore('user_media').set(stableId('venue-photo-quota', 'owner', 'venue_a'), {
      userId: 'owner', venueId: 'venue_a', purpose: 'venue_photo_quota', photoIds: [id]
    })
    return { photo: { id }, payload: { fileId, venueId: 'venue_a' } }
  }
  return { context, admin, stores, getStore, seed, deleted, downloads }
}
const tests = []
const test = (name, run) => tests.push({ name, run })
async function rejectsCode(work, code) { await assert.rejects(work, error => error.code === code) }

test('禁发视频和场馆照片凭证，旧登记接口明确拒绝且无任何读写', async () => {
  const context = { db: { collection() { throw new Error('must not access storage') } } }
  for (const purpose of ['video', 'venue_photo']) {
    await rejectsCode(() => uploads.prepare(context, { purpose, extension: 'jpg', venueId: 'venue_a' }), 'FEATURE_DISABLED')
  }
  await rejectsCode(() => photos.register(context, { fileId: 'cloud://old/file.jpg', uploadToken: 'old_ticket' }), 'FEATURE_DISABLED')
  await rejectsCode(() => require('../lib/videos').register(context, { fileId: 'cloud://old/file.mp4', uploadToken: 'old_ticket' }), 'FEATURE_DISABLED')
})

test('头像凭证和一次性归属校验仍正常', async () => {
  const f = fixture()
  const prepared = await uploads.prepare(f.context, { purpose: 'avatar', extension: 'jpg' })
  assert(prepared.cloudPath.startsWith('user-avatars/'))
  const fileId = 'cloud://test.bucket/' + prepared.cloudPath
  await rejectsCode(() => uploads.claim(Object.assign({}, f.context, { openid: 'other' }), prepared.uploadToken, 'avatar', fileId), 'UPLOAD_TICKET_INVALID')
  await uploads.claim(f.context, prepared.uploadToken, 'avatar', fileId)
  assert.equal(f.getStore('upload_tickets').get(prepared.uploadToken).consumed, true)
})

test('历史照片列表仍仅本人可见，未审核不公开文件', async () => {
  const f = fixture(), { payload } = f.seed()
  const result = await photos.list(f.context, { venueId: 'venue_a' })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].fileId, '')
  assert.equal(result.items[0].userId, undefined)
  assert.equal((await photos.list(Object.assign({}, f.context, { openid: 'other' }), { venueId: 'venue_a' })).items.length, 0)
  assert.deepEqual((await files.resolve(f.context, { fileIds: [payload.fileId] })).urls, {})
})

test('历史个人视频不再通过通用文件解析接口公开', async () => {
  const f = fixture()
  const fileId = 'cloud://test.bucket/user-videos/historical.mp4'
  f.getStore('user_videos').set('video_historical', {
    _id: 'video_historical',
    userId: 'owner',
    fileId,
    status: 'passed',
    visibility: 'public',
    deleted: false
  })
  const result = await files.resolve(Object.assign({}, f.context, { openid: 'viewer' }), { fileIds: [fileId] })
  assert.deepEqual(result.urls, {})
  assert.deepEqual(result.unresolved, [fileId])
})

test('仅运营可审核，通过后名称型球馆有照片但不冒充认证', async () => {
  const f = fixture(), { photo, payload } = f.seed()
  await rejectsCode(() => photos.pending(f.context, {}), 'FORBIDDEN')
  await rejectsCode(() => photos.review(f.context, { photoId: photo.id, decision: 'pass' }), 'FORBIDDEN')
  assert((await photos.pending(f.admin, {})).items[0].reviewUrl)
  await photos.review(f.admin, { photoId: photo.id, decision: 'pass' })
  assert.equal((await photos.review(f.admin, { photoId: photo.id, decision: 'pass' })).idempotent, true)
  const venue = presenters.venue(f.getStore('venues').get('venue_a'))
  assert.deepEqual(venue.coverFileIds, [payload.fileId])
  assert.equal(venue.verified, false)
  assert.equal(venue.partnerVerified, false)
  const result = await files.resolve(Object.assign({}, f.context, { openid: 'viewer' }), { fileIds: [payload.fileId] })
  assert(result.urls[payload.fileId])
  await rejectsCode(() => photos.remove(Object.assign({}, f.context, { openid: 'other' }), { photoId: photo.id }), 'NOT_FOUND')
  await photos.remove(f.context, { photoId: photo.id })
  assert.equal((await photos.remove(f.context, { photoId: photo.id })).idempotent, true)
  assert.deepEqual(presenters.venue(f.getStore('venues').get('venue_a')).coverFileIds, [])
  assert.deepEqual((await files.resolve(f.context, { fileIds: [payload.fileId] })).urls, {})
  assert(f.deleted.includes(payload.fileId))
})
test('审核并发互斥，拒绝不公开且有原因', async () => {
  const f = fixture(), { photo } = f.seed()
  const results = await Promise.allSettled([
    photos.review(f.admin, { photoId: photo.id, decision: 'reject', reason: '照片不是球馆实拍' }),
    photos.review(Object.assign({}, f.admin, { requestId: 'request_review_2' }), { photoId: photo.id, decision: 'pass' })
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].reason.code, 'VERSION_CONFLICT')
  const item = (await photos.list(f.context, { venueId: 'venue_a' })).items[0]
  assert.equal(item.rejectionReason, '照片不是球馆实拍')
  assert.equal(item.fileId, '')
  assert.deepEqual(f.getStore('venues').get('venue_a').photoFileIds, undefined)
})
test('球馆下架或上传者注销后不得审核公开', async () => {
  const f = fixture(), { photo } = f.seed()
  f.getStore('venues').get('venue_a').active = false
  await rejectsCode(() => photos.review(f.admin, { photoId: photo.id, decision: 'pass' }), 'NOT_FOUND')
  f.getStore('venues').get('venue_a').active = true
  f.getStore('users').get('owner').status = 'deleted'
  await rejectsCode(() => photos.review(f.admin, { photoId: photo.id, decision: 'pass' }), 'NOT_FOUND')
  assert.equal(f.getStore('user_media').get(photo.id).status, 'reviewing')
  assert.equal(f.getStore('user_media').get(stableId('venue-photo-quota', 'owner', 'venue_a')).photoIds.length, 1)
})
test('运营下架照片也释放原作者配额，普通用户不能伪造管理删除', async () => {
  const f = fixture(), { photo } = f.seed()
  await photos.review(f.admin, { photoId: photo.id, decision: 'pass' })
  await rejectsCode(() => photos.removeAsAdmin(f.context, { photoId: photo.id }), 'FORBIDDEN')
  await rejectsCode(() => photos.remove(Object.assign({}, f.context, { openid: 'other' }), { photoId: photo.id, asAdmin: true }), 'NOT_FOUND')
  await photos.removeAsAdmin(f.admin, { photoId: photo.id })
  assert.deepEqual(f.getStore('venues').get('venue_a').photoFileIds, [])
  assert.deepEqual(f.getStore('user_media').get(stableId('venue-photo-quota', 'owner', 'venue_a')).photoIds, [])
})
test('停用登记不会改变历史记录或删除可能已保存的文件', async () => {
  const f = fixture(), { photo, payload } = f.seed()
  const before = JSON.stringify(f.getStore('user_media').get(photo.id))
  await rejectsCode(() => photos.register(f.context, payload), 'FEATURE_DISABLED')
  assert.equal(JSON.stringify(f.getStore('user_media').get(photo.id)), before)
  assert.equal(f.deleted.length, 0)
  assert.equal(f.downloads.length, 0)
})
;(async () => {
  for (const item of tests) { await item.run(); console.log(`PASS ${item.name}`) }
  console.log(`${tests.length} venue photo cloud checks passed`)
})().catch(error => { console.error(error); process.exitCode = 1 })
