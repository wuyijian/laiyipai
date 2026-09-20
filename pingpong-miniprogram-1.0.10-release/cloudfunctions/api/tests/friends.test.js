const assert = require('assert')
const friends = require('../lib/friends')
const matches = require('../lib/matches')
const terms = require('../lib/terms')

function refFor(store, id) {
  return {
    async get() { return { data: store.has(id) ? Object.assign({ _id: id }, store.get(id)) : null } },
    async set({ data }) { store.set(id, Object.assign({}, data)) }
  }
}

function relationTransaction(store) {
  return {
    collection(name) {
      assert.strictEqual(name, 'player_friends')
      return { doc: id => refFor(store, id) }
    }
  }
}

async function testAutomaticFriendship() {
  const store = new Map()
  let tick = 0
  const context = { serverDate: () => new Date(Date.UTC(2030, 0, 1, 0, tick++)) }
  const match = {
    _id: 'match-one',
    participantIds: ['host-id', 'member-id'],
    participants: [
      { playerId: 'player-host', displayName: '发起人' },
      { playerId: 'player-member', displayName: '已有成员' }
    ]
  }
  const joiner = { playerId: 'player-joiner', displayName: '新成员', skills: ['正手'] }

  await friends.linkJoinedPlayer(context, relationTransaction(store), match, 'joiner-id', joiner)
  assert.strictEqual(store.size, 4, '新成员应与两名已确认成员建立双向关系')
  const joinerToHost = store.get(friends._private.friendshipId('joiner-id', 'host-id'))
  const hostToJoiner = store.get(friends._private.friendshipId('host-id', 'joiner-id'))
  assert.strictEqual(joinerToHost.friendId, 'host-id')
  assert.strictEqual(hostToJoiner.friendId, 'joiner-id')
  assert.strictEqual(joinerToHost.matchCount, 1)

  await friends.linkJoinedPlayer(context, relationTransaction(store), match, 'joiner-id', joiner)
  assert.strictEqual(store.get(friends._private.friendshipId('joiner-id', 'host-id')).matchCount, 1, '同一球局重试不得重复累计')

  await friends.linkJoinedPlayer(context, relationTransaction(store), Object.assign({}, match, { _id: 'match-two' }), 'joiner-id', joiner)
  assert.strictEqual(store.get(friends._private.friendshipId('joiner-id', 'host-id')).matchCount, 2, '再次同场应累计共同球局数')
}

function chain(data) {
  return {
    where(condition) {
      const filtered = data.filter(item => Object.entries(condition).every(([key, expected]) => {
        if (expected && Array.isArray(expected.values)) return expected.values.includes(item[key])
        if (expected && expected.gte) return item[key] >= expected.gte
        return item[key] === expected
      }))
      return chain(filtered)
    },
    orderBy() { return this },
    skip(count) { return chain(data.slice(count)) },
    limit(count) { return chain(data.slice(0, count)) },
    async get() { return { data } }
  }
}

