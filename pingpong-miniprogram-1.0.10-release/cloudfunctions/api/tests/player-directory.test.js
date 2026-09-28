const assert = require('assert')
const availability = require('../lib/availability')
const players = require('../lib/players')
const profile = require('../lib/profile')
const discovery = require('../lib/nearby-discovery')
const { stableId } = require('../lib/database')
const { COLLECTIONS } = require('../lib/constants')
const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
const valid = { available: true, date, startTime: '18:00', endTime: '20:00', venueId: 'venue', note: '练反手' }
function user(index, rating = '1628', district = '滨江区', status = 'active') {
  return { _id: 'private_' + index, publicId: 'player_' + String(index).padStart(4, '0'), status,
    profile: { nickname: '球友' + index, district, ratingPlatform: '开球网', ratingValue: rating,
      availability: { ...availability.input(valid), venueName: '公开球馆' } } }
}
function context(users, blocks = [], venue = { _id: 'venue', name: '公开球馆', active: true, verificationStatus: 'verified' }) {
  const ctx = {
    openid: 'viewer', publicRead: true, user: users[0], writes: 0, moderation: 'pass',
    blockPending: 0, blockConcurrency: 0, userFields: [],
    command: { gt: value => ({ gt: value }), in: value => ({ in: value }), set: value => ({ replaceValue: value }) }, serverDate: () => new Date(),
    cloud: { openapi: { security: { msgSecCheck: async () => ({ result: { suggest: ctx.moderation } }) } } },
    db: { runTransaction: work => work(ctx.db), collection(name) {
      let condition = {}, limit = 100
      return {
        where(value) { condition = value; return this }, orderBy() { return this }, limit(value) { limit = value; return this },
        field(value) { if (name === COLLECTIONS.users) ctx.userFields.push(value); else assert.deepStrictEqual(value, { _id: true }); return this },
        async get() {
          if (name === COLLECTIONS.userBlocks) {
            ctx.blockPending++; ctx.blockConcurrency = Math.max(ctx.blockConcurrency, ctx.blockPending)
            await Promise.resolve()
            ctx.blockPending--
            return { data: blocks.filter(row => condition._id.in.includes(row._id) && row.active).slice(0, limit) }
          }
          assert.strictEqual(name, COLLECTIONS.users)
          return { data: users.filter(row => row.status === condition.status &&
            (typeof condition.publicId === 'string' ? row.publicId === condition.publicId : row.publicId > condition.publicId.gt) &&
            (!condition['profile.district'] || row.profile.district === condition['profile.district']))
            .sort((a, b) => a.publicId.localeCompare(b.publicId)).slice(0, limit) }
        },
        doc(id) { return {
          get: async () => ({ data: name === COLLECTIONS.users ? users.find(user => user._id === id) : venue }),
          update: async ({ data }) => {
            ctx.writes++
            const target = users.find(user => user._id === id)
            Object.entries(data).forEach(([key, value]) => {
              if (key.startsWith('profile.')) target.profile[key.slice(8)] = value && value.replaceValue !== undefined ? value.replaceValue : value
              else target[key] = value
            })
          }
        } },
        add: async () => ({})
      }
    } }
  }
  return ctx
}
async function run() {
  for (const value of [null, [], { available: 'true' }, { ...valid, endTime: '17:00' }, { ...valid, date: '2026-02-30' },
    { ...valid, date: '2020-01-01' }, { ...valid, date: '2099-01-01' }, { ...valid, venueId: '' }, { ...valid, note: 'a'.repeat(101) }]) {
    assert.throws(() => availability.input(value), error => error.code === 'INVALID_ARGUMENT')
  }
  const prepared = availability.input({ ...valid, endAt: Number.MAX_SAFE_INTEGER, venueName: 'forged' })
  assert.notStrictEqual(prepared.endAt, Number.MAX_SAFE_INTEGER)
  assert.strictEqual(prepared.venueName, undefined)
  assert.deepStrictEqual(availability.present(prepared, prepared.endAt), { available: false })
  assert.strictEqual(availability.present(prepared, prepared.endAt - 1).available, true)
  assert.deepStrictEqual(availability.present(availability.input({ available: false, note: '休息几天' })), { available: false, note: '休息几天' })

  const users = [user(1), user(2, '2300'), user(3, 'bad'), user(4, '850', '西湖区'), user(5, '2600'), user(6, '1628', '滨江区', 'deleted')]
  users[1].profile.availability.endAt = Date.now() - 1
  const ctx = context(users)
  const all = await players.list(ctx, {})
  assert(ctx.userFields[0]['profile.playingProfile'])
  assert(!ctx.userFields[0]['profile.nearbyDiscovery'], 'ordinary browse does not read stored locations')
  assert(!ctx.userFields[0].profile, 'directory reads only the fields it needs')
  assert.strictEqual(all.items.length, 5)
  assert.deepStrictEqual(all.items.map(item => item.level.text), ['铂金Ⅱ', '星耀Ⅰ', '待定级', '青铜', '王者'])
  const serialized = JSON.stringify(all)
  assert(!serialized.includes('private_') && !serialized.includes('openid'), 'private identity never exposed')
  assert.deepStrictEqual((await players.list(ctx, { grade: 'C' })).items.map(row => row.playerId), ['player_0001'])
  assert.deepStrictEqual((await players.list(ctx, { grade: 'pending' })).items.map(row => row.playerId), ['player_0003'])
  assert.strictEqual((await players.list(ctx, { grade: 'A', availability: 'available' })).items.length, 0)
  assert.strictEqual((await players.list(ctx, { grade: 'A', availability: 'unavailable' })).items.length, 1)
  assert.strictEqual((await players.list(ctx, { district: '西湖区', grade: 'F', availability: 'available' })).items.length, 1)
  assert.strictEqual((await players.list(ctx, { grade: 'S+' })).items.length, 1)
  for (const payload of [{ grade: 'A1' }, { district: '虚构区' }, { availability: 'yes' }, { pageSize: 100 }, { cursor: '$gt' }]) {
    await assert.rejects(players.list(ctx, payload), error => error.code === 'INVALID_ARGUMENT')
  }
  const blocks = Array.from({ length: 110 }, (_, i) => ({ _id: stableId('user-block', 'viewer', 'unrelated' + i), active: true }))
  blocks.push({ _id: stableId('user-block', 'viewer', users[0]._id), active: true })
  blocks.push({ _id: stableId('user-block', users[1]._id, 'viewer'), active: true })
  assert.strictEqual((await players.list(context(users, blocks), {})).items.length, 3, 'both block directions beyond first 100')

  const many = Array.from({ length: 271 }, (_, i) => user(i + 1, i === 260 ? '2600' : '1200'))
  const sparse = context(many)
  const first = await players.list(sparse, { grade: 'S+' })
  assert.strictEqual(sparse.blockConcurrency, 5, 'block chunks run concurrently with a five-query bound')
  assert.strictEqual(first.items.length, 0)
  assert.strictEqual(first.hasMore, true)
  const second = await players.list(sparse, { grade: 'S+', cursor: first.cursor })
  assert.strictEqual(second.items.length, 1)
  assert.strictEqual(second.hasMore, false)
  const seen = []
  let cursor = '', hasMore = true
  while (hasMore) {
    const page = await players.list(ctx, { cursor, pageSize: 2 })
    seen.push(...page.items.map(row => row.playerId)); cursor = page.cursor; hasMore = page.hasMore
  }
  assert.strictEqual(new Set(seen).size, 5)
  assert.strictEqual(seen.length, 5)

  for (const bad of [{ enabled: 'true' }, { enabled: true, latitude: null, longitude: 120 }, { enabled: true, latitude: 91, longitude: 120 }]) {
    assert.throws(() => discovery.input(bad), error => error.code === 'INVALID_ARGUMENT')
  }
  const privateLocation = discovery.input({ enabled: true, latitude: 30.253489, longitude: 120.155388, expiresAt: Number.MAX_SAFE_INTEGER })
  assert.strictEqual(privateLocation.point.latitude, 30.25)
  assert.strictEqual(privateLocation.point.longitude, 120.16)
  assert(privateLocation.expiresAt < Number.MAX_SAFE_INTEGER)
  users[0].profile.nearbyDiscovery = privateLocation
  users[1].profile.nearbyDiscovery = { ...privateLocation, point: { latitude: 40, longitude: 116 } }
  users[2].profile.nearbyDiscovery = { ...privateLocation, expiresAt: Date.now() - 1 }
  users[3].profile.nearbyDiscovery = { ...privateLocation, enabled: false }
  const nearbyPayload = { nearby: { latitude: 30.25, longitude: 120.15, radiusMeters: 5000 }, grade: 'C', availability: 'available' }
  const nearbyRows = await players.list(ctx, nearbyPayload)
  assert.strictEqual(nearbyRows.items.length, 1, 'only fresh opted-in players within radius')
  assert(nearbyRows.items[0].distanceText.startsWith('约 '))
  assert(!/latitude|longitude|expiresAt|nearbyDiscovery|private_/.test(JSON.stringify(nearbyRows)), 'public result contains no stored coordinates')
  assert.strictEqual((await players.list(context(users, blocks), nearbyPayload)).items.length, 0, 'blocks still apply near location')
  assert.strictEqual(discovery.match(discovery.query(nearbyPayload.nearby), { ...privateLocation, expiresAt: Date.now() - 1 }), '')
  await assert.rejects(players.list(ctx, { nearby: { latitude: 30, longitude: 120, radiusMeters: 1000000 } }), error => error.code === 'INVALID_ARGUMENT')
  const { ASSESSMENT_DOMAINS } = require('../lib/player-levels')
  users[4].profile.ratingPlatform = '未填写'
  users[4].profile.ratingValue = ''
  users[4].profile.playingProfile = { abilities: Object.fromEntries(ASSESSMENT_DOMAINS.flatMap(domain => domain.ids.slice(0, 2).map(id => [id, 3]))) }
  const estimated = (await players.list(ctx, { grade: 'C' })).items.find(item => item.playerId === users[4].publicId)
  assert.strictEqual(estimated.level.source, 'ability_self_assessment')
  assert.strictEqual(estimated.ratingValue, '')
  assert.strictEqual(estimated.ratingText, '积分未填写')

  ctx.openid = ctx.user._id
  const shared = await profile.update(ctx, { nearbyDiscovery: { enabled: true, latitude: 30.25, longitude: 120.15 } })
  assert.strictEqual(shared.nearbyDiscovery.enabled, true)
  assert.strictEqual(shared.nearbyDiscovery.point, undefined)
  assert.strictEqual((await players.list(ctx, nearbyPayload)).items.length, 0, 'nearby excludes self')
  await profile.update(ctx, { nearbyDiscovery: { enabled: false } })
  assert.strictEqual(ctx.user.profile.nearbyDiscovery.point, null, 'turning off clears location')
  const saved = await profile.update(ctx, { availability: { ...valid, venueName: '伪造场馆' } })
  assert.strictEqual(saved.availability.venueName, '公开球馆')
  await profile.update(ctx, { nickname: '新昵称' })
  assert.strictEqual(ctx.user.profile.availability.venueId, 'venue', 'old clients retain state')
  assert.strictEqual((await players.get(ctx, { playerId: ctx.user.publicId })).player.availability.available, true)
  ctx.moderation = 'risky'
  const writes = ctx.writes
  await assert.rejects(profile.update(ctx, { availability: { available: false, note: '违规文本' } }), error => error.code === 'CONTENT_REJECTED')
  assert.strictEqual(ctx.writes, writes)
  const inactiveVenue = context([user(1)], [], { active: false })
  inactiveVenue.openid = inactiveVenue.user._id
  await assert.rejects(profile.update(inactiveVenue, { availability: valid }), error => error.code === 'NOT_FOUND')
  ctx.moderation = 'pass'
  await profile.update(ctx, { availability: { available: false, note: '休息中' } })
  assert.strictEqual(ctx.user.profile.availability.venueId, undefined)
  await concurrencyRegression()
  console.log('player directory cloud: filters, sparse cursors, blocks, privacy, expiry, moderation and persistence passed')
}

