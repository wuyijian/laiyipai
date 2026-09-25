const assert = require('assert')
const matches = require('../lib/matches')
const { stableId } = require('../lib/database')

function database(seed) {
  const stores = new Map(Object.entries(seed).map(([name, rows]) => [name, new Map(rows.map((row) => [row._id, Object.assign({}, row)]))]))
  const store = (name) => stores.get(name) || (stores.set(name, new Map()), stores.get(name))
  function collection(name) {
    return {
      doc(id) {
        return {
          async get() { return { data: store(name).has(id) ? Object.assign({ _id: id }, store(name).get(id)) : null } },
          async update({ data }) { store(name).set(id, Object.assign({}, store(name).get(id), data)) },
          async set({ data }) { store(name).set(id, Object.assign({}, data)) }
        }
      },
      async add({ data }) { store(name).set(`row_${store(name).size + 1}`, Object.assign({}, data)); return {} }
    }
  }
  return { collection, runTransaction: (work) => work({ collection }), record: (name, id) => store(name).get(id) }
}

const matchId = 'match_update_001'
const hostId = 'openid_host'
const memberId = stableId('match-member', matchId, hostId)
const baseMatch = (patch = {}) => Object.assign({
  _id: matchId, hostId, title: '滨江球馆 · 随便练练', city: '杭州', district: '滨江区', venueId: 'venue_001',
  venueSnapshot: { id: 'venue_001', name: '滨江球馆', listingMode: 'full', address: '滨江路 1 号' },
  date: '2099-01-01', startTime: '19:00', endTime: '20:00',
  startAt: new Date('2099-01-01T11:00:00Z'), endAt: new Date('2099-01-01T12:00:00Z'),
  capacity: 3, participantCount: 2, participantIds: [hostId, 'openid_friend'], participants: [],
  hostSnapshot: { playerId: 'player_host', displayName: '发起人' }, expectedBallAge: '不限球龄',
  practiceIntent: '随便练练', feePerPerson: 0, courtStatus: 'booked', courtBookingNote: '',
  note: '', joinMode: 'direct', status: 'recruiting', scheduleVersion: 3, version: 3
}, patch)

const venue = (id, patch = {}) => Object.assign({
  _id: id, name: id === 'venue_002' ? '萧山球馆' : '滨江球馆', city: '杭州', district: '滨江区',
  active: true, verificationStatus: 'verified', listingMode: 'full', address: '测试地址'
}, patch)

function fixture(matchPatch = {}, venueRows) {
  const db = database({
    matches: [baseMatch(matchPatch)],
    venues: venueRows || [venue('venue_001'), venue('venue_002')],
    match_members: [{ _id: memberId, matchId, userId: hostId, status: 'host', confirmedScheduleVersion: 3 }],
    audit_logs: []
  })
  const context = {
    openid: hostId,
    requestId: 'request_match_update_001',
    db,
    serverDate: () => new Date(),
    cloud: { openapi: { security: { msgSecCheck: async () => ({ errCode: 0, result: { suggest: 'pass' } }) } } }
  }
  return { db, context }
}

function payload(patch = {}) {
  return Object.assign({
    matchId, expectedVersion: 3, venueId: 'venue_001', date: '2099-01-01',
    startTime: '19:00', endTime: '20:00', capacity: 3, expectedBallAge: '不限球龄',
    practiceIntent: '随便练练', joinMode: 'direct', courtStatus: 'booked', feePerPerson: 0, note: ''
  }, patch)
}

async function rejection(work, code) {
  let error = null
  try { await work() } catch (caught) { error = caught }
  assert(error, `expected ${code} rejection`)
  assert.strictEqual(error.code, code)
  return error
}

