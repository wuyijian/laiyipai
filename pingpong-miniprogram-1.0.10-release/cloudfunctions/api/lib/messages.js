const { COLLECTIONS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const presenters = require('./presenters')
const { stableId, getDocument } = require('./database')
const { requireMatch, getMembership } = require('./access')
const { checkText } = require('./moderation')
const { writeAudit } = require('./audit')

const INBOX_BATCH_SIZE = 100
const QUERY_ID_CHUNK_SIZE = 20
const INBOX_CLEANUP_LIMIT = 10

function inboxId(matchId, userId) {
  return stableId('message-inbox', matchId, userId)
}

function recipientIds(match) {
  return Array.from(new Set([match.hostId].concat(Array.isArray(match.participantIds) ? match.participantIds : [])))
    .filter((userId) => typeof userId === 'string' && userId && !/^deleted_/.test(userId))
    .slice(0, 8)
}

async function updateInboxes(context, transaction, match, messageId) {
  for (const userId of recipientIds(match)) {
    const inboxRef = transaction.collection(COLLECTIONS.messageInboxes).doc(inboxId(match._id, userId))
    const current = await getDocument(inboxRef)
    const mine = userId === context.openid
    await inboxRef.set({ data: {
      userId,
      matchId: match._id,
      lastMessageId: messageId,
      unread: !mine,
      unreadCount: mine ? 0 : Math.min(99, Number(current && current.unread ? current.unreadCount : 0) + 1),
      readAt: mine ? context.serverDate() : current && current.readAt || null,
      createdAt: current && current.createdAt || context.serverDate(),
      updatedAt: context.serverDate()
    } })
  }
}

async function blockedUserIds(context, candidateUserIds) {
  const candidates = Array.from(new Set((candidateUserIds || [])
    .filter((userId) => typeof userId === 'string' && userId && userId !== context.openid)))
  if (!candidates.length) return new Set()

  // Block documents have deterministic IDs. Reading only the two possible
  // directions for senders in this response avoids scanning a user's entire
  // block list and cannot truncate after the first 100 relationships.
  const ids = candidates.flatMap((userId) => [
    stableId('user-block', context.openid, userId),
    stableId('user-block', userId, context.openid)
  ])
  const documents = await documentsByIds(context, COLLECTIONS.userBlocks, ids)
  const blocked = new Set()
  candidates.forEach((userId) => {
    const outgoing = documents.get(stableId('user-block', context.openid, userId))
    const incoming = documents.get(stableId('user-block', userId, context.openid))
    if ((outgoing && outgoing.active === true && outgoing.userId === context.openid && outgoing.targetUserId === userId) ||
        (incoming && incoming.active === true && incoming.userId === userId && incoming.targetUserId === context.openid)) {
      blocked.add(userId)
    }
  })
  return blocked
}

async function documentsByIds(context, collectionName, ids) {
  const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)))
  if (!uniqueIds.length) return new Map()
  const groups = []
  for (let index = 0; index < uniqueIds.length; index += QUERY_ID_CHUNK_SIZE) groups.push(uniqueIds.slice(index, index + QUERY_ID_CHUNK_SIZE))
  const results = await Promise.all(groups.map((group) => context.db.collection(collectionName)
    .where({ _id: context.command.in(group) })
    .get()))
  return new Map(results.flatMap((result) => result.data || []).map((document) => [document._id, document]))
}

async function list(context, payload) {
  const matchId = validate.id(payload.matchId, '球局 ID')
  const [match, membership] = await Promise.all([
    requireMatch(context, matchId),
    getMembership(context, matchId, context.openid)
  ])
  assert(membership && ['host', 'joined'].includes(membership.status), 'FORBIDDEN', '仅当前球局成员可查看群聊')
  assert(new Date(match.endAt).getTime() + 24 * 60 * 60 * 1000 > Date.now(), 'CHAT_CLOSED', '球局结束 24 小时后群聊已关闭')
  const pageSize = validate.integer(payload.pageSize === undefined ? 50 : payload.pageSize, '每页数量', { min: 1, max: 100 })
  const condition = { matchId, deleted: context.command.neq(true) }
  if (payload.before) {
    const before = validate.timestamp(payload.before, '消息游标')
    condition.createdAt = context.command.lt(before)
  }
  const result = await context.db.collection(COLLECTIONS.messages)
    .where(condition)
    .orderBy('createdAt', 'desc')
    .limit(pageSize)
    .get()
  const blocked = await blockedUserIds(context, result.data.map((item) => item.senderId))
  return {
    items: result.data.filter((item) => !blocked.has(item.senderId)).reverse().map((item) => presenters.message(item, context.openid)),
    nextCursor: result.data.length === pageSize ? result.data[result.data.length - 1].createdAt : null
  }
}