async function concurrencyRegression() {
  const clone = value => JSON.parse(JSON.stringify(value))
  const initial = user(1)
  initial.profile.nearbyDiscovery = discovery.input({ enabled: true, latitude: 30.25, longitude: 120.15 })
  const persisted = clone(initial)
  let writes = 0, queue = Promise.resolve()
  const command = { set: value => ({ replaceValue: value }) }
  const collection = () => ({
    add: async () => ({}),
    doc: () => ({
      get: async () => ({ data: clone(persisted) }),
      update: async ({ data }) => {
        writes++
        assert(!Object.hasOwn(data, 'profile'), 'do not overwrite an entire stale profile')
        for (const [key, value] of Object.entries(data)) {
          if (key.startsWith('profile.')) persisted.profile[key.slice(8)] = clone(value && Object.hasOwn(value, 'replaceValue') ? value.replaceValue : value)
        }
      }
    })
  })
  const db = { collection, runTransaction(work) {
    const result = queue.then(() => work({ collection }))
    queue = result.catch(() => {})
    return result
  } }
  const makeContext = () => ({ openid: initial._id, user: clone(initial), db, command, serverDate: () => new Date(),
    cloud: { openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } } } })
  await Promise.all([
    profile.update(makeContext(), { nickname: '并发昵称' }),
    profile.update(makeContext(), { skills: ['反手'] })
  ])
  assert.strictEqual(persisted.profile.nickname, '并发昵称')
  assert.deepStrictEqual(persisted.profile.skills, ['反手'])
  const stale = makeContext()
  await profile.update(makeContext(), { nearbyDiscovery: { enabled: false } })
  const saved = await profile.update(stale, { nickname: '旧客户端保存' })
  assert.strictEqual(persisted.profile.nearbyDiscovery.point, null, 'a stale profile cannot restore opted-out coordinates')
  assert.strictEqual(saved.nearbyDiscovery.enabled, false, 'response uses current persisted settings')
  let releaseModeration
  const deleting = makeContext()
  deleting.cloud.openapi.security.msgSecCheck = () => new Promise(resolve => { releaseModeration = resolve })
  const pending = profile.update(deleting, { nickname: '注销竞态' })
  const before = writes
  persisted.status = 'deleted'
  persisted.profile = {}
  releaseModeration({ result: { suggest: 'pass' } })
  await assert.rejects(pending, error => error.code === 'ACCOUNT_DELETED')
  assert.strictEqual(writes, before, 'a deletion during moderation prevents profile recreation')
  persisted.status = 'suspended'
  await assert.rejects(profile.update(makeContext(), { nickname: '停用账号' }), error => error.code === 'ACCOUNT_SUSPENDED')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
