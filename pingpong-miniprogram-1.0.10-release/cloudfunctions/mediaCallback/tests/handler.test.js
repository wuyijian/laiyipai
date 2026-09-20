const assert = require('assert')
const { createHandler, _private } = require('../handler')

function createFixture(values = {}) {
  const stores = {
    user_media: new Map(),
    users: new Map()
  }
  ;(values.media || []).forEach((item) => stores.user_media.set(item._id, Object.assign({}, item)))
  ;(values.users || []).forEach((item) => stores.users.set(item._id, Object.assign({}, item)))
  const deletedFiles = []

  function matches(document, condition) {
    return Object.keys(condition || {}).every((key) => {
      const expected = condition[key]
      if (expected && typeof expected === 'object' && Object.prototype.hasOwnProperty.call(expected, 'neq')) return document[key] !== expected.neq
      return document[key] === expected
    })
  }

  function collection(name) {
    const store = stores[name]
    if (!store) throw new Error(`unexpected collection ${name}`)
    const query = {
      conditions: {},
      order: null,
      maximum: Infinity,
      where(condition) { this.conditions = condition; return this },
      orderBy(field, direction) { this.order = { field, direction }; return this },
      limit(value) { this.maximum = value; return this },
      async get() {
        let data = Array.from(store.values()).filter((item) => matches(item, this.conditions))
        if (this.order) {
          const sign = this.order.direction === 'desc' ? -1 : 1
          data.sort((left, right) => sign * (new Date(left[this.order.field]).getTime() - new Date(right[this.order.field]).getTime()))
        }
        return { data: data.slice(0, this.maximum).map((item) => Object.assign({}, item)) }
      },
      doc(id) {
        return {
          async get() {
            const value = store.get(id)
            if (!value) throw new Error('DOCUMENT_NOT_EXIST')
            return { data: Object.assign({}, value) }
          },
          async update({ data }) {
            const value = store.get(id)
            if (!value) throw new Error('DOCUMENT_NOT_EXIST')
            store.set(id, Object.assign({}, value, data))
          }
        }
      }
    }
    return query
  }

  const db = {
    collection,
    command: { neq: (value) => ({ neq: value }) },
    serverDate: () => new Date('2030-01-01T00:00:00.000Z'),
    async runTransaction(callback) {
      if (typeof values.beforeTransaction === 'function') await values.beforeTransaction(stores)
      return callback({ collection })
    }
  }
  const cloud = {
    async deleteFile({ fileList }) { deletedFiles.push(...fileList) }
  }
  return {
    stores,
    deletedFiles,
    handler: createHandler({ cloud, db, sleep: values.sleep || (async () => {}) })
  }
}

