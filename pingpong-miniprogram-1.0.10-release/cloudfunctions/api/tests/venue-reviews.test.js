const assert = require('assert')
const reviews = require('../lib/venue-reviews')

function database() {
  const stores = { venues: new Map(), venue_reviews: new Map(), audit_logs: new Map() }
  let sequence = 0
  function collection(name) {
    const store = stores[name]
    return {
      doc(id) {
        return {
          id,
          async get() { return { data: store.get(id) || null } },
          async set({ data }) { store.set(id, Object.assign({ _id: id }, data)) },
          async update({ data }) { store.set(id, Object.assign({}, store.get(id), data)) },
          async remove() { store.delete(id) }
        }
      },
      async add({ data }) { const id = `audit_${++sequence}`; store.set(id, Object.assign({ _id: id }, data)); return { _id: id } },
      where(condition) {
        let offset = 0; let count = 20; let order = null
        const query = {
          orderBy(field, direction) { order = { field, direction }; return query },
          skip(value) { offset = value; return query },
          limit(value) { count = value; return query },
          async get() {
            let data = Array.from(store.values()).filter(item => Object.entries(condition).every(([key, value]) => item[key] === value))
            if (order) data.sort((a, b) => String(a[order.field] || '').localeCompare(String(b[order.field] || '')) * (order.direction === 'desc' ? -1 : 1))
            return { data: data.slice(offset, offset + count) }
          }
        }
        return query
      }
    }
  }
  return { stores, collection, runTransaction(work) { return work({ collection }) }, serverDate: () => new Date('2026-09-25T12:00:00Z') }
}

function context(db, openid = 'player_1', overrides = {}) {
  return Object.assign({
    db, openid, requestId: `review_${openid}_01`,
    user: { publicId: `public_${openid}`, profile: { nickname: `球友${openid}` } },
    cloud: { openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } } },
    serverDate: db.serverDate
  }, overrides)
}

async function run() {
  const db = database()
  db.stores.venues.set('venue_1', { _id: 'venue_1', active: true, verificationStatus: 'verified', name: '测试球馆' })
  const first = await reviews.upsert(context(db), { venueId: 'venue_1', rating: 4, tags: ['干净整洁', '高手多'], customText: '球台维护得不错' })
  assert.strictEqual(first.summary.count, 1)
  assert.strictEqual(first.summary.average, 4)
  const venueAfterFirst = db.stores.venues.get('venue_1')
  assert.strictEqual(venueAfterFirst.ratingCount, 1)
  assert.strictEqual(venueAfterFirst.ratingTotal, 4)
  assert.strictEqual(venueAfterFirst.ratingTagCounts['高手多'], 1)

  const publicResult = await reviews.list({ db, openid: 'guest_openid', publicRead: true, command: {}, user: undefined }, { venueId: 'venue_1', page: 1, pageSize: 20 })
  assert.strictEqual(publicResult.items.length, 1)
  assert.strictEqual(publicResult.items[0].author.displayName, '球友player_1')
  assert.strictEqual(publicResult.items[0].mine, false)
  assert.strictEqual(publicResult.summary.average, 4)

  const updated = await reviews.upsert(context(db), { venueId: 'venue_1', rating: 5, tags: ['球台好'], customText: '' })
  assert.strictEqual(updated.summary.count, 1)
  assert.strictEqual(updated.summary.average, 5)
  assert.strictEqual(db.stores.venue_reviews.size, 1)
  assert.strictEqual(db.stores.venues.get('venue_1').ratingTagCounts['高手多'], 0)
  assert.strictEqual(db.stores.venues.get('venue_1').ratingTagCounts['球台好'], 1)
  await assert.rejects(() => reviews.upsert(context(db), { venueId: 'venue_1', rating: 5, tags: ['不存在'], customText: '' }), error => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(() => reviews.upsert(context(db), { venueId: 'missing', rating: 5, tags: [], customText: '' }), error => error.code === 'NOT_FOUND')
  console.log('venue-review-cloud-tests-ok')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
