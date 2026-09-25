const assert = require('assert')
const messages = require('../lib/messages')

function createDatabase(seed) {
  const stats = { docGets: 0, queryGets: 0 }
  const stores = new Map(Object.entries(seed).map(([name, rows]) => [
    name,
    new Map(rows.map((row) => [row._id, Object.assign({}, row)]))
  ]))
  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map())
    return stores.get(name)
  }
  function doc(name, id) {
    return {
      async get() { stats.docGets += 1; return { data: store(name).has(id) ? Object.assign({ _id: id }, store(name).get(id)) : null } },
      async set({ data }) { store(name).set(id, Object.assign({}, data)) },
      async update({ data }) { store(name).set(id, Object.assign({}, store(name).get(id), data)) }
    }
  }
  function query(name, rows) {
    return {
      where(condition) {
        return query(name, rows.filter((row) => Object.entries(condition).every(([key, value]) => (
          value && Array.isArray(value.$in) ? value.$in.includes(row[key]) : row[key] === value
        ))))
      },
      orderBy(field, direction) {
        const sign = direction === 'desc' ? -1 : 1
        rows.sort((left, right) => sign * (new Date(left[field]).getTime() - new Date(right[field]).getTime()))
        return this
      },
      skip(count) { return query(name, rows.slice(count)) },
      limit(count) { return query(name, rows.slice(0, count)) },
      async get() { stats.queryGets += 1; return { data: rows.map((row) => Object.assign({}, row)) } }
    }
  }
  function collection(name) {
    const result = query(name, Array.from(store(name), ([id, value]) => Object.assign({ _id: id }, value)))
    result.doc = (id) => doc(name, id)
    return result
  }
  return {
    collection,
    runTransaction: (work) => work({ collection }),
    record: (name, id) => store(name).get(id),
    stats
  }
}

