const assert = require('assert')
const fs = require('fs')
const path = require('path')
const stats = require('../lib/profile-stats')
const { isPublicRead } = require('../lib/action-policy')
const tests = []
const test = (name, run) => tests.push({ name, run })
const NOW = new Date('2026-10-01T12:00:00+08:00').getTime()

function match(id, patch = {}) {
  return Object.assign({ _id: id, hostId: 'other', status: 'recruiting', participantCount: 2, scheduleVersion: 1,
    startAt: new Date('2026-10-01T09:00:00+08:00'), endAt: new Date('2026-10-01T10:00:00+08:00') }, patch)
}
function member(id, patch = {}) {
  return Object.assign({ _id: `member_${id}`, userId: 'me', matchId: id, status: 'joined', confirmedScheduleVersion: 1, updatedAt: new Date(NOW) }, patch)
}
function context(members = [], matches = [], failBatch = false) {
  const calls = []
  function query(name, condition = {}, offset = 0, limit = Infinity, fields = null) {
    return {
      where(value) { return query(name, value, offset, limit, fields) },
      orderBy(key, direction) { assert.equal(key, 'updatedAt'); assert.equal(direction, 'desc'); return this },
      skip(value) { return query(name, condition, value, limit, fields) },
      limit(value) { return query(name, condition, offset, value, fields) },
      field(value) { return query(name, condition, offset, limit, value) },
      async get() {
        calls.push({ name, condition, offset, limit, fields })
        assert(fields, '统计读取必须投影必要字段')
        if (name === 'matches') {
          assert(condition._id.values.length <= 20, '关联读取必须分批')
          if (failBatch) throw Error('DB unavailable')
        } else {
          assert.deepStrictEqual(condition, { userId: 'me' }, '只查询可信当前用户，不接受目标用户参数')
          assert(limit <= 100)
        }
        const source = name === 'match_members' ? members : matches
        const data = source.filter(row => Object.entries(condition).every(([key, value]) => value && value.values ? value.values.includes(row[key]) : row[key] === value))
          .slice(offset, offset + limit).map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key === '_id' || fields[key])))
        return { data }
      }
    }
  }
  return { openid: 'me', user: { _id: 'me' }, command: { in: values => ({ values }) },
    db: { collection: name => { assert(['match_members', 'matches'].includes(name)); return query(name) } }, calls }
}

test('仅统计结束的成局，排除取消/候补/待审/退出/未成局/缺失和未确认改期', async () => {
  const members = [], matches = []
  const add = (id, m = {}, p = {}) => { members.push(member(id, p)); matches.push(match(id, m)) }
  add('hosted', { hostId: 'me' }, { status: 'host' })
  add('last-month', { startAt: new Date('2026-09-30T20:00:00+08:00'), endAt: new Date('2026-09-30T22:00:00+08:00') })
  add('cancelled', { status: 'cancelled' })
  for (const status of ['pending', 'waitlisted', 'rejected', 'cancelled']) add(`member-${status}`, {}, { status, wasAccepted: true })
  add('solo', { participantCount: 1 })
  add('upcoming', { startAt: new Date(NOW + 1000), endAt: new Date(NOW + 7200000) })
  add('playing', { endAt: new Date(NOW + 1000) })
  add('unconfirmed-change', { status: 'changed', scheduleVersion: 2 })
  add('confirmed-change', { status: 'changed', scheduleVersion: 2 }, { confirmedScheduleVersion: 2 })
  add('legacy', {}, { confirmedScheduleVersion: undefined })
  add('legacy-changed', { scheduleVersion: 2 }, { confirmedScheduleVersion: undefined })
  add('bad-start', { startAt: null })
  add('bad-end', { endAt: 'invalid' })
  add('bad-range', { startAt: new Date(NOW - 1000), endAt: new Date(NOW - 2000) })
  add('bad-count', { participantCount: undefined })
  add('deleted', { status: 'deleted' })
  add('completed-in-future', { status: 'completed', endAt: new Date(NOW + 1000) })
  add('ends-now', { status: 'full', endAt: new Date(NOW) })
  members.push(member('missing'))
  members.push(member('hosted')) // Duplicate legacy membership must not double count.
  members.push(member('other-person', { userId: 'someone-else' }))
  matches.push(match('other-person'))
  const c = context(members, matches)
  const result = await stats.get(c, { userId: 'someone-else', openid: 'someone-else' })
  assert.deepStrictEqual(result, { historyCount: 5, monthCount: 4, hostedCount: 1, month: '2026-10', asOf: new Date(NOW).toISOString(), basis: 'ended_confirmed_registration_v1' })
  assert(!JSON.stringify(result).includes('hostId'))
  assert(!JSON.stringify(result).includes('other-person'))
})

test('全量个人历史跨过 50/100 条，分批查询，不扫描整个球局库', async () => {
  const matches = Array.from({ length: 205 }, (_, index) => match(`m${index}`))
  const c = context(matches.map(m => member(m._id)), matches)
  const result = await stats.get(c)
  assert.equal(result.historyCount, 205)
  assert.deepStrictEqual(c.calls.filter(c => c.name === 'match_members').map(c => c.offset), [0, 100, 200])
  assert.equal(c.calls.filter(c => c.name === 'matches').length, 11)
})

test('本月按北京时间和开球时间计算，跨月结束不挪到下月', async () => {
  const matches = [
    match('october', { startAt: new Date('2026-09-30T16:00:00Z'), endAt: new Date('2026-09-30T17:00:00Z') }),
    match('september', { startAt: new Date('2026-09-30T15:00:00Z'), endAt: new Date('2026-09-30T17:00:00Z') })
  ]
  const result = await stats.get(context(matches.map(m => member(m._id)), matches))
  assert.equal(result.historyCount, 2)
  assert.equal(result.monthCount, 1)
  assert.equal(stats._private.chinaMonth(Date.parse('2026-12-31T16:00:00Z')), '2027-01')
})

test('空历史返回真实 0；数据库失败不能返回部分计数或假 0', async () => {
  const empty = context()
  const result = await stats.get(empty)
  assert.equal(result.historyCount, 0)
  assert.equal(empty.calls.length, 1)
  await assert.rejects(stats.get(context([member('one')], [match('one')], true)), /DB unavailable/)
})

test('只允许本人登录态读取；游客、伪造目标用户和旧接口不越权', async () => {
  assert.equal(isPublicRead('profile.stats.get'), false)
  await assert.rejects(stats.get(Object.assign(context(), { publicRead: true })), e => e.code === 'UNAUTHENTICATED')
  await assert.rejects(stats.get(Object.assign(context(), { user: null })), e => e.code === 'UNAUTHENTICATED')
  await assert.rejects(stats.get(Object.assign(context(), { openid: '' })), e => e.code === 'UNAUTHENTICATED')
  const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8')
  assert(source.includes("'profile.stats.get': profileStats.get"))
  assert(source.includes("'profile.get': profile.get"), '不能改变旧客户端资料接口')
})

async function main() {
  const originalNow = Date.now
  Date.now = () => NOW
  try {
    for (const t of tests) { await t.run(); console.log(`PASS ${t.name}`) }
  } finally { Date.now = originalNow }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
