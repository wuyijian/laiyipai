const assert = require('assert')
const fs = require('fs')
const path = require('path')
const admin = require('../lib/admin')
const appointments = require('../lib/appointments')
const auth = require('../lib/auth')
const coaches = require('../lib/coaches')
const favorites = require('../lib/favorites')
const matches = require('../lib/matches')
const messages = require('../lib/messages')
const players = require('../lib/players')
const presenters = require('../lib/presenters')
const rateLimit = require('../lib/rate-limit')
const safety = require('../lib/safety')
const terms = require('../lib/terms')
const venues = require('../lib/venues')
const videos = require('../lib/videos')
const { stableId } = require('../lib/database')

async function rejectsCode(task, code) {
  let thrown = null
  try { await task() } catch (error) { thrown = error }
  assert(thrown, `expected ${code} error`)
  assert.strictEqual(thrown.code, code)
}

function queryReturning(data, capture) {
  const query = {
    where(condition) { if (capture) capture(condition); return query },
    orderBy() { return query },
    skip() { return query },
    limit() { return query },
    async count() { return { total: data.length } },
    async get() { return { data } }
  }
  return query
}

function matchDocument(overrides = {}) {
  const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const endAt = new Date(startAt.getTime() + 60 * 60 * 1000)
  return Object.assign({
    _id: 'match_access_control',
    title: '访问控制测试球局',
    city: '杭州',
    district: '西湖区',
    venueId: 'venue_1',
    venueSnapshot: { id: 'venue_1', name: '测试球馆', address: '测试路 1 号' },
    date: '2099-01-01',
    startTime: '19:00',
    endTime: '20:00',
    startAt,
    endAt,
    capacity: 4,
    participantCount: 1,
    participants: [{ playerId: 'player_host', displayName: '发起人' }],
    participantIds: ['host_openid'],
    hostId: 'host_openid',
    hostSnapshot: { playerId: 'player_host', displayName: '发起人' },
    status: 'recruiting',
    version: 1,
    scheduleVersion: 1
  }, overrides)
}

