const assert = require('assert')
const rateLimit = require('../lib/rate-limit')

function context() {
  const records = new Map()
  const collection = {
    doc(id) {
      return {
        async get() { return { data: records.get(id) || null } },
        async set({ data }) { records.set(id, Object.assign({}, data)) }
      }
    }
  }
  return {
    records,
    value: {
      openid: 'rate_limit_user',
      serverDate: () => new Date('2026-09-13T08:00:00.000Z'),
      db: {
        async runTransaction(task) {
          return task({ collection() { return collection } })
        }
      }
    }
  }
}

;(async () => {
  assert.strictEqual(rateLimit._private.scopeFor('venues.list'), 'read:venues.list')
  assert.strictEqual(rateLimit._private.scopeFor('matches.list'), 'read:matches.list')
  assert.strictEqual(rateLimit._private.scopeFor('matches.create'), 'publish')

  const state = context()
  await rateLimit.consume(state.value, 'venues.list')
  await rateLimit.consume(state.value, 'matches.list')
  await rateLimit.consume(state.value, 'venues.list')

  assert.strictEqual(state.records.size, 2, 'independent read routes must not contend on one document')
  const records = Array.from(state.records.values())
  assert.deepStrictEqual(records.map(item => item.scope).sort(), ['read:matches.list', 'read:venues.list'])
  assert.strictEqual(records.find(item => item.scope === 'read:venues.list').count, 2)
  assert.strictEqual(records.find(item => item.scope === 'read:matches.list').count, 1)
  console.log('rate limit contention tests passed')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