async function testPrivateFriendList() {
  const relationships = [
    { _id: 'r1', userId: 'me', friendId: 'friend-one', matchCount: 2, latestMatchId: 'm2', updatedAt: new Date() },
    { _id: 'r2', userId: 'me', friendId: 'blocked-one', matchCount: 1, latestMatchId: 'm1', updatedAt: new Date() }
  ]
  const users = [
    { _id: 'friend-one', publicId: 'player-one', status: 'active', profile: { nickname: '林小拍', city: '杭州', district: '滨江区', ballAge: '球龄 2—5 年', skills: ['正手攻球'] } },
    { _id: 'blocked-one', publicId: 'player-blocked', status: 'active', profile: { nickname: '已屏蔽' } }
  ]
  const blocks = [{ userId: 'me', targetUserId: 'blocked-one', active: true }]
  const context = {
    openid: 'me',
    user: { _id: 'me' },
    command: { in: values => ({ values }) },
    db: {
      collection(name) {
        if (name === 'player_friends') return chain(relationships)
        if (name === 'users') return chain(users)
        if (name === 'user_blocks') return chain(blocks)
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }
  const result = await friends.list(context, { page: 1, pageSize: 20 })
  assert.strictEqual(result.items.length, 1)
  assert.strictEqual(result.items[0].player.playerId, 'player-one')
  assert.strictEqual(result.items[0].matchCount, 2)
  assert(!JSON.stringify(result).includes('friend-one'), '接口不得返回内部用户 ID')
  assert(!JSON.stringify(result).includes('blocked-one'), '被屏蔽球友不得出现在列表')
}

async function testDirectJoinCreatesFriendship() {
  const relationships = new Map()
  const match = {
    _id: 'match-direct-join',
    title: '滨江晚场',
    city: '杭州',
    district: '滨江区',
    venueId: 'venue-one',
    venueSnapshot: { id: 'venue-one', name: '测试球馆', listingMode: 'name_only' },
    date: '2099-09-01',
    startTime: '19:00',
    endTime: '20:30',
    startAt: new Date('2099-09-01T11:00:00.000Z'),
    endAt: new Date('2099-09-01T12:30:00.000Z'),
    capacity: 4,
    participantCount: 1,
    participantIds: ['host-id'],
    participants: [{ playerId: 'player-host', displayName: '发起人' }],
    hostId: 'host-id',
    hostSnapshot: { playerId: 'player-host', displayName: '发起人' },
    expectedBallAge: '不限球龄',
    practiceIntent: '随便练练',
    joinMode: 'direct',
    courtStatus: 'unbooked',
    feePerPerson: 0,
    status: 'recruiting',
    scheduleVersion: 1,
    version: 1
  }
  let membership = null
  const matchRef = {
    async get() { return { data: match } },
    async update({ data }) { Object.assign(match, data) }
  }
  const memberRef = {
    async get() { return { data: membership } },
    async set({ data }) { membership = Object.assign({ _id: 'member-joiner' }, data) }
  }
  function transactionCollection(name) {
    if (name === 'matches') return { doc: () => matchRef }
    if (name === 'match_members') return { doc: () => memberRef }
    if (name === 'user_blocks') return { doc: () => ({ get: async () => ({ data: null }) }) }
    if (name === 'player_friends') return { doc: id => refFor(relationships, id) }
    throw new Error(`unexpected transaction collection ${name}`)
  }
  function directCollection(name) {
    if (name === 'matches') return { doc: () => matchRef }
    if (name === 'audit_logs') return { add: async () => ({}) }
    throw new Error(`unexpected collection ${name}`)
  }
  const context = {
    openid: 'joiner-id',
    requestId: 'request_friend_join',
    user: { publicId: 'player-joiner', profile: { nickname: '新成员', ballAge: '球龄 2—5 年', skills: ['反手'] } },
    db: { collection: directCollection, runTransaction: work => work({ collection: transactionCollection }) },
    serverDate: () => new Date()
  }
  const result = await matches.join(context, {
    matchId: match._id,
    termsAccepted: true,
    termsVersion: terms.currentVersion()
  })
  assert.strictEqual(result.membership.status, 'joined')
  assert.strictEqual(relationships.size, 2, '直接加入应在同一事务写入双向球友关系')
  assert.deepStrictEqual(match.participantIds, ['host-id', 'joiner-id'])
}

async function testApprovedJoinCreatesFriendship() {
  const relationships = new Map()
  const match = {
    _id: 'match-confirm-join',
    title: '上城切磋局',
    city: '杭州',
    district: '上城区',
    venueId: 'venue-two',
    venueSnapshot: { id: 'venue-two', name: '测试球馆', listingMode: 'name_only' },
    date: '2099-09-02',
    startTime: '19:00',
    endTime: '20:30',
    startAt: new Date('2099-09-02T11:00:00.000Z'),
    endAt: new Date('2099-09-02T12:30:00.000Z'),
    capacity: 4,
    participantCount: 1,
    participantIds: ['host-id'],
    participants: [{ playerId: 'player-host', displayName: '发起人' }],
    hostId: 'host-id',
    hostSnapshot: { playerId: 'player-host', displayName: '发起人' },
    expectedBallAge: '不限球龄',
    practiceIntent: '切磋球技',
    joinMode: 'confirm',
    courtStatus: 'unbooked',
    feePerPerson: 0,
    status: 'recruiting',
    scheduleVersion: 1,
    version: 3
  }
  const membership = {
    _id: 'membership-applicant',
    matchId: match._id,
    userId: 'applicant-id',
    status: 'pending',
    playerSnapshot: { playerId: 'player-applicant', displayName: '申请人' }
  }
  const matchRef = {
    async get() { return { data: match } },
    async update({ data }) { Object.assign(match, data) }
  }
  const memberRef = {
    async get() { return { data: membership } },
    async update({ data }) { Object.assign(membership, data) }
  }
  function transactionCollection(name) {
    if (name === 'matches') return { doc: () => matchRef }
    if (name === 'match_members') return { doc: () => memberRef }
    if (name === 'user_blocks') return { doc: () => ({ get: async () => ({ data: null }) }) }
    if (name === 'player_friends') return { doc: id => refFor(relationships, id) }
    throw new Error(`unexpected transaction collection ${name}`)
  }
  function directCollection(name) {
    if (name === 'matches') return { doc: () => matchRef }
    if (name === 'audit_logs') return { add: async () => ({}) }
    throw new Error(`unexpected collection ${name}`)
  }
  const context = {
    openid: 'host-id',
    requestId: 'request_friend_approve',
    user: { publicId: 'player-host', profile: { nickname: '发起人' } },
    db: { collection: directCollection, runTransaction: work => work({ collection: transactionCollection }) },
    serverDate: () => new Date()
  }
  const result = await matches.respondJoin(context, {
    matchId: match._id,
    membershipId: membership._id,
    decision: 'accept',
    expectedVersion: 3
  })
  assert.strictEqual(result.status, 'joined')
  assert.strictEqual(relationships.size, 2, '发起人批准申请时应在同一事务写入双向球友关系')
  assert.deepStrictEqual(match.participantIds, ['host-id', 'applicant-id'])
}

async function testFriendMatchFilter() {
  const relationships = [{ userId: 'me', friendId: 'friend-one', updatedAt: new Date() }]
  const matchesData = [
    { _id: 'friend-match', city: '杭州', hostId: 'other-host', participantIds: ['other-host', 'friend-one'], status: 'recruiting', startAt: new Date('2099-09-03T11:00:00.000Z') },
    { _id: 'stranger-match', city: '杭州', hostId: 'stranger', participantIds: ['stranger'], status: 'recruiting', startAt: new Date('2099-09-03T12:00:00.000Z') }
  ]
  const context = {
    openid: 'me',
    user: { _id: 'me' },
    publicRead: false,
    command: {
      in: values => ({ values }),
      gte: value => ({ gte: value })
    },
    db: {
      collection(name) {
        if (name === 'player_friends') return chain(relationships)
        if (name === 'user_blocks') return chain([])
        if (name === 'matches') return chain(matchesData)
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }
  const result = await matches.list(context, { city: '杭州', friendsOnly: true, page: 1, pageSize: 20 })
  assert.deepStrictEqual(result.items.map(item => item.id), ['friend-match'])
}

Promise.resolve()
  .then(testAutomaticFriendship)
  .then(testPrivateFriendList)
  .then(testDirectJoinCreatesFriendship)
  .then(testApprovedJoinCreatesFriendship)
  .then(testFriendMatchFilter)
  .then(() => console.log('friends cloud tests passed'))
  .catch(error => { console.error(error); process.exitCode = 1 })