async function run() {
  {
    const { context } = fixture({}, [venue('venue_001', { district: '' })])
    const edited = payload({ title: '开球网1500分左右，随便打打', district: '上城区' })
    const result = await matches.update(context, edited)
    assert.strictEqual(result.match.title, edited.title)
    assert.strictEqual(result.match.district, '上城区')
    assert.strictEqual(result.match.scheduleVersion, 3)
    assert.strictEqual((await matches.update(context, edited)).idempotent, true)
    await rejection(() => matches.update(context, Object.assign({}, edited, { district: '滨江区' })), 'IDEMPOTENCY_CONFLICT')
    context.requestId = 'district_legacy_edit'
    const legacy = await matches.update(context, payload({ expectedVersion: 4, capacity: 4 }))
    assert.strictEqual(legacy.match.district, '上城区', '旧版未传地区时保留已填地区')
    context.requestId = 'district_new_venue'
    const missingVenue = venue('venue_002', { district: '' })
    await context.db.collection('venues').doc('venue_002').set({ data: missingVenue })
    const moved = await matches.update(context, payload({ expectedVersion: 5, venueId: 'venue_002' }))
    assert.strictEqual(moved.match.district, '', '换到未知地区的新馆，不沿用旧区')
  }
  {
    const { context } = fixture()
    const result = await matches.update(context, payload({ title: '随便打打', district: '上城区' }))
    assert.strictEqual(result.match.district, '滨江区', '已知球馆地区优先，客户端不能伪造')
    await rejection(() => matches.update(context, payload({ district: '不存在区' })), 'INVALID_ARGUMENT')
  }
  {
    const { context, db } = fixture()
    context.user = { _id: hostId, profile: { displayName: '测试发起人' } }
    const venueWithoutDistrict = venue('venue_003', { district: '', listingMode: 'name_only' })
    await db.collection('venues').doc('venue_003').set({ data: venueWithoutDistrict })
    const created = await matches.create(context, Object.assign(payload(), {
      venueId: 'venue_003', district: '萧山区', title: '1500分左右，随便打打',
      termsAccepted: true, termsVersion: require('../lib/terms').currentVersion()
    }))
    assert.strictEqual(created.match.district, '萧山区')
    assert.strictEqual(created.match.title, '1500分左右，随便打打')
    assert.strictEqual(db.record('venues', 'venue_003').district, '', '只补充本场地区，不篡改球馆库')
    context.requestId = 'district_create_known'
    const known = await matches.create(context, Object.assign(payload(), {
      district: '萧山区', title: '随便打打', termsAccepted: true, termsVersion: require('../lib/terms').currentVersion()
    }))
    assert.strictEqual(known.match.district, '滨江区')
  }
  {
    const { db, context } = fixture()
    const result = await matches.update(context, payload({ capacity: 4, practiceIntent: '切磋球技' }))
    assert.strictEqual(result.noop, false)
    assert.strictEqual(result.match.version, 4)
    assert.strictEqual(result.match.scheduleVersion, 3, '普通资料修改不应要求成员重新确认')
    assert.strictEqual(result.match.title, '滨江球馆 · 随便练练', '修改练法不应覆盖用户原有标题')
    assert.strictEqual(db.record('matches', matchId).courtBookingNote, '')
  }

  {
    const { db, context } = fixture()
    const result = await matches.update(context, payload())
    assert.strictEqual(result.noop, true)
    assert.strictEqual(result.match.version, 3, 'no-op 不得递增版本')
    assert.strictEqual(db.record('matches', matchId).lastUpdateRequestId, undefined, 'no-op 不得占用幂等请求号')
  }

  {
    const { db, context } = fixture()
    const changed = payload({ startTime: '20:00', endTime: '21:00' })
    const result = await matches.update(context, changed)
    assert.strictEqual(result.match.courtStatus, 'unbooked', '改时间必须重置订台')
    assert.strictEqual(db.record('matches', matchId).courtBookingNote, '')
    assert.strictEqual(result.match.scheduleVersion, 4)
    assert.strictEqual(result.match.status, 'changed')
    assert.strictEqual(db.record('match_members', memberId).confirmedScheduleVersion, 4, '发起人自动确认新安排')
    const replay = await matches.update(context, changed)
    assert.strictEqual(replay.idempotent, true)
    assert.strictEqual(replay.match.version, 4, '幂等重放不得再次递增版本')
    await rejection(() => matches.update(context, Object.assign({}, changed, { capacity: 4 })), 'IDEMPOTENCY_CONFLICT')
  }

  {
    const { db, context } = fixture()
    const result = await matches.update(context, payload({ venueId: 'venue_002' }))
    assert.strictEqual(result.match.venueId, 'venue_002')
    assert.strictEqual(result.match.courtStatus, 'unbooked', '改球馆必须重置订台')
    assert.strictEqual(result.match.scheduleVersion, 4, '改球馆也需要成员确认新安排')
    assert.strictEqual(db.record('matches', matchId).venueSnapshot.name, '萧山球馆')
  }

  {
    const { db, context } = fixture({}, [venue('venue_001', { active: false, verificationStatus: 'pending' }), venue('venue_002')])
    const result = await matches.update(context, payload({ feePerPerson: 10 }))
    assert.strictEqual(result.match.feePerPerson, 10, '原球馆失效不应阻止修改其他资料')
    assert.strictEqual(db.record('matches', matchId).venueSnapshot.name, '滨江球馆', '失效球馆沿用发布时快照')
    await rejection(() => matches.update(Object.assign({}, context, { requestId: 'request_match_update_002' }),
      payload({ expectedVersion: 4, venueId: 'venue_missing', feePerPerson: 20 })), 'NOT_FOUND')
  }

  {
    const { db, context } = fixture({ title: '周末一起打球加微信', note: '联系我：abc', courtBookingNote: '2 号台' })
    const result = await matches.update(context, payload({
      feePerPerson: 1,
      title: '客户端试图提交自由标题',
      note: '客户端试图提交自由备注'
    }))
    assert.strictEqual(result.match.title, '客户端试图提交自由标题')
    assert.strictEqual(db.record('matches', matchId).note, '客户端试图提交自由备注')
    assert.strictEqual(db.record('matches', matchId).courtBookingNote, '2 号台', '未编辑的球台说明必须保留')
  }

  {
    const { context } = fixture()
    await rejection(() => matches.update(Object.assign({}, context, { openid: 'other_user' }), payload({ title: '越权修改' })), 'FORBIDDEN')
  }

  {
    const { context } = fixture({ startAt: new Date('2020-01-01T11:00:00Z'), endAt: new Date('2020-01-01T12:00:00Z') })
    await rejection(() => matches.update(context, payload({ title: '开球后修改' })), 'MATCH_CLOSED')
  }

  {
    const { context } = fixture()
    const error = await rejection(() => matches.update(context, payload({ endTime: '19:20' })), 'INVALID_ARGUMENT')
    assert(error.message.includes('30 分钟'))
  }

  {
    const { context } = fixture()
    await rejection(() => matches.update(context, payload({ capacity: 1 })), 'INVALID_ARGUMENT')
  }

  console.log('match update cloud tests passed')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