async function run() {
  assert.deepStrictEqual(_private.normalizeEvent({ body: JSON.stringify({ Event: 'wxa_media_check', trace_id: 'trace_body' }) }), {
    Event: 'wxa_media_check', trace_id: 'trace_body'
  })
  assert.strictEqual(_private.callbackResult({ result: { suggest: 'pass', label: 100 } }).status, 'passed')
  assert.strictEqual(_private.callbackResult({ errcode: -1, result: { suggest: 'pass' } }).status, 'failed')

  const invalidFixture = createFixture()
  const invalid = await invalidFixture.handler({ Event: 'not_media', trace_id: 'trace' })
  assert.strictEqual(invalid.ok, false)

  const current = {
    _id: 'media_current', userId: 'owner', purpose: 'avatar', fileId: 'cloud://env/new.jpg',
    status: 'reviewing', deleted: false, moderationTraceId: 'trace_pass', createdAt: new Date('2030-01-02')
  }
  const previous = {
    _id: 'media_previous', userId: 'owner', purpose: 'avatar', fileId: 'cloud://env/old.jpg',
    status: 'passed', deleted: false, moderationTraceId: 'trace_previous', createdAt: new Date('2030-01-01')
  }
  const passFixture = createFixture({
    media: [current, previous],
    users: [{ _id: 'owner', status: 'active', profile: { nickname: '球友', avatarFileId: previous.fileId } }]
  })
  const passed = await passFixture.handler({
    MsgType: 'event', Event: 'wxa_media_check', trace_id: 'trace_pass', errcode: 0,
    result: { suggest: 'pass', label: 100 }
  })
  assert.strictEqual(passed.ok, true)
  assert.strictEqual(passFixture.stores.user_media.get(current._id).status, 'passed')
  assert.strictEqual(passFixture.stores.user_media.get(previous._id).status, 'replaced')
  assert.strictEqual(passFixture.stores.users.get('owner').profile.avatarFileId, current.fileId)
  assert.deepStrictEqual(passFixture.deletedFiles, [previous.fileId])

  const failedMedia = Object.assign({}, current, { _id: 'media_failed', moderationTraceId: 'trace_failed' })
  const failedFixture = createFixture({ media: [failedMedia] })
  const failed = await failedFixture.handler({
    MsgType: 'event', Event: 'wxa_media_check', trace_id: 'trace_failed', errcode: -1008,
    result: { suggest: 'pass', label: 100 }
  })
  assert.strictEqual(failed.status, 'failed')
  assert.strictEqual(failedFixture.stores.user_media.get(failedMedia._id).status, 'failed')
  assert.deepStrictEqual(failedFixture.deletedFiles, [])

  const riskyMedia = Object.assign({}, current, { _id: 'media_risky', fileId: 'cloud://env/risky.jpg', moderationTraceId: 'trace_risky' })
  const riskyFixture = createFixture({ media: [riskyMedia] })
  const risky = await riskyFixture.handler({
    MsgType: 'event', Event: 'wxa_media_check', trace_id: 'trace_risky',
    result: { suggest: 'risky', label: 20002 }
  })
  assert.strictEqual(risky.status, 'rejected')
  assert.strictEqual(riskyFixture.stores.user_media.get(riskyMedia._id).status, 'rejected')
  assert.deepStrictEqual(riskyFixture.deletedFiles, [riskyMedia.fileId])

  const recoveryMedia = Object.assign({}, current, { _id: 'media_recovery', status: 'passed', moderationTraceId: 'trace_recovery' })
  const recoveryFixture = createFixture({
    media: [recoveryMedia],
    users: [{ _id: 'owner', status: 'active', profile: { nickname: '球友', avatarFileId: '' } }]
  })
  const recovered = await recoveryFixture.handler({
    MsgType: 'event', Event: 'wxa_media_check', trace_id: 'trace_recovery',
    result: { suggest: 'pass', label: 100 }
  })
  assert.strictEqual(recovered.duplicate, true)
  assert.strictEqual(recoveryFixture.stores.users.get('owner').profile.avatarFileId, recoveryMedia.fileId)

  let raceFixture
  let sleeps = 0
  raceFixture = createFixture({
    media: [],
    users: [{ _id: 'owner', status: 'active', profile: {} }],
    async sleep() {
      sleeps += 1
      if (sleeps === 1) raceFixture.stores.user_media.set(current._id, Object.assign({}, current))
    }
  })
  const raced = await raceFixture.handler({
    MsgType: 'event', Event: 'wxa_media_check', trace_id: 'trace_pass',
    result: { suggest: 'pass', label: 100 }
  })
  assert.strictEqual(raced.ok, true)
  assert.strictEqual(sleeps, 1)

  const supersededMedia = Object.assign({}, current, {
    _id: 'media_superseded',
    moderationTraceId: 'trace_old_attempt'
  })
  const supersededFixture = createFixture({
    media: [supersededMedia],
    users: [{ _id: 'owner', status: 'active', profile: { nickname: '球友', avatarFileId: '' } }],
    beforeTransaction(stores) {
      stores.user_media.set(supersededMedia._id, Object.assign({}, stores.user_media.get(supersededMedia._id), {
        moderationTraceId: 'trace_new_attempt',
        moderationRequestId: 'retry_request',
        moderationAttempt: 2,
        status: 'reviewing'
      }))
    }
  })
  const superseded = await supersededFixture.handler({
    MsgType: 'event', Event: 'wxa_media_check', trace_id: 'trace_old_attempt',
    result: { suggest: 'pass', label: 100 }
  })
  assert.strictEqual(superseded.ok, true)
  assert.strictEqual(superseded.superseded, true, '晚到的旧回调应识别为已被新审核取代')
  assert.strictEqual(supersededFixture.stores.user_media.get(supersededMedia._id).status, 'reviewing')
  assert.strictEqual(supersededFixture.stores.user_media.get(supersededMedia._id).moderationTraceId, 'trace_new_attempt')
  assert.strictEqual(supersededFixture.stores.users.get('owner').profile.avatarFileId, '')
  assert.deepStrictEqual(supersededFixture.deletedFiles, [])

  console.log('media-callback-handler-tests-ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