async function send(context, payload) {
  const matchId = validate.id(payload.matchId, '球局 ID')
  const text = validate.text(payload.text, '消息', { min: 1, max: 500 })
  await checkText(context, [text], 2)
  const messageId = stableId('match-message', context.openid, validate.id(context.requestId, '请求 ID'))
  let idempotent = false
  await context.db.runTransaction(async (transaction) => {
    const match = await requireMatch(context, matchId, transaction)
    const membership = await getMembership(context, matchId, context.openid, transaction)
    assert(membership && ['host', 'joined'].includes(membership.status), 'FORBIDDEN', '仅当前球局成员可发送消息')
    assert(match.status !== 'cancelled', 'MATCH_CLOSED', '球局已取消，无法继续发送消息')
    assert(new Date(match.endAt).getTime() + 24 * 60 * 60 * 1000 > Date.now(), 'CHAT_CLOSED', '球局结束 24 小时后群聊已关闭')

    const ref = transaction.collection(COLLECTIONS.messages).doc(messageId)
    const existing = await getDocument(ref)
    if (existing) {
      idempotent = true
      return
    }
    await ref.set({ data: {
      matchId,
      senderId: context.openid,
      senderSnapshot: presenters.playerSnapshot(context.user),
      type: 'text',
      text,
      deleted: false,
      requestId: context.requestId,
      createdAt: context.serverDate()
    } })
    await updateInboxes(context, transaction, match, messageId)
  })
  const document = await getDocument(context.db.collection(COLLECTIONS.messages).doc(messageId))
  assert(document, 'SERVICE_UNAVAILABLE', '消息发送结果暂时无法读取')
  await writeAudit(context, 'messages.send', 'message', messageId, { matchId })
  return { message: presenters.message(document, context.openid), idempotent }
}

async function inbox(context, payload) {
  const pageSize = validate.integer(payload.pageSize === undefined ? 5 : payload.pageSize, '每页数量', { min: 1, max: 10 })
  const collection = context.db.collection(COLLECTIONS.messageInboxes)
  let result
  let filterUnreadInMemory = false
  try {
    result = await collection
      .where({ userId: context.openid, unread: true })
      .orderBy('updatedAt', 'desc')
      .limit(INBOX_BATCH_SIZE)
      .get()
  } catch (error) {
    const reason = String(error && (error.errMsg || error.message) || error)
    if (!/index|索引|-502005|query.+require/i.test(reason)) throw error
    // Some production environments were created before the
    // user_unread_updated composite index was added. Keep reminders working
    // while that index is being built; equality-only reads are bounded and
    // sorted in memory.
    console.warn('MESSAGE_INBOX_INDEX_FALLBACK', context.requestId, reason.slice(0, 160))
    try {
      result = await collection
        .where({ userId: context.openid, unread: true })
        .limit(INBOX_BATCH_SIZE)
        .get()
    } catch (fallbackError) {
      const fallbackReason = String(fallbackError && (fallbackError.errMsg || fallbackError.message) || fallbackError)
      if (!/index|索引|-502005|query.+require/i.test(fallbackReason)) throw fallbackError
      result = await collection.where({ userId: context.openid }).limit(INBOX_BATCH_SIZE).get()
      filterUnreadInMemory = true
    }
  }
  const records = (result.data || []).filter((item) => !filterUnreadInMemory || item.unread === true).sort((left, right) => (
    new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime()
  ))
  if (!records.length) return { items: [], unreadCount: 0, hasMore: false, recoveryPending: false }

  const classified = await classifyInboxRecords(context, records)
  const eligible = classified.valid.map((entry) => entry.item)
  const unreadCount = eligible.reduce((count, item) => count + item.unreadCount, 0)
  const staleToClear = classified.stale.slice(0, INBOX_CLEANUP_LIMIT)
  if (staleToClear.length) await clearStaleInboxRecords(context, staleToClear)

  return {
    items: eligible.slice(0, pageSize),
    unreadCount,
    hasMore: eligible.length > pageSize || records.length === INBOX_BATCH_SIZE || classified.stale.length > INBOX_CLEANUP_LIMIT,
    recoveryPending: records.length === INBOX_BATCH_SIZE && classified.stale.length > 0
  }
}

