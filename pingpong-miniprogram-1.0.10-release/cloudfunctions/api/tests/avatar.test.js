const assert = require('assert')
const avatar = require('../lib/avatar')

function createContext(document, options = {}) {
  let stored = Object.assign({}, document)
  const audit = []
  const ref = {
    async get() { return { data: stored } },
    async update({ data }) { stored = Object.assign({}, stored, data) }
  }
  const mediaQuery = {
    where() { return mediaQuery },
    orderBy() { return mediaQuery },
    limit() { return mediaQuery },
    async get() { return { data: stored ? [stored] : [] } }
  }
  function collection(name) {
    if (name === 'user_media') {
      mediaQuery.doc = () => ref
      return mediaQuery
    }
    if (name === 'audit_logs') return { async add({ data }) { audit.push(data) } }
    throw new Error(`unexpected collection ${name}`)
  }
  const traces = []
  const context = {
    openid: 'avatar_owner',
    requestId: options.requestId || 'retry_request_123',
    command: { neq: (value) => ({ neq: value }) },
    db: {
      collection,
      async runTransaction(callback) { return callback({ collection }) }
    },
    cloud: {
      async getTempFileURL() {
        return { fileList: [{ status: 0, tempFileURL: 'https://temp.example/avatar.jpg' }] }
      },
      openapi: {
        security: {
          async mediaCheckAsync() {
            const traceId = options.traceId || `trace_retry_${traces.length + 1}`
            traces.push(traceId)
            if (typeof options.beforeTransaction === 'function') options.beforeTransaction(stored)
            return { errCode: 0, traceId }
          }
        }
      }
    },
    serverDate: () => new Date('2030-01-01T00:00:00.000Z')
  }
  return { context, stored: () => stored, traces, audit }
}

async function run() {
  const now = new Date('2030-01-01T01:00:00.000Z').getTime()
  const legacy = {
    _id: 'legacy_avatar',
    status: 'reviewing',
    createdAt: new Date(now - avatar._private.MODERATION_TIMEOUT_MS - 1000)
  }
  const legacyView = avatar._private.present(legacy, now)
  assert.strictEqual(legacyView.status, 'timed_out')
  assert.strictEqual(legacyView.canRetry, true)
  assert(legacyView.rejectionReason.includes('重新提交'))

  const pendingView = avatar._private.present(Object.assign({}, legacy, {
    moderationDeadlineAt: new Date(now + 1000)
  }), now)
  assert.strictEqual(pendingView.status, 'reviewing')
  assert.strictEqual(pendingView.canRetry, false)

  const missingTimestamp = avatar._private.present({ _id: 'legacy_no_date', status: 'reviewing' }, now)
  assert.strictEqual(missingTimestamp.status, 'timed_out')
  assert.strictEqual(missingTimestamp.fileId, '')
  assert.strictEqual(missingTimestamp.canRetry, true)
  assert.strictEqual(avatar._private.present({ status: 'reviewing', createdAt: 'bad-date' }, now).status, 'timed_out')
  assert.strictEqual(avatar._private.present({ status: 'reviewing', createdAt: { $date: now } }, now).status, 'reviewing')

  const fixture = createContext({
    _id: 'avatar_retryable',
    userId: 'avatar_owner',
    purpose: 'avatar',
    fileId: 'cloud://env/user-avatars/old.jpg',
    status: 'reviewing',
    moderationTraceId: 'trace_old',
    moderationAttempt: 1,
    moderationRequestedAt: new Date(Date.now() - avatar._private.MODERATION_TIMEOUT_MS - 1000),
    moderationDeadlineAt: new Date(Date.now() - 1000),
    deleted: false,
    createdAt: new Date(Date.now() - avatar._private.MODERATION_TIMEOUT_MS - 1000)
  })
  const retried = await avatar.retry(fixture.context)
  assert.strictEqual(retried.avatar.status, 'reviewing')
  assert.strictEqual(retried.avatar.canRetry, false)
  assert.strictEqual(fixture.stored().moderationTraceId, 'trace_retry_1')
  assert.strictEqual(fixture.stored().moderationAttempt, 2)
  assert.strictEqual(fixture.audit[0].action, 'profile.avatar.retry')

  const duplicate = await avatar.retry(fixture.context)
  assert.strictEqual(duplicate.idempotent, true)
  assert.strictEqual(fixture.traces.length, 1)

  const pending = createContext({
    _id: 'avatar_pending', userId: 'avatar_owner', purpose: 'avatar', fileId: 'cloud://env/pending.jpg',
    status: 'reviewing', moderationTraceId: 'trace_pending', deleted: false,
    moderationDeadlineAt: new Date(Date.now() + 60000), createdAt: new Date()
  })
  await assert.rejects(() => avatar.retry(pending.context), (error) => error.code === 'AVATAR_REVIEW_NOT_RETRYABLE')
  assert.strictEqual(pending.traces.length, 0)

  const race = createContext({
    _id: 'avatar_race', userId: 'avatar_owner', purpose: 'avatar', fileId: 'cloud://env/race.jpg',
    status: 'failed', moderationTraceId: 'trace_failed', deleted: false, createdAt: new Date()
  }, {
    beforeTransaction(document) { document.status = 'passed' }
  })
  const raceResult = await avatar.retry(race.context)
  assert.strictEqual(raceResult.superseded, true)
  assert.strictEqual(race.stored().status, 'passed')
  assert.strictEqual(race.stored().moderationTraceId, 'trace_failed')

  console.log('cloud-api-avatar-tests-ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
