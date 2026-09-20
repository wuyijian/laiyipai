const assert = require('assert')
const Module = require('module')

function createDatabase(seed, options = {}) {
  const stores = new Map(Object.entries(seed).map(([name, records]) => [
    name,
    new Map(records.map((record) => [record._id, Object.assign({}, record)]))
  ]))
  const events = []
  let queryRemoveCalls = 0

  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map())
    return stores.get(name)
  }

  function matches(record, condition) {
    return Object.entries(condition).every(([field, expected]) => {
      if (expected && expected.operator === 'lt') {
        return record[field] instanceof Date && record[field].getTime() < expected.value.getTime()
      }
      return record[field] === expected
    })
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
      async remove() {
        events.push(`remove:${name}:${id}`)
        if ((options.removeFailures || []).includes(`${name}:${id}`)) throw new Error('simulated remove failure')
        const removed = store(name).delete(id) ? 1 : 0
        return { stats: { removed } }
      }
    }
  }

  function collection(name) {
    return {
      doc(id) { return document(name, id) },
      where(condition) {
        let order = null
        let maximum = Infinity
        const query = {
          orderBy(field, direction) {
            order = { field, direction }
            return query
          },
          limit(limit) {
            maximum = limit
            return query
          },
          field() { return query },
          async get() {
            events.push(`get:${name}`)
            if ((options.queryFailures || []).includes(name)) throw new Error('simulated query failure')
            let data = Array.from(store(name).values()).filter((record) => matches(record, condition))
            if (order) {
              data.sort((left, right) => {
                const delta = new Date(left[order.field]).getTime() - new Date(right[order.field]).getTime()
                return order.direction === 'desc' ? -delta : delta
              })
            }
            return { data: data.slice(0, maximum).map((record) => Object.assign({}, record)) }
          },
          // The pinned CloudBase SDK ignores limit/order for query-level remove.
          // Keeping that behavior in the fake prevents a bounded-cleanup regression.
          async remove() {
            queryRemoveCalls += 1
            const ids = Array.from(store(name).values())
              .filter((record) => matches(record, condition))
              .map((record) => record._id)
            ids.forEach((id) => store(name).delete(id))
            return { stats: { removed: ids.length } }
          }
        }
        return query
      }
    }
  }

  return {
    collection,
    command: {
      lt(value) { return { operator: 'lt', value } }
    },
    async runTransaction(callback) { return callback({ collection }) },
    serverDate() { return new Date() },
    records(name) { return Array.from(store(name).values()) },
    events,
    queryRemoveCalls() { return queryRemoveCalls }
  }
}

function loadCleanup(db) {
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    database() { return db },
    async deleteFile() { return {} }
  }
  const modulePath = require.resolve('../index')
  delete require.cache[modulePath]
  const originalLoad = Module._load
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require('../index')
  } finally {
    Module._load = originalLoad
  }
}

async function testExpiredRecordsOnly() {
  const now = new Date('2026-09-12T10:00:00.000Z')
  const db = createDatabase({
    upload_tickets: [
      { _id: 'old_ticket', expiresAt: new Date('2026-09-12T09:00:00.000Z') },
      { _id: 'exact_ticket', expiresAt: new Date(now) },
      { _id: 'future_ticket', expiresAt: new Date('2026-09-12T10:01:00.000Z') },
      { _id: 'legacy_ticket_without_expiry' }
    ],
    rate_limits: [
      { _id: 'old_bucket', expiresAt: new Date('2026-09-12T09:59:59.000Z') },
      { _id: 'future_bucket', expiresAt: new Date('2026-09-12T11:00:00.000Z') }
    ]
  })
  const cleanup = loadCleanup(db)
  const result = await cleanup._private.cleanupExpiredRecords(now)

  assert.deepStrictEqual(result.upload_tickets, { matched: 1, removed: 1, failed: 0, batchFull: false })
  assert.deepStrictEqual(result.rate_limits, { matched: 1, removed: 1, failed: 0, batchFull: false })
  assert.deepStrictEqual(db.records('upload_tickets').map((item) => item._id).sort(), [
    'exact_ticket', 'future_ticket', 'legacy_ticket_without_expiry'
  ])
  assert.deepStrictEqual(db.records('rate_limits').map((item) => item._id), ['future_bucket'])
  assert.strictEqual(db.queryRemoveCalls(), 0, '不得使用会忽略 limit 的查询级 remove')
  await assert.rejects(
    cleanup._private.cleanupExpiredCollection('users', now),
    /EXPIRY_CLEANUP_COLLECTION_NOT_ALLOWED/
  )
}

async function testHardBatchBoundary() {
  const now = new Date('2026-09-12T10:00:00.000Z')
  const expired = Array.from({ length: 105 }, (_, index) => ({
    _id: `bucket_${String(index).padStart(3, '0')}`,
    expiresAt: new Date(now.getTime() - (105 - index) * 1000)
  }))
  const db = createDatabase({ upload_tickets: [], rate_limits: expired })
  const cleanup = loadCleanup(db)
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    const first = await cleanup._private.cleanupExpiredCollection('rate_limits', now)
    assert.deepStrictEqual(first, { matched: 100, removed: 100, failed: 0, batchFull: true })
    assert.strictEqual(db.records('rate_limits').length, 5)
    const second = await cleanup._private.cleanupExpiredCollection('rate_limits', now)
    assert.deepStrictEqual(second, { matched: 5, removed: 5, failed: 0, batchFull: false })
  } finally {
    console.warn = originalWarn
  }
  assert.strictEqual(db.records('rate_limits').length, 0)
  assert.strictEqual(db.queryRemoveCalls(), 0)
}

async function testCleanupFailureDoesNotBlockMainJobScan() {
  const db = createDatabase({
    account_deletion_jobs: [],
    upload_tickets: [{ _id: 'expired_ticket', expiresAt: new Date(0) }],
    rate_limits: [{ _id: 'expired_bucket', expiresAt: new Date(0) }]
  }, { queryFailures: ['upload_tickets'] })
  const cleanup = loadCleanup(db)
  const originalError = console.error
  console.error = () => {}
  let result
  try {
    result = await cleanup.main()
  } finally {
    console.error = originalError
  }

  assert.strictEqual(result.processed, 0)
  assert.deepStrictEqual(result.expiryCleanup.upload_tickets, { matched: 0, removed: 0, failed: 1, batchFull: false })
  assert.deepStrictEqual(result.expiryCleanup.rate_limits, { matched: 1, removed: 1, failed: 0, batchFull: false })
  assert.strictEqual(db.events[0], 'get:account_deletion_jobs', '注销任务扫描必须优先于附加的过期数据清理')
  assert.deepStrictEqual(db.records('upload_tickets').map((item) => item._id), ['expired_ticket'])
  assert.strictEqual(db.records('rate_limits').length, 0)
}

async function run() {
  await testExpiredRecordsOnly()
  await testHardBatchBoundary()
  await testCleanupFailureDoesNotBlockMainJobScan()
  console.log('account-cleanup-expiry-records-tests-ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