async function classifyInboxRecords(context, records) {
  if (!records.length) return { valid: [], stale: [] }
  const membershipIds = records.map((record) => stableId('match-member', record.matchId, context.openid))
  const [memberships, matches, messages] = await Promise.all([
    documentsByIds(context, COLLECTIONS.matchMembers, membershipIds),
    documentsByIds(context, COLLECTIONS.matches, records.map((record) => record.matchId)),
    documentsByIds(context, COLLECTIONS.messages, records.map((record) => record.lastMessageId))
  ])
  const stale = []
  const candidates = records.map((record, index) => {
    const membership = memberships.get(membershipIds[index])
    const match = matches.get(record.matchId)
    const message = messages.get(record.lastMessageId)
    const activeMember = membership && ['host', 'joined'].includes(membership.status)
    const chatOpen = match && match.status !== 'cancelled' && new Date(match.endAt).getTime() + 24 * 60 * 60 * 1000 > Date.now()
    if (!activeMember || !chatOpen || !message || message.deleted === true || message.matchId !== record.matchId || message.senderId === context.openid) {
      stale.push(record)
      return null
    }
    return { record, match, message }
  }).filter(Boolean)
  if (!candidates.length) return { valid: [], stale }
  const blocked = await blockedUserIds(context, candidates.map((item) => item.message.senderId))
  const valid = candidates.map(({ record, match, message }) => {
    if (blocked.has(message.senderId)) {
      stale.push(record)
      return null
    }
    const sender = presenters.player(message.senderSnapshot)
    const venueSnapshot = match.venueSnapshot || {}
    return {
      inboxId: record._id,
      item: {
        matchId: record.matchId,
        messageId: message._id,
        unreadCount: Math.max(1, Number(record.unreadCount || 1)),
        sender,
        preview: String(message.text || '').slice(0, 80),
        match: {
          title: match.title || '乒乓球局',
          date: match.date || '',
          startTime: match.startTime || '',
          venueName: venueSnapshot.name || '球馆待确认'
        },
        createdAt: message.createdAt
      }
    }
  }).filter(Boolean)
  return { valid, stale }
}

async function clearStaleInboxRecords(context, records) {
  const unique = Array.from(new Map(records
    .filter((record) => record && record._id && record.lastMessageId)
    .map((record) => [record._id, record])).values())
  try {
    for (let index = 0; index < unique.length; index += INBOX_CLEANUP_LIMIT) {
      const group = unique.slice(index, index + INBOX_CLEANUP_LIMIT)
      await context.db.runTransaction(async (transaction) => {
        for (const record of group) {
          const ref = transaction.collection(COLLECTIONS.messageInboxes).doc(record._id)
          const current = await getDocument(ref)
          // A concurrent send may have replaced lastMessageId. Never clear the
          // newer notification in that case.
          if (!current || current.userId !== context.openid || current.unread !== true || current.lastMessageId !== record.lastMessageId) continue
          await ref.update({ data: {
            unread: false,
            unreadCount: 0,
            readAt: context.serverDate(),
            updatedAt: context.serverDate()
          } })
        }
      })
    }
    return true
  } catch (_) {
    return false
  }
}

async function read(context, payload) {
  const matchId = validate.id(payload.matchId, '球局 ID')
  const messageId = validate.id(payload.messageId, '消息 ID')
  let marked = false
  await context.db.runTransaction(async (transaction) => {
    const ref = transaction.collection(COLLECTIONS.messageInboxes).doc(inboxId(matchId, context.openid))
    const current = await getDocument(ref)
    if (!current || current.userId !== context.openid || current.matchId !== matchId) return
    if (current.lastMessageId !== messageId) return
    if (!current.unread && Number(current.unreadCount || 0) === 0) {
      marked = true
      return
    }
    await ref.update({ data: { unread: false, unreadCount: 0, readAt: context.serverDate(), updatedAt: context.serverDate() } })
    marked = true
  })
  return { read: marked }
}

module.exports = { list, send, inbox, read, _private: { inboxId, recipientIds, updateInboxes, documentsByIds, blockedUserIds, classifyInboxRecords, clearStaleInboxRecords } }
