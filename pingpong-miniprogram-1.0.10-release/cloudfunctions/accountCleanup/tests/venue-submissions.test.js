const assert = require('assert')
const Module = require('module')

function createDatabase(seed) {
  const stores = new Map(Object.entries(seed).map(([name, records]) => [
    name,
    new Map(records.map((record) => [record._id, Object.assign({}, record)]))
  ]))
  let timestamp = 0

  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map())
    return stores.get(name)
  }

  function document(name, id) {
    return {
      async get() {
        const value = store(name).get(id)
        return { data: value ? Object.assign({}, value) : null }
      },
      async update({ data }) {
        const current = store(name).get(id) || { _id: id }
        store(name).set(id, Object.assign({}, current, data))
      },
      async remove() { store(name).delete(id) }
    }
  }

  function collection(name) {
    return {
      doc(id) { return document(name, id) },
      where(condition) {
        const query = {
          orderBy() { return query },
          limit(limit) {
            return {
              async get() {
                const data = Array.from(store(name).values())
                  .filter((record) => Object.entries(condition).every(([key, value]) => record[key] === value))
                  .slice(0, limit)
                  .map((record) => Object.assign({}, record))
                return { data }
              }
            }
          }
        }
        return query
      }
    }
  }

  return {
    collection,
    async runTransaction(callback) { return callback({ collection }) },
    serverDate() { timestamp += 1; return `server-date-${timestamp}` },
    record(name, id) { return store(name).get(id) }
  }
}

async function run() {
  const userId = 'openid_original_user'
  const db = createDatabase({
    venue_submissions: [
      {
        _id: 'submission_reviewing', userId, status: 'reviewing', version: 2,
        submitterSnapshot: { playerId: 'player_original', displayName: '原用户' }
      },
      {
        _id: 'submission_approved', userId, status: 'approved', version: 4, venueId: 'venue_1',
        reviewReason: '', reviewedBy: 'admin_1', submitterSnapshot: { playerId: 'player_original', displayName: '原用户' }
      },
      {
        _id: 'submission_rejected', userId, status: 'rejected', version: 3,
        reviewReason: '名称无法核验', reviewedBy: 'admin_2', submitterSnapshot: { playerId: 'player_original', displayName: '原用户' }
      },
      {
        _id: 'submission_other_owner', userId: 'another_openid', status: 'reviewing', version: 1,
        submitterSnapshot: { playerId: 'another_player', displayName: '其他用户' }
      },
      {
        _id: 'submission_reviewed_by_deleting_admin', userId: 'submitter_openid', status: 'approved', version: 6,
        venueId: 'venue_2', reviewReason: '核验通过', reviewedBy: userId,
        submitterSnapshot: { playerId: 'submitter_player', displayName: '提交者' }
      }
    ],
    account_deletion_jobs: [{ _id: 'cleanup_job', userId, status: 'pending', attempts: 0 }]
  })
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    database() { return db },
    async deleteFile() { throw new Error('没有历史媒体时不应调用 deleteFile') }
  }
  const originalLoad = Module._load
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud
    return originalLoad.call(this, request, parent, isMain)
  }
  let cleanup
  try {
    cleanup = require('../index')
  } finally {
    Module._load = originalLoad
  }

  await cleanup._private.cleanJob({ _id: 'cleanup_job', userId, attempts: 0 })
  const reference = cleanup._private.deletedReference(userId)
  assert.notStrictEqual(reference, userId)

  const reviewing = db.record('venue_submissions', 'submission_reviewing')
  assert.strictEqual(reviewing.userId, reference)
  assert.deepStrictEqual(reviewing.submitterSnapshot, { playerId: reference, displayName: '已注销用户' })
  assert.strictEqual(reviewing.status, 'withdrawn')
  assert.strictEqual(reviewing.reviewReason, '提交者已注销账号')
  assert.strictEqual(reviewing.version, 3)
  assert(reviewing.withdrawnAt)

  const approved = db.record('venue_submissions', 'submission_approved')
  assert.strictEqual(approved.userId, reference)
  assert.strictEqual(approved.status, 'approved')
  assert.strictEqual(approved.venueId, 'venue_1')
  assert.strictEqual(approved.reviewedBy, 'admin_1')
  assert.strictEqual(approved.version, 5)

  const rejected = db.record('venue_submissions', 'submission_rejected')
  assert.strictEqual(rejected.userId, reference)
  assert.strictEqual(rejected.status, 'rejected')
  assert.strictEqual(rejected.reviewReason, '名称无法核验')
  assert.strictEqual(rejected.reviewedBy, 'admin_2')
  assert.strictEqual(rejected.version, 4)

  const otherOwner = db.record('venue_submissions', 'submission_other_owner')
  assert.strictEqual(otherOwner.userId, 'another_openid')
  assert.strictEqual(otherOwner.status, 'reviewing')

  const reviewedByDeletingAdmin = db.record('venue_submissions', 'submission_reviewed_by_deleting_admin')
  assert.strictEqual(reviewedByDeletingAdmin.userId, 'submitter_openid')
  assert.strictEqual(reviewedByDeletingAdmin.reviewedBy, reference)
  assert.strictEqual(reviewedByDeletingAdmin.status, 'approved')
  assert.strictEqual(reviewedByDeletingAdmin.venueId, 'venue_2')
  assert.strictEqual(reviewedByDeletingAdmin.reviewReason, '核验通过')
  assert.strictEqual(reviewedByDeletingAdmin.version, 7)
  assert(reviewedByDeletingAdmin.reviewerAnonymizedAt)

  const job = db.record('account_deletion_jobs', 'cleanup_job')
  assert.strictEqual(job.status, 'completed')
  assert.strictEqual(job.attempts, 1)

  // A stale cleanup batch must not overwrite a submission whose ownership already changed.
  await cleanup._private.cleanVenueSubmission(userId, reference, { _id: 'submission_other_owner' })
  assert.strictEqual(db.record('venue_submissions', 'submission_other_owner').userId, 'another_openid')

  console.log('account-cleanup-venue-submissions-tests-ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