function matchGetContext(document, options = {}) {
  const membership = options.membership || null
  return {
    openid: options.openid || 'viewer_openid',
    requestId: 'request_match_get',
    command: {
      in: (value) => ({ in: value }),
      neq: (value) => ({ neq: value })
    },
    db: {
      collection(name) {
        if (name === 'matches') {
          return { doc: () => ({ get: async () => ({ data: document }) }) }
        }
        if (name === 'user_blocks') return queryReturning([])
        if (name === 'match_members') {
          const query = queryReturning([])
          query.doc = () => ({ get: async () => ({ data: membership }) })
          return query
        }
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }
}

function messageContext(document, membership) {
  return {
    openid: 'former_member_openid',
    requestId: 'request_message_access',
    command: {
      lt: (value) => ({ lt: value }),
      neq: (value) => ({ neq: value })
    },
    db: {
      collection(name) {
        if (name === 'matches') return { doc: () => ({ get: async () => ({ data: document }) }) }
        if (name === 'match_members') return { doc: () => ({ get: async () => ({ data: membership }) }) }
        if (name === 'match_messages' || name === 'user_blocks') return queryReturning([])
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }
}

function mutationContext(document, membership) {
  let currentMatch = Object.assign({}, document)
  let currentMembership = Object.assign({}, membership)
  const matchRef = {
    async get() { return { data: currentMatch } },
    async update({ data }) { currentMatch = Object.assign({}, currentMatch, data) }
  }
  const memberRef = {
    async get() { return { data: currentMembership } },
    async update({ data }) { currentMembership = Object.assign({}, currentMembership, data) }
  }
  function collection(name) {
    if (name === 'matches') return { doc: () => matchRef }
    if (name === 'match_members') return { doc: () => memberRef }
    if (name === 'audit_logs') return { add: async () => ({}) }
    throw new Error(`unexpected collection ${name}`)
  }
  const db = {
    collection,
    async runTransaction(callback) { return callback({ collection }) }
  }
  return {
    openid: 'host_openid',
    requestId: 'request_closed_match_mutation',
    db,
    serverDate: () => new Date(),
    cloud: {
      openapi: {
        security: {
          msgSecCheck: async () => ({ errCode: 0, result: { suggest: 'pass' } })
        }
      }
    }
  }
}

function messageCancellationRace() {
  const match = matchDocument({ _id: 'match_message_race' })
  const joinedMembership = { matchId: match._id, userId: 'member_openid', status: 'joined' }
  const cancelledMembership = Object.assign({}, joinedMembership, { status: 'cancelled', wasAccepted: true })
  let storedMessage = null
  const messageRef = {
    async get() { return { data: storedMessage } },
    async set({ data }) { storedMessage = Object.assign({ _id: 'message_race' }, data) }
  }
  function directCollection(name) {
    if (name === 'matches') return { doc: () => ({ get: async () => ({ data: match }) }) }
    if (name === 'match_members') return { doc: () => ({ get: async () => ({ data: joinedMembership }) }) }
    if (name === 'match_messages') return { doc: () => messageRef }
    if (name === 'audit_logs') return { add: async () => ({}) }
    throw new Error(`unexpected collection ${name}`)
  }
  function transactionCollection(name) {
    if (name === 'matches') return { doc: () => ({ get: async () => ({ data: match }) }) }
    if (name === 'match_members') return { doc: () => ({ get: async () => ({ data: cancelledMembership }) }) }
    if (name === 'match_messages') return { doc: () => messageRef }
    throw new Error(`unexpected transaction collection ${name}`)
  }
  return {
    context: {
      openid: 'member_openid',
      requestId: 'request_message_race',
      user: { publicId: 'player_member', profile: { nickname: '成员' } },
      db: {
        collection: directCollection,
        async runTransaction(callback) { return callback({ collection: transactionCollection }) }
      },
      serverDate: () => new Date(),
      cloud: {
        openapi: {
          security: {
            msgSecCheck: async () => ({ errCode: 0, result: { suggest: 'pass' } })
          }
        }
      }
    },
    messageWritten: () => Boolean(storedMessage)
  }
}

function venueDeactivationRace(options = {}) {
  const deactivateInTransaction = options.deactivateInTransaction !== false
  const verifiedVenue = {
    _id: 'venue_deactivation_race',
    active: true,
    verificationStatus: 'verified',
    city: '杭州',
    district: '西湖区',
    name: '竞态测试球馆',
    address: '测试路 1 号',
    location: { longitude: 120.1551, latitude: 30.2741 }
  }
  const inactiveVenue = Object.assign({}, verifiedVenue, { active: false })
  let storedMatch = null
  const matchRef = {
    async get() { return { data: storedMatch } },
    async set({ data }) { storedMatch = Object.assign({ _id: 'match_venue_race' }, data) }
  }
  const memberRef = { async set() {} }
  function directCollection(name) {
    if (name === 'venues') return { doc: () => ({ get: async () => ({ data: verifiedVenue }) }) }
    if (name === 'matches') return { doc: () => matchRef }
    if (name === 'match_members') return { doc: () => memberRef }
    if (name === 'audit_logs') return { add: async () => ({}) }
    throw new Error(`unexpected collection ${name}`)
  }
  function transactionCollection(name) {
    if (name === 'venues') return { doc: () => ({ get: async () => ({ data: deactivateInTransaction ? inactiveVenue : verifiedVenue }) }) }
    if (name === 'matches') return { doc: () => matchRef }
    if (name === 'match_members') return { doc: () => memberRef }
    throw new Error(`unexpected transaction collection ${name}`)
  }
  return {
    context: {
      openid: 'host_openid',
      requestId: 'request_venue_race',
      user: { publicId: 'player_host', profile: { nickname: '发起人' } },
      db: {
        collection: directCollection,
        async runTransaction(callback) { return callback({ collection: transactionCollection }) }
      },
      serverDate: () => new Date(),
      cloud: {
        openapi: {
          security: {
            msgSecCheck: async () => ({ errCode: 0, result: { suggest: 'pass' } })
          }
        }
      }
    },
    matchWritten: () => Boolean(storedMatch),
    venueId: verifiedVenue._id
  }
}

function joinBlockRace(matchOverrides = {}) {
  const match = matchDocument(Object.assign({ _id: 'match_join_block_race', joinMode: 'direct' }, matchOverrides))
  const joinerId = 'joiner_openid'
  const requestedBlockIds = []
  let membershipWritten = false
  let matchWritten = false
  const memberRef = {
    async get() { return { data: null } },
    async set() { membershipWritten = true }
  }
  const matchRef = {
    async get() { return { data: match } },
    async update() { matchWritten = true }
  }
  const activeBlockId = stableId('user-block', match.hostId, joinerId)
  function directCollection(name) {
    if (name === 'matches') return { doc: () => matchRef }
    if (name === 'user_blocks') return queryReturning([])
    if (name === 'audit_logs') return { add: async () => ({}) }
    throw new Error(`unexpected collection ${name}`)
  }
  function transactionCollection(name) {
    if (name === 'matches') return { doc: () => matchRef }
    if (name === 'match_members') return { doc: () => memberRef }
    if (name === 'user_blocks') return {
      doc(id) {
        requestedBlockIds.push(id)
        return { get: async () => ({ data: id === activeBlockId ? { active: true } : null }) }
      }
    }
    throw new Error(`unexpected transaction collection ${name}`)
  }
  return {
    context: {
      openid: joinerId,
      requestId: 'request_join_block_race',
      user: { publicId: 'player_joiner', profile: { nickname: '申请人' } },
      db: {
        collection: directCollection,
        async runTransaction(callback) { return callback({ collection: transactionCollection }) }
      },
      serverDate: () => new Date()
    },
    matchId: match._id,
    expectedBlockIds: [
      stableId('user-block', joinerId, match.hostId),
      stableId('user-block', match.hostId, joinerId)
    ],
    requestedBlockIds,
    membershipWritten: () => membershipWritten,
    matchWritten: () => matchWritten
  }
}

function respondJoinBlockRace() {
  const match = matchDocument({ _id: 'match_respond_block_race', joinMode: 'confirm' })
  const applicantId = 'applicant_openid'
  const membershipId = 'membership_pending_race'
  const membership = {
    _id: membershipId,
    matchId: match._id,
    userId: applicantId,
    status: 'pending',
    playerSnapshot: { playerId: 'player_applicant', displayName: '申请人' }
  }
  const requestedBlockIds = []
  let membershipWritten = false
  let matchWritten = false
  const memberRef = {
    async get() { return { data: membership } },
    async update() { membershipWritten = true }
  }
  const matchRef = {
    async get() { return { data: match } },
    async update() { matchWritten = true }
  }
  const activeBlockId = stableId('user-block', applicantId, match.hostId)
  function directCollection(name) {
    if (name === 'match_members') return { doc: () => memberRef }
    if (name === 'user_blocks') return queryReturning([])
    if (name === 'matches') return { doc: () => matchRef }
    if (name === 'audit_logs') return { add: async () => ({}) }
    throw new Error(`unexpected collection ${name}`)
  }
  function transactionCollection(name) {
    if (name === 'matches') return { doc: () => matchRef }
    if (name === 'match_members') return { doc: () => memberRef }
    if (name === 'user_blocks') return {
      doc(id) {
        requestedBlockIds.push(id)
        return { get: async () => ({ data: id === activeBlockId ? { active: true } : null }) }
      }
    }
    throw new Error(`unexpected transaction collection ${name}`)
  }
  return {
    context: {
      openid: match.hostId,
      requestId: 'request_respond_block_race',
      db: {
        collection: directCollection,
        async runTransaction(callback) { return callback({ collection: transactionCollection }) }
      },
      serverDate: () => new Date()
    },
    matchId: match._id,
    membershipId,
    expectedBlockIds: [
      stableId('user-block', match.hostId, applicantId),
      stableId('user-block', applicantId, match.hostId)
    ],
    requestedBlockIds,
    membershipWritten: () => membershipWritten,
    matchWritten: () => matchWritten
  }
}

async function run() {
  assert.strictEqual(terms.requireAcceptance({ termsAccepted: true, termsVersion: terms.currentVersion() }), terms.currentVersion())
  await rejectsCode(() => Promise.resolve(terms.requireAcceptance({ termsAccepted: false, termsVersion: terms.currentVersion() })), 'TERMS_REQUIRED')


  const adminContext = { user: { role: 'admin' }, openid: 'admin_openid' }
  await rejectsCode(() => admin.upsertVenue(adminContext, {
    venueId: 'venue_1',
    verificationStatus: 'pending',
    active: true
  }), 'INVALID_ARGUMENT')
  await rejectsCode(() => admin.upsertVenue(adminContext, {
    venueId: 'venue_1',
    verificationStatus: 'verified',
    verificationDate: '2026-09-04',
    active: true
  }), 'INVALID_ARGUMENT')
  await rejectsCode(() => admin.upsertVenue(adminContext, {
    venueId: 'venue_1',
    verificationStatus: 'pending',
    activityTags: ['聚餐']
  }), 'INVALID_ARGUMENT')
  await rejectsCode(() => admin.upsertVenue(adminContext, {
    venueId: 'venue_1',
    name: '名称型场馆',
    listingMode: 'name_only',
    partnerVerified: true
  }), 'INVALID_ARGUMENT')

  let storedNameOnlyVenue = null
  const nameOnlyVenueRef = {
    async get() { return { data: storedNameOnlyVenue } },
    async set({ data }) { storedNameOnlyVenue = Object.assign({ _id: 'venue_name_only' }, data) },
    async update({ data }) { storedNameOnlyVenue = Object.assign({}, storedNameOnlyVenue, data) }
  }
  const nameOnlyAdminContext = {
    user: { role: 'admin' },
    openid: 'admin_openid',
    requestId: 'request_name_only_venue',
    serverDate: () => new Date('2026-09-06T00:00:00.000Z'),
    db: {
      collection(name) {
        if (name === 'venues') return { doc: () => nameOnlyVenueRef }
        if (name === 'audit_logs') return { add: async () => ({}) }
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }
  const nameOnlyVenue = await admin.upsertVenue(nameOnlyAdminContext, {
    venueId: 'venue_name_only',
    name: '萧潮乒乓球馆',
    listingMode: 'name_only',
    activityTags: ['教学', '比赛', '训练', '切磋'],
    active: true
  })
  assert.strictEqual(storedNameOnlyVenue.address, '')
  assert.strictEqual(storedNameOnlyVenue.location, null)
  assert.strictEqual(storedNameOnlyVenue.verificationStatus, 'verified')
  assert.strictEqual(storedNameOnlyVenue.partnerVerified, false)
  assert.strictEqual(nameOnlyVenue.verified, false)
  assert.strictEqual(nameOnlyVenue.partnerVerified, false)

  const defaultNameOnlyVenues = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'database', 'default-venues.name-only.json'), 'utf8'))
  assert.deepStrictEqual(defaultNameOnlyVenues.map((item) => item.name), ['萧潮乒乓球馆', '桂语朝阳乒乓球室'])
  defaultNameOnlyVenues.forEach((item) => {
    assert.strictEqual(item.listingMode, 'name_only')
    assert.strictEqual(item.active, true)
    assert.strictEqual(item.partnerVerified, false)
    ;['address', 'district', 'longitude', 'latitude', 'phone', 'sourceUrls'].forEach((field) => {
      assert(!Object.prototype.hasOwnProperty.call(item, field), `名称型默认球馆不应包含 ${field}`)
    })
  })
  const pendingVenues = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'database', 'hangzhou-venue-candidates.pending.json'), 'utf8'))
  const pendingNameOnlyVenues = pendingVenues.filter((item) => item.listingMode === 'name_only')
  assert.deepStrictEqual(pendingNameOnlyVenues.map((item) => item.name), ['桂语朝阳乒乓球室'])
  pendingNameOnlyVenues.forEach((item) => {
    assert.strictEqual(item.active, false)
    assert.strictEqual(item.verificationStatus, 'pending')
    ;['address', 'district', 'longitude', 'latitude', 'phone', 'sourceUrls'].forEach((field) => {
      assert(!Object.prototype.hasOwnProperty.call(item, field), `名称型候选球馆不应包含 ${field}`)
    })
  })
  const xiaochaoCandidate = pendingVenues.find((item) => item.venueId === 'hz_xiaochao_table_tennis')
  assert.strictEqual(xiaochaoCandidate.listingMode, 'full')
  assert.strictEqual(xiaochaoCandidate.active, false)
  assert.strictEqual(xiaochaoCandidate.verificationStatus, 'pending')
  assert.deepStrictEqual([xiaochaoCandidate.longitude, xiaochaoCandidate.latitude], [120.285361, 30.153527])
  await rejectsCode(() => admin.upsertCoach(adminContext, {
    coachId: 'coach_1',
    venueIds: ['venue_1'],
    verificationStatus: 'verified',
    verificationDate: '2026-09-04',
    active: true
  }), 'INVALID_ARGUMENT')

  let venueCondition = null
  await venues.list({
    db: { collection: () => queryReturning([], (value) => { venueCondition = value }) }
  }, {})
  assert.strictEqual(venueCondition.active, true)
  assert.strictEqual(venueCondition.verificationStatus, 'verified')

  let coachCondition = null
  await coaches.list({
    db: { collection: () => queryReturning([], (value) => { coachCondition = value }) },
    command: { in: (value) => value }
  }, {})
  assert.strictEqual(coachCondition.active, true)
  assert.strictEqual(coachCondition.verificationStatus, 'verified')

  let matchListCondition = null
  await matches.list({
    openid: 'viewer_openid',
    command: {
      in: (value) => ({ in: value }),
      gte: (value) => ({ gte: value })
    },
    db: {
      collection(name) {
        if (name === 'matches') return queryReturning([], (value) => { matchListCondition = value })
        if (name === 'user_blocks') return queryReturning([])
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }, { city: '杭州', venueId: 'venue_1', page: 1, pageSize: 20 })
  assert.strictEqual(matchListCondition.venueId, 'venue_1')
  assert(!Object.prototype.hasOwnProperty.call(matchListCondition, 'city'), 'venueId 查询不应叠加城市条件')

  let favoriteVenueCondition = null
  const favoriteResult = await favorites.list({
    openid: 'viewer_openid',
    command: { in: (value) => ({ in: value }) },
    db: {
      collection(name) {
        if (name === 'venue_favorites') return queryReturning([
          { venueId: 'venue_verified' },
          { venueId: 'venue_inactive' },
          { venueId: 'venue_pending' }
        ])
        if (name === 'venues') return queryReturning([
          { _id: 'venue_verified', name: '已核验球馆', city: '杭州', active: true, verificationStatus: 'verified' },
          { _id: 'venue_inactive', name: '已下架球馆', city: '杭州', active: false, verificationStatus: 'verified' },
          { _id: 'venue_pending', name: '待核验球馆', city: '杭州', active: true, verificationStatus: 'pending' }
        ], (value) => { favoriteVenueCondition = value })
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }, { page: 1, pageSize: 20 })
  assert.deepStrictEqual(Object.keys(favoriteVenueCondition), ['_id'])
  assert.deepStrictEqual(favoriteResult.items.map((item) => item.id), ['venue_verified', 'venue_inactive', 'venue_pending'])
  assert.deepStrictEqual(favoriteResult.items.map((item) => item.unavailable), [false, true, true])
  assert.strictEqual(favoriteResult.total, 3)
  assert.strictEqual(favoriteResult.hasMore, false)

  const manyFavoriteDocuments = Array.from({ length: 55 }, (_, index) => ({
    _id: `favorite_${index + 1}`,
    venueId: `venue_saved_${index + 1}`,
    createdAt: new Date(2099, 0, 55 - index)
  }))
  const manyVenues = manyFavoriteDocuments.map((favorite) => ({
    _id: favorite.venueId,
    name: `球馆 ${favorite.venueId}`,
    city: '杭州',
    active: true,
    verificationStatus: 'verified'
  }))
  function pagedFavoritesQuery() {
    let offset = 0
    let size = manyFavoriteDocuments.length
    const query = {
      where() { return query },
      orderBy() { return query },
      skip(value) { offset = value; return query },
      limit(value) { size = value; return query },
      async count() { return { total: manyFavoriteDocuments.length } },
      async get() { return { data: manyFavoriteDocuments.slice(offset, offset + size) } }
    }
    return query
  }
  const manyFavoriteContext = {
    openid: 'viewer_openid',
    command: { in: (values) => ({ values }) },
    db: {
      collection(name) {
        if (name === 'venue_favorites') return { where: () => pagedFavoritesQuery() }
        if (name === 'venues') return {
          where: (condition) => queryReturning(manyVenues.filter((venue) => condition._id.values.includes(venue._id)))
        }
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }
  const favoritePageTwo = await favorites.list(manyFavoriteContext, { page: 2, pageSize: 20 })
  const favoritePageThree = await favorites.list(manyFavoriteContext, { page: 3, pageSize: 20 })
  assert.strictEqual(favoritePageTwo.items.length, 20)
  assert.strictEqual(favoritePageTwo.total, 55)
  assert.strictEqual(favoritePageTwo.hasMore, true)
  assert.strictEqual(favoritePageThree.items.length, 15)
  assert.strictEqual(favoritePageThree.total, 55)
  assert.strictEqual(favoritePageThree.hasMore, false)

  let storedFavorite = null
  let favoriteSetCount = 0
  let favoriteRemoveCount = 0
  let favoriteVenue = { _id: 'venue_markable', active: true, verificationStatus: 'verified' }
  const favoriteContext = {
    openid: 'favorite_owner',
    requestId: 'request_favorite_set',
    command: { in: (values) => ({ values }) },
    serverDate: () => 'SERVER_DATE',
    db: {
      collection(name) {
        if (name === 'venue_favorites') {
          return {
            doc(id) {
              return {
                async get() { return { data: storedFavorite && storedFavorite._id === id ? storedFavorite : null } },
                async set({ data }) {
                  favoriteSetCount += 1
                  storedFavorite = Object.assign({ _id: id }, data)
                },
                async remove() {
                  favoriteRemoveCount += 1
                  storedFavorite = null
                }
              }
            },
            where(condition) {
              const ids = condition._id.values
              return queryReturning(storedFavorite && ids.includes(storedFavorite._id) ? [storedFavorite] : [])
            }
          }
        }
        if (name === 'venues') return { doc: () => ({ get: async () => ({ data: favoriteVenue }) }) }
        if (name === 'audit_logs') return { add: async () => ({}) }
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }
  await favorites.set(favoriteContext, { venueId: 'venue_markable', marked: true })
  assert.strictEqual(favoriteSetCount, 1)
  assert.deepStrictEqual(storedFavorite, {
    _id: favorites._private.favoriteId('favorite_owner', 'venue_markable'),
    userId: 'favorite_owner',
    venueId: 'venue_markable',
    createdAt: 'SERVER_DATE'
  })
  await favorites.set(favoriteContext, { venueId: 'venue_markable', marked: true })
  assert.strictEqual(favoriteSetCount, 1, '重复标记不得重复写入')
  const favoriteStatus = await favorites.status(favoriteContext, { venueIds: ['venue_markable', 'venue_other'] })
  assert.deepStrictEqual(favoriteStatus, { markedIds: ['venue_markable'] })

  favoriteVenue = Object.assign({}, favoriteVenue, { active: false })
  await favorites.set(favoriteContext, { venueId: 'venue_markable', marked: false })
  assert.strictEqual(favoriteRemoveCount, 1, '球馆下架后仍应允许用户清理自己的标记')
  await favorites.set(favoriteContext, { venueId: 'venue_markable', marked: false })
  assert.strictEqual(favoriteRemoveCount, 1, '重复取消标记应保持幂等')
  await rejectsCode(() => favorites.set(favoriteContext, { venueId: 'venue_markable', marked: true }), 'NOT_FOUND')

  const venueRace = venueDeactivationRace()
  await rejectsCode(() => matches.create(venueRace.context, {
    venueId: venueRace.venueId,
    title: '非法练球方式测试',
    date: '2099-05-01',
    startTime: '18:00',
    endTime: '19:00',
    capacity: 4,
    practiceIntent: '高强度训练',
    joinMode: 'direct',
    courtStatus: 'unbooked',
    termsAccepted: true,
    termsVersion: terms.currentVersion()
  }), 'INVALID_ARGUMENT')
  await rejectsCode(() => matches.create(venueRace.context, {
    venueId: venueRace.venueId,
    title: '球馆停用竞态测试',
    date: '2099-05-01',
    startTime: '19:00',
    endTime: '20:00',
    capacity: 4,
    joinMode: 'direct',
    courtStatus: 'unbooked',
    termsAccepted: true,
    termsVersion: terms.currentVersion()
  }), 'NOT_FOUND')
  assert.strictEqual(venueRace.matchWritten(), false, '事务看到球馆已停用后不得创建球局')

  const soloRace = venueDeactivationRace({ deactivateInTransaction: false })
  const soloResult = await matches.create(soloRace.context, {
    venueId: soloRace.venueId,
    title: '单人练习',
    date: '2099-05-01',
    startTime: '20:00',
    endTime: '21:00',
    capacity: 1,
    joinMode: 'direct',
    courtStatus: 'unbooked',
    termsAccepted: true,
    termsVersion: terms.currentVersion()
  })
  assert.strictEqual(soloResult.match.capacity, 1)
  assert.deepStrictEqual(soloResult.match.venue.location, { longitude: 120.1551, latitude: 30.2741 })
  assert.strictEqual(soloResult.match.seats, 0)
  assert.strictEqual(soloResult.match.status, 'full')
  assert.strictEqual(soloResult.match.practiceIntent, '随便练练')
  assert.strictEqual(soloRace.matchWritten(), true, '单人练习应正常创建且不开放加入')

  const soloJoinRace = joinBlockRace({
    _id: 'match_solo_join_guard',
    capacity: 1,
    participantCount: 1,
    status: 'full'
  })
  await rejectsCode(() => matches.join(soloJoinRace.context, {
    matchId: soloJoinRace.matchId,
    allowWaitlist: true,
    termsAccepted: true,
    termsVersion: terms.currentVersion()
  }), 'MATCH_CLOSED')
  assert.strictEqual(soloJoinRace.membershipWritten(), false, '单人练习不得生成候补记录')
  assert.strictEqual(soloJoinRace.matchWritten(), false, '单人练习不得增加候补人数')

  const joinRace = joinBlockRace()
  await rejectsCode(() => matches.join(joinRace.context, {
    matchId: joinRace.matchId,
    allowWaitlist: false,
    termsAccepted: true,
    termsVersion: terms.currentVersion()
  }), 'FORBIDDEN')
  assert.deepStrictEqual(joinRace.requestedBlockIds, joinRace.expectedBlockIds, '加入事务必须按稳定 ID 检查双方拉黑关系')
  assert.strictEqual(joinRace.membershipWritten(), false, '事务看到已拉黑后不得写入成员记录')
  assert.strictEqual(joinRace.matchWritten(), false, '事务看到已拉黑后不得占用球局名额')

  const respondRace = respondJoinBlockRace()
  await rejectsCode(() => matches.respondJoin(respondRace.context, {
    matchId: respondRace.matchId,
    membershipId: respondRace.membershipId,
    decision: 'accept',
    expectedVersion: 1
  }), 'FORBIDDEN')
  assert.deepStrictEqual(respondRace.requestedBlockIds, respondRace.expectedBlockIds, '审批事务必须按稳定 ID 检查双方拉黑关系')
  assert.strictEqual(respondRace.membershipWritten(), false, '事务看到已拉黑后不得接受成员')
  assert.strictEqual(respondRace.matchWritten(), false, '事务看到已拉黑后不得增加球局人数')

  await rejectsCode(() => venues.get({
    db: { collection: () => ({ doc: () => ({ get: async () => ({ data: { _id: 'venue_1', active: true, verificationStatus: 'pending' } }) }) }) }
  }, { venueId: 'venue_1' }), 'NOT_FOUND')

  const publicMatch = presenters.match({
    _id: 'match_1',
    hostSnapshot: {
      playerId: 'player_1',
      displayName: '球友',
      ratingPlatform: '开球网',
      ratingValue: '1888'
    },
    participants: [],
    venueSnapshot: {},
    capacity: 2,
    participantCount: 1
  })
  assert.strictEqual(publicMatch.host.ratingPlatform, '开球网')
  assert.strictEqual(publicMatch.host.ratingValue, '1888')

  const futurePublicMatch = matchDocument()
  const publicResult = await matches.get(matchGetContext(futurePublicMatch), { matchId: futurePublicMatch._id })
  assert.strictEqual(publicResult.match.id, futurePublicMatch._id)
  assert.deepStrictEqual(publicResult.hostVideos, [])

  const cancelledMatch = matchDocument({ status: 'cancelled' })
  const completedMatch = matchDocument({ status: 'completed' })
  const expiredMatch = matchDocument({
    status: 'recruiting',
    startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    endAt: new Date(Date.now() - 60 * 60 * 1000)
  })
  await rejectsCode(() => matches.get(matchGetContext(cancelledMatch), { matchId: cancelledMatch._id }), 'NOT_FOUND')
  await rejectsCode(() => matches.get(matchGetContext(completedMatch), { matchId: completedMatch._id }), 'NOT_FOUND')
  await rejectsCode(() => matches.get(matchGetContext(expiredMatch), { matchId: expiredMatch._id }), 'NOT_FOUND')

  const hostResult = await matches.get(matchGetContext(cancelledMatch, {
    openid: 'host_openid',
    membership: { status: 'cancelled', wasAccepted: true }
  }), { matchId: cancelledMatch._id })
  assert.strictEqual(hostResult.match.id, cancelledMatch._id)

  const joinedCompletedResult = await matches.get(matchGetContext(completedMatch, {
    openid: 'joined_openid',
    membership: { status: 'joined' }
  }), { matchId: completedMatch._id })
  assert.strictEqual(joinedCompletedResult.match.id, completedMatch._id)

  const joinedExpiredResult = await matches.get(matchGetContext(expiredMatch, {
    openid: 'joined_openid',
    membership: { status: 'joined' }
  }), { matchId: expiredMatch._id })
  assert.strictEqual(joinedExpiredResult.match.id, expiredMatch._id)

  const formerMembership = { status: 'cancelled', wasAccepted: true }
  const formerMemberResult = await matches.get(matchGetContext(futurePublicMatch, {
    openid: 'former_member_openid',
    membership: formerMembership
  }), { matchId: futurePublicMatch._id })
  assert.strictEqual(formerMemberResult.membership.canChat, false)
  await rejectsCode(
    () => messages.list(messageContext(futurePublicMatch, formerMembership), { matchId: futurePublicMatch._id }),
    'FORBIDDEN'
  )

  const chatExpiredMatch = matchDocument({
    _id: 'match_chat_expired',
    status: 'completed',
    startAt: new Date(Date.now() - 27 * 60 * 60 * 1000),
    endAt: new Date(Date.now() - 25 * 60 * 60 * 1000)
  })
  await rejectsCode(
    () => messages.list(messageContext(chatExpiredMatch, { status: 'joined' }), { matchId: chatExpiredMatch._id }),
    'CHAT_CLOSED'
  )

  const messageRace = messageCancellationRace()
  await rejectsCode(
    () => messages.send(messageRace.context, { matchId: 'match_message_race', text: '竞态测试消息' }),
    'FORBIDDEN'
  )
  assert.strictEqual(messageRace.messageWritten(), false, '成员取消提交后不得再写入消息')

  const privateHistoryMatch = matchDocument({
    _id: 'match_private_history',
    status: 'completed',
    hostSnapshot: {
      playerId: 'private_host_player_id',
      displayName: '不应暴露的发起人'
    },
    participants: [{
      playerId: 'private_joined_player_id',
      displayName: '不应暴露的参与者',
      avatarFileId: 'cloud://example/private-avatar.jpg',
      ratingPlatform: '开球网',
      ratingValue: '1888'
    }]
  })
  const historyResult = await appointments.list({
    openid: 'rejected_openid',
    command: { in: (value) => ({ in: value }) },
    db: {
      collection(name) {
        if (name === 'match_members') return queryReturning([{
          _id: 'rejected_membership',
          matchId: privateHistoryMatch._id,
          userId: 'rejected_openid',
          status: 'rejected',
          updatedAt: new Date()
        }])
        if (name === 'coach_bookings') return queryReturning([])
        if (name === 'matches') return queryReturning([privateHistoryMatch])
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }, { pageSize: 30 })
  const serializedHistory = JSON.stringify(historyResult)
  assert(!serializedHistory.includes('private_host_player_id'), '未接受申请不得读取历史球局发起人快照')
  assert(!serializedHistory.includes('private_joined_player_id'), '未接受申请不得读取历史球局参与者快照')
  assert(!serializedHistory.includes('private-avatar.jpg'), '未接受申请不得读取历史球局参与者头像 fileID')

  const startedMatch = matchDocument({
    _id: 'match_started',
    status: 'recruiting',
    startAt: new Date(Date.now() - 60 * 60 * 1000),
    endAt: new Date(Date.now() + 60 * 60 * 1000)
  })
  const persistedCompletedMatch = matchDocument({
    _id: 'match_persisted_completed',
    status: 'completed',
    startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    endAt: new Date(Date.now() - 60 * 60 * 1000)
  })
  for (const closedMatch of [startedMatch, persistedCompletedMatch]) {
    const hostMembership = { matchId: closedMatch._id, userId: 'host_openid', status: 'host', confirmedScheduleVersion: 1 }
    await rejectsCode(() => matches.reschedule(
      mutationContext(closedMatch, hostMembership),
      { matchId: closedMatch._id, date: '2099-05-01', startTime: '19:00', endTime: '20:00', expectedVersion: 1 }
    ), 'MATCH_CLOSED')
    await rejectsCode(() => matches.cancel(
      mutationContext(closedMatch, hostMembership),
      { matchId: closedMatch._id, reason: '球局已经开始', expectedVersion: 1 }
    ), 'MATCH_CLOSED')
    await rejectsCode(() => matches.confirmSchedule(
      mutationContext(closedMatch, hostMembership),
      { matchId: closedMatch._id }
    ), 'MATCH_CLOSED')
  }

  const publicPlayer = await players.get({
    openid: 'viewer_openid',
    requestId: 'request_player_get',
    command: { neq: (value) => ({ neq: value }) },
    db: {
      collection(name) {
        if (name === 'users') return queryReturning([{
          _id: 'target_openid',
          publicId: 'player_target',
          status: 'active',
          profile: {
            nickname: '目标球友',
            city: '杭州',
            district: '西湖区',
            ballAge: '球龄 2—5 年',
            skills: ['反手拧拉'],
            ratingPlatform: '开球网',
            ratingValue: '1700'
          }
        }])
        if (name === 'user_blocks') return { doc: () => ({ get: async () => ({ data: null }) }) }
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }, { playerId: 'player_target' })
  assert.strictEqual(publicPlayer.player.displayName, '目标球友')
  assert.strictEqual(publicPlayer.player.ratingValue, '1700')
  assert.strictEqual(publicPlayer.player._id, undefined)
  assert.strictEqual(publicPlayer.player.openid, undefined)
  assert.deepStrictEqual(publicPlayer.videos, [])

  const activeUser = {
    status: 'active',
    publicId: 'player_with_legacy_media',
    profile: {
      nickname: '准备注销',
      videoFileIds: ['cloud://bucket/legacy.mp4', 'invalid-file-id']
    }
  }
  let cleanupJob = null
  let sanitizedUser = null
  const deletionCollection = (name) => {
    if (name === 'account_deletion_jobs') return { doc: () => ({
      get: async () => ({ data: cleanupJob }),
      set: async ({ data }) => { cleanupJob = data }
    }) }
    if (name === 'users') return { doc: () => ({
      get: async () => ({ data: activeUser }),
      update: async ({ data }) => { sanitizedUser = data }
    }) }
    if (name === 'audit_logs') return { add: async () => ({}) }
    throw new Error(`unexpected deletion collection ${name}`)
  }
  const activeDeletion = await safety.deleteAccount({
    openid: 'active_delete_openid',
    requestId: 'request_active_delete',
    user: activeUser,
    serverDate: () => new Date('2030-01-01T00:00:00.000Z'),
    db: {
      collection: deletionCollection,
      runTransaction: async (work) => work({ collection: deletionCollection })
    }
  }, { confirmation: '注销账号' })
  assert.strictEqual(activeDeletion.status, 'deleted')
  assert.deepStrictEqual(cleanupJob.legacyVideoFileIds, ['cloud://bucket/legacy.mp4'])
  assert.deepStrictEqual(sanitizedUser.profile.videoFileIds, [])

  const deletedUser = {
    status: 'deleted',
    publicId: 'deleted_player',
    consentVersion: 'old',
    profile: {}
  }
  const identityContext = {
    wxContext: { OPENID: 'deleted_openid' },
    db: { collection: () => ({ doc: () => ({ get: async () => ({ data: deletedUser }) }) }) }
  }
  const identity = await auth.requireIdentity(identityContext, { allowClosed: true, skipConsentCheck: true })
  assert.strictEqual(identity.status, 'deleted')

  const deletionResult = await safety.deleteAccount({
    openid: 'deleted_openid',
    user: deletedUser,
    db: { collection: () => ({ doc: () => ({ get: async () => ({ data: { _id: 'job_1', status: 'pending' } }) }) }) }
  }, { confirmation: '注销账号' })
  assert.strictEqual(deletionResult.idempotent, true)

  const legacyList = await videos.list({
    openid: 'player_openid',
    command: { neq: (value) => ({ neq: value }) },
    db: { collection: () => queryReturning([{
      _id: 'video_legacy',
      userId: 'player_openid',
      title: '不应返回的标题',
      fileId: 'cloud://bucket/private.mp4',
      durationSeconds: 90,
      visibility: 'public',
      status: 'passed',
      deleted: false,
      createdAt: new Date('2029-01-01T00:00:00.000Z')
    }]) }
  })
  assert.strictEqual(legacyList.items.length, 1)
  assert.strictEqual(legacyList.items[0].id, 'video_legacy')
  assert.strictEqual(legacyList.items[0].fileId, undefined)
  assert.strictEqual(legacyList.items[0].title, undefined)
  assert.strictEqual(legacyList.items[0].durationSeconds, undefined)
  assert.strictEqual(legacyList.items[0].visibility, undefined)

  const removed = await videos.remove({
    openid: 'player_openid',
    requestId: 'request_123456',
    db: { collection: () => ({ doc: () => ({ get: async () => ({ data: {
      _id: 'video_1',
      userId: 'player_openid',
      deleted: true,
      deletionRequestId: 'request_123456'
    } }) }) }) }
  }, { videoId: 'video_1' })
  assert.strictEqual(removed.idempotent, true)

  await assert.rejects(() => videos.register({
    db: { collection() { throw new Error('disabled registration must not read or write data') } }
  }, { fileId: 'cloud://old/file.mp4', uploadToken: 'previously_issued_ticket' }), error => error.code === 'FEATURE_DISABLED')

  const libRoot = path.resolve(__dirname, '..', 'lib')
  ;['favorites.js', 'files.js', 'matches.js', 'coach-bookings.js'].forEach((file) => {
    const source = fs.readFileSync(path.join(libRoot, file), 'utf8')
    assert(source.includes("verificationStatus === 'verified'") || source.includes("verificationStatus: 'verified'"), `${file} must enforce verified supply`)
  })
  assert(fs.readFileSync(path.join(libRoot, 'matches.js'), 'utf8').includes('member.requestId === context.requestId'))

  console.log('cloud-api-hardening-tests-ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