async function run() {
  const matchId = 'match_notice'
  const receiver = 'openid_receiver'
  const sender = 'openid_sender'
  const messageId = 'message_notice'
  const secondMatchId = 'match_notice_older'
  const secondMessageId = 'message_notice_older'
  const revokedMatchId = 'match_notice_revoked'
  const revokedMessageId = 'message_notice_revoked'
  const inboxId = messages._private.inboxId(matchId, receiver)
  const memberId = require('../lib/database').stableId('match-member', matchId, receiver)
  const secondInboxId = messages._private.inboxId(secondMatchId, receiver)
  const secondMemberId = require('../lib/database').stableId('match-member', secondMatchId, receiver)
  const db = createDatabase({
    message_inboxes: [
      { _id: messages._private.inboxId(revokedMatchId, receiver), userId: receiver, matchId: revokedMatchId, lastMessageId: revokedMessageId, unread: true, unreadCount: 50, updatedAt: new Date('2030-01-01T11:00:00Z') },
      { _id: inboxId, userId: receiver, matchId, lastMessageId: messageId, unread: true, unreadCount: 2, updatedAt: new Date('2030-01-01T10:00:00Z') },
      { _id: secondInboxId, userId: receiver, matchId: secondMatchId, lastMessageId: secondMessageId, unread: true, unreadCount: 3, updatedAt: new Date('2030-01-01T09:00:00Z') }
    ],
    match_members: [
      { _id: memberId, userId: receiver, matchId, status: 'joined' },
      { _id: secondMemberId, userId: receiver, matchId: secondMatchId, status: 'joined' }
    ],
    matches: [
      { _id: matchId, title: '滨江晚场', date: '2099-01-01', startTime: '19:00', endAt: new Date('2099-01-01T12:00:00Z'), status: 'recruiting', venueSnapshot: { name: '萧潮乒乓球馆' } },
      { _id: secondMatchId, title: '滨江早场', date: '2099-01-02', startTime: '09:00', endAt: new Date('2099-01-02T12:00:00Z'), status: 'recruiting', venueSnapshot: { name: '桂语朝阳乒乓球室' } },
      { _id: revokedMatchId, title: '已退出球局', date: '2099-01-03', startTime: '11:00', endAt: new Date('2099-01-03T12:00:00Z'), status: 'recruiting', venueSnapshot: { name: '无权限球馆' } }
    ],
    match_messages: [
      { _id: messageId, matchId, senderId: sender, senderSnapshot: { playerId: 'player_sender', displayName: '林小拍' }, type: 'text', text: '我订好 3 号台了', deleted: false, createdAt: new Date('2030-01-01T10:00:00Z') },
      { _id: secondMessageId, matchId: secondMatchId, senderId: 'openid_sender_2', senderSnapshot: { playerId: 'player_sender_2', displayName: '陈小拍' }, type: 'text', text: '早场见', deleted: false, createdAt: new Date('2030-01-01T09:00:00Z') },
      { _id: revokedMessageId, matchId: revokedMatchId, senderId: 'openid_sender_3', senderSnapshot: { playerId: 'player_sender_3', displayName: '无权限用户' }, type: 'text', text: '不应展示', deleted: false, createdAt: new Date('2030-01-01T11:00:00Z') }
    ],
    user_blocks: []
  })
  let tick = 0
  const context = {
    openid: receiver,
    db,
    command: { in: (values) => ({ $in: values }) },
    serverDate: () => new Date(2030, 0, 1, 10, 1, tick++)
  }
  const listed = await messages.inbox(context, { pageSize: 1 })
  assert.strictEqual(listed.unreadCount, 5, '红点应统计当前页之外的有效未读消息')
  assert.strictEqual(listed.items.length, 1)
  assert.strictEqual(listed.hasMore, true)
  assert.strictEqual(listed.items[0].preview, '我订好 3 号台了')
  assert(!JSON.stringify(listed).includes('不应展示'), '退出球局后必须实时撤销消息权限')
  assert.strictEqual(listed.items[0].match.venueName, '萧潮乒乓球馆')
  assert(!JSON.stringify(listed).includes(receiver), '收件箱响应不得暴露内部接收用户 ID')
  assert(!JSON.stringify(listed).includes(sender), '收件箱响应不得暴露内部发送用户 ID')
  assert.strictEqual(db.stats.docGets, 1, '成员、球局和消息保持批量查询；仅对一条失效 inbox 做并发安全清理')
  assert.strictEqual(db.stats.queryGets, 5, '收件箱应只批量读取本批消息相关的权限与屏蔽记录')

  const marked = await messages.read(context, { matchId, messageId })
  assert.strictEqual(marked.read, true)
  assert.strictEqual(db.record('message_inboxes', inboxId).unread, false)
  assert.strictEqual(db.record('message_inboxes', inboxId).unreadCount, 0)

  const senderDb = createDatabase({ message_inboxes: [] })
  const senderContext = { openid: sender, db: senderDb, serverDate: () => new Date('2030-01-01T10:00:00Z') }
  await messages._private.updateInboxes(senderContext, { collection: senderDb.collection }, {
    _id: matchId, hostId: sender, participantIds: [sender, receiver]
  }, 'message_fanout')
  assert.strictEqual(senderDb.record('message_inboxes', messages._private.inboxId(matchId, sender)).unread, false)
  assert.strictEqual(senderDb.record('message_inboxes', messages._private.inboxId(matchId, receiver)).unread, true)

  // Hold every read until all eight have started: serial fanout would stall here.
  const deferredReads = []
  const written = []
  const eight = Array.from({ length: 8 }, (_, index) => 'user_' + index)
  const fanout = messages._private.updateInboxes({ openid: eight[0], serverDate: () => new Date() }, {
    collection: () => ({ doc: (id) => ({
      get: () => new Promise((resolve) => deferredReads.push(resolve)),
      set: async ({ data }) => { written.push({ id, data }) }
    }) })
  }, { _id: 'eight_person_match', hostId: eight[0], participantIds: eight }, 'fanout_message')
  assert.strictEqual(deferredReads.length, 8, '八位成员的独立收件箱并发读取，不串行等候')
  deferredReads.forEach((resolve) => resolve({ data: null }))
  await fanout
  assert.strictEqual(written.length, 8)
  assert.strictEqual(written.filter((item) => item.data.unread).length, 7)
  const presenters = require('../lib/presenters')
  const ownMessage = { _id: 'm1', senderId: sender, requestId: 'client-request' }
  assert.strictEqual(presenters.message(ownMessage, sender).clientRequestId, 'client-request')
  assert.strictEqual(presenters.message(ownMessage, receiver).clientRequestId, '', '请求编号只向发送者返回')

  const emptyDb = createDatabase({ message_inboxes: [], user_blocks: [] })
  const empty = await messages.inbox({ openid: receiver, db: emptyDb, command: context.command }, { pageSize: 10 })
  assert.deepStrictEqual(empty, { items: [], unreadCount: 0, hasMore: false, recoveryPending: false })
  assert.strictEqual(emptyDb.stats.queryGets, 1, '无未读是常态，只应读取一次 inbox，不再额外查询屏蔽关系')

  const staleRows = []
  const staleMessages = []
  const staleMatches = []
  for (let index = 0; index < 100; index += 1) {
    const staleMatchId = `stale_match_${index}`
    const staleMessageId = `stale_message_${index}`
    staleRows.push({ _id: `stale_inbox_${index}`, userId: receiver, matchId: staleMatchId, lastMessageId: staleMessageId, unread: true, unreadCount: 1, updatedAt: new Date(2030, 0, 2, 12, 0, 100 - index) })
    staleMatches.push({ _id: staleMatchId, endAt: new Date('2099-01-01T12:00:00Z'), status: 'cancelled' })
    staleMessages.push({ _id: staleMessageId, matchId: staleMatchId, senderId: `stale_sender_${index}`, deleted: false })
  }
  const validMatchId = 'match_after_stale_page'
  const validMessageId = 'message_after_stale_page'
  const validMemberId = require('../lib/database').stableId('match-member', validMatchId, receiver)
  const pagedDb = createDatabase({
    message_inboxes: staleRows.concat([{ _id: 'valid_inbox_after_stale', userId: receiver, matchId: validMatchId, lastMessageId: validMessageId, unread: true, unreadCount: 4, updatedAt: new Date('2029-12-31T12:00:00Z') }]),
    match_members: [{ _id: validMemberId, userId: receiver, matchId: validMatchId, status: 'joined' }],
    matches: staleMatches.concat([{ _id: validMatchId, title: '翻页后有效球局', date: '2099-01-04', startTime: '20:00', endAt: new Date('2099-01-04T12:00:00Z'), status: 'recruiting', venueSnapshot: { name: '滨江球馆' } }]),
    match_messages: staleMessages.concat([{ _id: validMessageId, matchId: validMatchId, senderId: sender, senderSnapshot: { playerId: 'player_sender', displayName: '林小拍' }, text: '翻页后仍应看见', deleted: false, createdAt: new Date('2029-12-31T12:00:00Z') }]),
    user_blocks: []
  })
  const cleaning = await messages.inbox({ openid: receiver, db: pagedDb, command: context.command, serverDate: context.serverDate }, { pageSize: 10 })
  assert.strictEqual(cleaning.hasMore, true)
  assert.strictEqual(cleaning.recoveryPending, true)
  assert.deepStrictEqual(cleaning.items, [], '首轮只做小批量失效指针清理，避免读请求超时')
  const paged = await messages.inbox({ openid: receiver, db: pagedDb, command: context.command, serverDate: context.serverDate }, { pageSize: 10 })
  assert.strictEqual(paged.unreadCount, 4)
  assert.strictEqual(paged.items.length, 1)
  assert.strictEqual(paged.items[0].preview, '翻页后仍应看见')

  const blockId = require('../lib/database').stableId('user-block', sender, receiver)
  const blockedDb = createDatabase({
    message_inboxes: [{ _id: 'blocked_inbox', userId: receiver, matchId: validMatchId, lastMessageId: validMessageId, unread: true, unreadCount: 1, updatedAt: new Date('2030-01-01T12:00:00Z') }],
    match_members: [{ _id: validMemberId, userId: receiver, matchId: validMatchId, status: 'joined' }],
    matches: [{ _id: validMatchId, endAt: new Date('2099-01-04T12:00:00Z'), status: 'recruiting', venueSnapshot: {} }],
    match_messages: [{ _id: validMessageId, matchId: validMatchId, senderId: sender, senderSnapshot: { playerId: 'player_sender' }, text: '被屏蔽消息', deleted: false, createdAt: new Date('2030-01-01T12:00:00Z') }],
    user_blocks: [{ _id: blockId, userId: sender, targetUserId: receiver, active: true }]
  })
  const blocked = await messages.inbox({ openid: receiver, db: blockedDb, command: context.command, serverDate: context.serverDate }, { pageSize: 10 })
  assert.deepStrictEqual(blocked.items, [])
  assert.strictEqual(blocked.unreadCount, 0, '双向任一方向屏蔽都不得进入红点统计')

  const raceInboxId = messages._private.inboxId('race_match', receiver)
  const raceDb = createDatabase({ message_inboxes: [{ _id: raceInboxId, userId: receiver, matchId: 'race_match', lastMessageId: 'old_message', unread: true, unreadCount: 1 }] })
  await raceDb.collection('message_inboxes').doc(raceInboxId).update({ data: { lastMessageId: 'new_message', unreadCount: 2 } })
  await messages._private.clearStaleInboxRecords({ openid: receiver, db: raceDb, serverDate: context.serverDate }, [{ _id: raceInboxId, lastMessageId: 'old_message' }])
  assert.strictEqual(raceDb.record('message_inboxes', raceInboxId).unread, true, '并发到达的新消息不得被旧扫描误清')
  assert.strictEqual(raceDb.record('message_inboxes', raceInboxId).unreadCount, 2)

  console.log('message inbox cloud tests passed')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
