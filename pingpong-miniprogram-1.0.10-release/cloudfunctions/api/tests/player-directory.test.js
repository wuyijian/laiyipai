const assert = require('assert')
const availability = require('../lib/availability')
const players = require('../lib/players')
const profile = require('../lib/profile')
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
    command: { gt: value => ({ gt: value }), in: value => ({ in: value }) }, serverDate: () => new Date(),
    cloud: { openapi: { security: { msgSecCheck: async () => ({ result: { suggest: ctx.moderation } }) } } },
    db: { collection(name) {
      let condition = {}, limit = 100
      return {
        where(value) { condition = value; return this }, orderBy() { return this }, limit(value) { limit = value; return this },
        async get() {
          if (name === COLLECTIONS.userBlocks) return { data: blocks.filter(row => condition._id.in.includes(row._id) && row.active).slice(0, limit) }
          assert.strictEqual(name, COLLECTIONS.users)
          return { data: users.filter(row => row.status === condition.status &&
            (typeof condition.publicId === 'string' ? row.publicId === condition.publicId : row.publicId > condition.publicId.gt) &&
            (!condition['profile.district'] || row.profile.district === condition['profile.district']))
            .sort((a, b) => a.publicId.localeCompare(b.publicId)).slice(0, limit) }
        },
        doc() { return { get: async () => ({ data: venue }), update: async ({ data }) => { ctx.writes++; ctx.user.profile = data.profile } } },
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
  assert.strictEqual(all.items.length, 5)
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

  ctx.openid = ctx.user._id
  const saved = await profile.update(ctx, { availability: { ...valid, venueName: '伪造场馆' } })
  assert.strictEqual(saved.availability.venueName, '公开球馆')
  await profile.update(ctx, { nickname: '新昵称' })
  assert.strictEqual(ctx.user.profile.availability.venueId, 'venue', 'old clients retain state')
  assert.strictEqual((await players.get(ctx, { playerId: ctx.user.publicId })).player.availability.available, true)
  ctx.moderation = 'risky'
  const writes = ctx.writes
  await assert.rejects(profile.update(ctx, { availability: { available: false, note: '违规文本' } }), error => error.code === 'CONTENT_REJECTED')
  assert.strictEqual(ctx.writes, writes)
  await assert.rejects(profile.update(context([user(1)], [], { active: false }), { availability: valid }), error => error.code === 'NOT_FOUND')
  ctx.moderation = 'pass'
  await profile.update(ctx, { availability: { available: false, note: '休息中' } })
  assert.strictEqual(ctx.user.profile.availability.venueId, undefined)
  console.log('player directory cloud: filters, sparse cursors, blocks, privacy, expiry, moderation and persistence passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
