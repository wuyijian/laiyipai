const assert = require('assert')
const admin = require('../lib/admin')

function database() {
  const stores = {
    users: new Map([
      ['admin_openid', { _id: 'admin_openid', role: 'admin', status: 'active' }],
      ['player_openid', { _id: 'player_openid', role: 'player', status: 'active' }]
    ]),
    venues: new Map([
      ['venue_live', { _id: 'venue_live', name: '萧潮乒乓', city: '杭州', listingMode: 'name_only', verificationStatus: 'verified', active: true }],
      ['venue_hidden', { _id: 'venue_hidden', name: '待完善球馆', city: '杭州', listingMode: 'full', verificationStatus: 'pending', active: false }],
      ['venue_deleted', { _id: 'venue_deleted', name: '已删除球馆', city: '杭州', deleted: true, active: false }]
    ]),
    coaches: new Map([
      ['coach_live', { _id: 'coach_live', name: '陈教练', city: '杭州', venueIds: ['venue_live'], specialty: ['基本功'], verificationStatus: 'verified', active: true }],
      ['coach_hidden', { _id: 'coach_hidden', name: '李教练', city: '杭州', venueIds: [], specialty: [], verificationStatus: 'verified', active: false }]
    ]),
    audit_logs: []
  }

  function collection(name) {
    if (name === 'audit_logs') {
      return { async add({ data }) { stores.audit_logs.push(data); return { _id: `audit_${stores.audit_logs.length}` } } }
    }
    const store = stores[name]
    if (!store) throw new Error(`unexpected collection ${name}`)
    return {
      doc(id) {
        return {
          async get() { return { data: store.get(id) || null } },
          async update({ data }) {
            const current = store.get(id)
            if (!current) throw new Error('DOCUMENT_NOT_EXIST')
            store.set(id, Object.assign({}, current, data))
          }
        }
      },
      where(condition) {
        let rows = Array.from(store.values())
        if (condition.deleted && condition.deleted.$neq === true) rows = rows.filter((row) => row.deleted !== true)
        if (condition.name instanceof RegExp) rows = rows.filter((row) => condition.name.test(row.name || ''))
        let offset = 0
        let limit = rows.length
        const query = {
          skip(value) { offset = value; return query },
          limit(value) { limit = value; return query },
          async get() { return { data: rows.slice(offset, offset + limit) } }
        }
        return query
      }
    }
  }

  const db = {
    collection,
    RegExp({ regexp, options }) { return new RegExp(regexp, options) },
    async runTransaction(task) { return task({ collection }) }
  }
  return { db, stores }
}

function context(databaseState, values = {}) {
  return Object.assign({
    db: databaseState.db,
    command: { neq(value) { return { $neq: value } } },
    openid: 'admin_openid',
    requestId: 'request_admin_catalog_001',
    user: { role: 'admin', status: 'active' },
    serverDate: () => new Date('2026-09-13T04:30:00.000Z')
  }, values)
}

async function rejectsCode(task, code) {
  let caught
  try { await task() } catch (error) { caught = error }
  assert(caught)
  assert.strictEqual(caught.code, code)
}

async function run() {
  const state = database()
  const adminContext = context(state)
  const venues = await admin.listVenues(adminContext, { page: 1, pageSize: 20 })
  assert.deepStrictEqual(venues.items.map((item) => item.id), ['venue_live', 'venue_hidden'])
  assert.strictEqual(venues.items[0].verificationStatus, 'verified')
  assert.strictEqual(venues.items[0].deletedBy, undefined)

  const coaches = await admin.listCoaches(adminContext, { page: 1, pageSize: 20 })
  assert.deepStrictEqual(coaches.items.map((item) => item.id), ['coach_live', 'coach_hidden'])
  assert.strictEqual(coaches.items[1].active, false)

  const removedVenue = await admin.removeVenue(adminContext, { venueId: 'venue_live', reason: '重复球馆记录' })
  assert.strictEqual(removedVenue.deleted, true)
  assert.strictEqual(removedVenue.idempotent, false)
  assert.strictEqual(state.stores.venues.get('venue_live').active, false)
  assert.strictEqual(state.stores.venues.get('venue_live').deleted, true)
  const replay = await admin.removeVenue(adminContext, { venueId: 'venue_live', reason: '重复球馆记录' })
  assert.strictEqual(replay.idempotent, true)
  assert.strictEqual(state.stores.audit_logs.filter((item) => item.action === 'admin.venues.remove').length, 1)

  const removedCoach = await admin.removeCoach(context(state, { requestId: 'request_admin_catalog_002' }), {
    coachId: 'coach_live', reason: '教练停止授课'
  })
  assert.strictEqual(removedCoach.deleted, true)
  assert.strictEqual(state.stores.coaches.get('coach_live').active, false)
  assert.strictEqual(state.stores.coaches.get('coach_live').deleted, true)

  await rejectsCode(() => admin.removeCoach(context(state, {
    openid: 'player_openid', user: { role: 'player', status: 'active' }, requestId: 'request_player_remove'
  }), { coachId: 'coach_hidden' }), 'FORBIDDEN')
  console.log('admin catalog cloud tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
