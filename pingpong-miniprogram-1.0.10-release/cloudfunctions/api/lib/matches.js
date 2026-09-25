const { COLLECTIONS, MATCH_ACTIVE_STATUSES } = require('./constants')
const { ApiError, assert } = require('./errors')
const validate = require('./validate')
const presenters = require('./presenters')
const { stableId, getDocument } = require('./database')
const { memberDocumentId, requireMatch, getMembership } = require('./access')
const { writeAudit } = require('./audit')
const { checkText } = require('./moderation')
const matchOptions = require('./match-options')
const terms = require('./terms')
const friends = require('./friends')

function requestedDistrict(payload) {
  if (payload.district === undefined) return undefined
  return validate.oneOf(payload.district, [''].concat(matchOptions.DISTRICTS), '行政区')
}

function sameVersion(document, expectedVersion) {
  assert(Number(document.version || 0) === expectedVersion, 'VERSION_CONFLICT', '球局信息已更新，请刷新后重试', {
    currentVersion: Number(document.version || 0)
  })
}

function activeMatch(document) {
  return MATCH_ACTIVE_STATUSES.includes(document.status) && new Date(document.startAt).getTime() > Date.now()
}

function retainedMember(document, membership, openid) {
  if (document.hostId === openid) return true
  if (!membership) return false
  if (['host', 'joined'].includes(membership.status)) return true
  return membership.status === 'cancelled' && membership.wasAccepted === true
}

function presentedMatchState(document) {
  if (!MATCH_ACTIVE_STATUSES.includes(document.status) || activeMatch(document)) return document
  const ended = new Date(document.endAt).getTime() <= Date.now()
  return Object.assign({}, document, { status: ended ? 'completed' : 'started' })
}

function presentMatch(document) {
  return presenters.match(document)
}

function canChat(document, membership) {
  if (!membership || !['host', 'joined'].includes(membership.status)) return false
  if (Number(document.capacity || 0) <= 1) return false
  if (document.status === 'cancelled') return false
  const endTime = new Date(document.endAt).getTime()
  return Number.isFinite(endTime) && endTime + 24 * 60 * 60 * 1000 > Date.now()
}

async function blockedUserIds(context) {
  if (!context.openid) return new Set()
  const [outgoing, incoming] = await Promise.all([
    context.db.collection(COLLECTIONS.userBlocks).where({ userId: context.openid, active: true }).limit(100).get(),
    context.db.collection(COLLECTIONS.userBlocks).where({ targetUserId: context.openid, active: true }).limit(100).get()
  ])
  return new Set(outgoing.data.map((item) => item.targetUserId).concat(incoming.data.map((item) => item.userId)))
}

async function assertNotBlockedInTransaction(context, transaction, otherUserId, message) {
  const outgoing = await getDocument(transaction.collection(COLLECTIONS.userBlocks)
    .doc(stableId('user-block', context.openid, otherUserId)))
  const incoming = await getDocument(transaction.collection(COLLECTIONS.userBlocks)
    .doc(stableId('user-block', otherUserId, context.openid)))
  assert(!(outgoing && outgoing.active) && !(incoming && incoming.active), 'FORBIDDEN', message)
}

async function list(context, payload) {
  const paging = validate.pagination(payload)
  const friendsOnly = payload.friendsOnly === true
  assert(!friendsOnly || context.user && !context.publicRead, 'LOGIN_REQUIRED', '登录后才能筛选球友局')
  const condition = {
    status: context.command.in(MATCH_ACTIVE_STATUSES),
    startAt: context.command.gte(new Date())
  }
  if (payload.venueId) {
    // venueId 全局唯一；避免额外 city 条件使球馆详情查询错过既有组合索引。
    condition.venueId = validate.id(payload.venueId, '球馆 ID')
  } else {
    condition.city = payload.city ? validate.text(payload.city, '城市', { max: 20 }) : '杭州'
    if (payload.district) condition.district = validate.text(payload.district, '地区', { max: 20 })
  }
  if (payload.date) condition.date = validate.date(payload.date, '球局日期')
  if (payload.expectedBallAge) condition.expectedBallAge = validate.text(payload.expectedBallAge, '球龄要求', { max: 30 })
  const blocked = await blockedUserIds(context)
  const friendIds = friendsOnly ? await friends.ids(context, { blocked }) : null
  if (friendsOnly && !friendIds.size) {
    return { items: [], page: paging.page, pageSize: paging.pageSize, hasMore: false }
  }
  const result = await context.db.collection(COLLECTIONS.matches)
    .where(condition)
    .orderBy('startAt', 'asc')
    .skip((paging.page - 1) * paging.pageSize)
    .limit(paging.pageSize + 1)
    .get()
  const visible = result.data.filter((item) => {
    if (blocked.has(item.hostId)) return false
    if (!friendIds) return true
    return (item.participantIds || []).some(userId => friendIds.has(userId))
  })
  return {
    items: visible.slice(0, paging.pageSize).map(presentMatch),
    page: paging.page,
    pageSize: paging.pageSize,
    hasMore: result.data.length > paging.pageSize
  }
}

async function get(context, payload) {
  const matchId = validate.id(payload.matchId, '球局 ID')
  const document = await requireMatch(context, matchId)
  if (context.publicRead) {
    const blocked = await blockedUserIds(context)
    assert(!blocked.has(document.hostId), 'NOT_FOUND', '球局不存在或不可见')
    assert(activeMatch(document), 'NOT_FOUND', '球局不存在或不可见')
    return {
      match: presentMatch(presentedMatchState(document)),
      // Compatibility for older clients without exposing retained legacy media.
      hostVideos: []
    }
  }
  const [blocked, membership] = await Promise.all([
    blockedUserIds(context),
    context.openid ? getMembership(context, matchId, context.openid) : Promise.resolve(null)
  ])
  assert(!blocked.has(document.hostId), 'NOT_FOUND', '球局不存在或不可见')
  assert(activeMatch(document) || retainedMember(document, membership, context.openid), 'NOT_FOUND', '球局不存在或不可见')
  const membersResult = await context.db.collection(COLLECTIONS.matchMembers).where({
    matchId,
    status: context.command.in(['host', 'joined'])
  }).limit(8).get()
  return {
    match: presentMatch(presentedMatchState(document)),
    confirmedCount: membersResult.data.filter((item) => Number(item.confirmedScheduleVersion || 0) === Number(document.scheduleVersion || 1)).length,
    // Compatibility for older clients without exposing retained legacy media.
    hostVideos: [],
    membership: membership ? {
      status: membership.status,
      confirmedScheduleVersion: Number(membership.confirmedScheduleVersion || 0),
      canChat: canChat(document, membership)
    } : null
  }
}

async function create(context, payload) {
  const district = requestedDistrict(payload)
  const termsVersion = terms.requireAcceptance(payload)
  const requestId = validate.id(context.requestId, '请求 ID')
  const venueId = validate.id(payload.venueId, '球馆 ID')
  const title = validate.text(payload.title, '球局名称', { min: 2, max: 30 })
  const schedule = validate.schedule(payload.date, payload.startTime || payload.time, payload.endTime)
  const capacity = validate.integer(payload.capacity, '总人数', { min: 1, max: 8 })
  const feePerPerson = validate.integer(payload.feePerPerson === undefined ? payload.fee || 0 : payload.feePerPerson, '人均费用', { min: 0, max: 999 })
  const expectedBallAge = validate.text(payload.expectedBallAge || payload.expectedExperience || '不限球龄', '球龄要求', { max: 30 })
  const legacySkills = payload.skills === undefined ? [] : validate.stringArray(payload.skills, '练习技术', { maxItems: 6, itemMax: 16 })
  const practiceIntent = validate.oneOf(
    payload.practiceIntent === undefined
      ? matchOptions.normalizeStoredPracticeIntent(undefined, legacySkills)
      : payload.practiceIntent,
    matchOptions.PRACTICE_INTENTS,
    '想练什么'
  )
  const note = validate.text(payload.note || '', '补充说明', { required: false, max: 300 })
  const joinMode = validate.oneOf(payload.joinMode || 'direct', ['direct', 'confirm'], '加入方式')
  const courtStatus = validate.oneOf(payload.courtStatus || 'unbooked', ['booked', 'unbooked'], '球台预订状态')
  const courtBookingNote = validate.text(payload.courtBookingNote || '', '球台说明', { required: false, max: 120 })
  await checkText(context, [title, expectedBallAge, note, courtBookingNote, practiceIntent].concat(legacySkills), 2)

  const matchId = stableId('match-create', context.openid, requestId)
  const existing = await getDocument(context.db.collection(COLLECTIONS.matches).doc(matchId))
  if (existing) return { match: presentMatch(existing), membership: { status: 'host', canChat: true }, idempotent: true }

  const hostSnapshot = presenters.playerSnapshot(context.user)
  await context.db.runTransaction(async (transaction) => {
    const matchRef = transaction.collection(COLLECTIONS.matches).doc(matchId)
    const duplicate = await getDocument(matchRef)
    if (duplicate) return
    const venue = await getDocument(transaction.collection(COLLECTIONS.venues).doc(venueId))
    assert(venue && venue.active && venue.verificationStatus === 'verified', 'NOT_FOUND', '球馆不存在或暂未开放')
    const match = {
      title,
      city: venue.city,
      district: venue.district || district || '',
      venueId,
      venueSnapshot: {
        id: venueId,
        name: venue.name,
        address: venue.listingMode === 'name_only' ? '' : venue.address || '',
        location: venue.listingMode === 'name_only' ? null : venue.location || null,
        listingMode: venue.listingMode === 'name_only' ? 'name_only' : 'full'
      },
      date: schedule.date,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      capacity,
      participantCount: 1,
      waitlistCount: 0,
      participants: [hostSnapshot],
      participantIds: [context.openid],
      hostId: context.openid,
      hostSnapshot,
      expectedBallAge,
      practiceIntent,
      skills: legacySkills,
      feePerPerson,
      courtStatus,
      courtBookingNote,
      note,
      joinMode,
      termsVersion,
      status: capacity === 1 ? 'full' : 'recruiting',
      scheduleVersion: 1,
      version: 1,
      createdAt: context.serverDate(),
      updatedAt: context.serverDate()
    }
    await matchRef.set({ data: match })
    await transaction.collection(COLLECTIONS.matchMembers).doc(memberDocumentId(matchId, context.openid)).set({
      data: {
        matchId,
        userId: context.openid,
        status: 'host',
        playerSnapshot: hostSnapshot,
        confirmedScheduleVersion: 1,
        requestId,
        termsVersion,
        termsAcceptedAt: context.serverDate(),
        createdAt: context.serverDate(),
        updatedAt: context.serverDate()
      }
    })
  })
  const created = await requireMatch(context, matchId)
  await writeAudit(context, 'matches.create', 'match', matchId, { venueId, startAt: schedule.startAt })
  return { match: presentMatch(created), membership: { status: 'host', canChat: true }, idempotent: false }
}

async function join(context, payload) {
  const termsVersion = terms.requireAcceptance(payload)
  const matchId = validate.id(payload.matchId, '球局 ID')
  const allowWaitlist = payload.allowWaitlist === true
  // Optional for 1.0.7 clients. New clients confirm the arrangement they saw,
  // not changes made by the host between opening the sheet and submitting.
  const expectedScheduleVersion = payload.expectedScheduleVersion === undefined ? null
    : validate.integer(payload.expectedScheduleVersion, '安排版本', { min: 1 })
  const expectedFeePerPerson = payload.expectedFeePerPerson === undefined ? null
    : validate.integer(payload.expectedFeePerPerson, '预计费用', { min: 0, max: 999 })
  const snapshot = presenters.playerSnapshot(context.user)
  let resultState = ''
  await context.db.runTransaction(async (transaction) => {
    const matchRef = transaction.collection(COLLECTIONS.matches).doc(matchId)
    const match = await getDocument(matchRef)
    assert(match, 'NOT_FOUND', '球局不存在或已被删除')
    assert(activeMatch(match), 'MATCH_CLOSED', '球局已结束或停止招募')
    assert(match.hostId !== context.openid, 'ALREADY_JOINED', '你是该球局的发起人')
    assert(Number(match.capacity || 0) > 1, 'MATCH_CLOSED', '单人练习不开放加入')
    await assertNotBlockedInTransaction(context, transaction, match.hostId, '无法加入该球局')
    const memberRef = transaction.collection(COLLECTIONS.matchMembers).doc(memberDocumentId(matchId, context.openid))
    const member = await getDocument(memberRef)
    if (member && member.requestId === context.requestId) {
      resultState = member.status
      return
    }
    if (member && ['joined', 'pending', 'waitlisted'].includes(member.status)) {
      resultState = member.status
      return
    }
    assert(expectedScheduleVersion === null || expectedScheduleVersion === Number(match.scheduleVersion || 1),
      'ARRANGEMENT_CHANGED', '球局时间或球馆已调整')
    assert(expectedFeePerPerson === null || expectedFeePerPerson === Number(match.feePerPerson || 0),
      'ARRANGEMENT_CHANGED', '球局费用已调整')
    const full = Number(match.participantCount || 0) >= Number(match.capacity || 0)
    if (full) {
      assert(allowWaitlist, 'MATCH_FULL', '球局已满，可选择加入候补')
      resultState = 'waitlisted'
    } else {
      resultState = match.joinMode === 'confirm' ? 'pending' : 'joined'
    }
    const memberData = {
      matchId,
      userId: context.openid,
      status: resultState,
      playerSnapshot: snapshot,
      confirmedScheduleVersion: resultState === 'joined' ? Number(match.scheduleVersion || 1) : 0,
      requestId: context.requestId,
      termsVersion,
      termsAcceptedAt: context.serverDate(),
      createdAt: member && member.createdAt || context.serverDate(),
      updatedAt: context.serverDate()
    }
    await memberRef.set({ data: memberData })
    if (resultState === 'joined') {
      await friends.linkJoinedPlayer(context, transaction, match, context.openid)
      const participantCount = Number(match.participantCount || 0) + 1
      await matchRef.update({ data: {
        participantCount,
        participants: (match.participants || []).concat([snapshot]),
        participantIds: (match.participantIds || []).concat([context.openid]),
        status: participantCount >= Number(match.capacity) ? 'full' : match.status,
        version: Number(match.version || 0) + 1,
        updatedAt: context.serverDate()
      } })
    } else if (resultState === 'waitlisted') {
      await matchRef.update({ data: { waitlistCount: Number(match.waitlistCount || 0) + 1, updatedAt: context.serverDate() } })
    }
  })
  const match = await requireMatch(context, matchId)
  await writeAudit(context, 'matches.join', 'match', matchId, { state: resultState })
  return { match: presentMatch(match), membership: { status: resultState, canChat: resultState === 'joined' } }
}

async function pending(context, payload) {
  const matchId = validate.id(payload.matchId, '球局 ID')
  const match = await requireMatch(context, matchId)
  assert(match.hostId === context.openid, 'FORBIDDEN', '仅发起人可查看加入申请')
  const result = await context.db.collection(COLLECTIONS.matchMembers)
    .where({ matchId, status: context.command.in(['pending', 'waitlisted']) })
    .orderBy('createdAt', 'asc')
    .limit(50)
    .get()
  return {
    items: result.data.map((item) => ({
      membershipId: item._id,
      status: item.status,
      player: presenters.player(item.playerSnapshot),
      createdAt: item.createdAt
    }))
  }
}

async function respondJoin(context, payload) {
  const matchId = validate.id(payload.matchId, '球局 ID')
  const membershipId = validate.id(payload.membershipId, '申请 ID')
  const decision = validate.oneOf(payload.decision, ['accept', 'reject'], '处理结果')
  const expectedVersion = validate.integer(payload.expectedVersion, '球局版本', { min: 1 })
  let nextState = ''
  await context.db.runTransaction(async (transaction) => {
    const matchRef = transaction.collection(COLLECTIONS.matches).doc(matchId)
    const match = await getDocument(matchRef)
    assert(match, 'NOT_FOUND', '球局不存在')
    assert(match.hostId === context.openid, 'FORBIDDEN', '仅发起人可处理申请')
    const memberRef = transaction.collection(COLLECTIONS.matchMembers).doc(membershipId)
    const member = await getDocument(memberRef)
    if (member && member.matchId === matchId && member.reviewRequestId === context.requestId) {
      nextState = member.status
      return
    }
    assert(member && member.matchId === matchId && ['pending', 'waitlisted'].includes(member.status), 'NOT_FOUND', '申请已处理或不存在')
    await assertNotBlockedInTransaction(context, transaction, member.userId, '无法接受该用户的申请')
    sameVersion(match, expectedVersion)
    assert(activeMatch(match), 'MATCH_CLOSED', '球局已停止招募')
    if (decision === 'reject') {
      nextState = 'rejected'
      await memberRef.update({ data: { status: nextState, reviewRequestId: context.requestId, updatedAt: context.serverDate(), reviewedAt: context.serverDate() } })
      if (member.status === 'waitlisted') {
        await matchRef.update({ data: { waitlistCount: Math.max(0, Number(match.waitlistCount || 0) - 1), version: expectedVersion + 1, updatedAt: context.serverDate() } })
      } else {
        await matchRef.update({ data: { version: expectedVersion + 1, updatedAt: context.serverDate() } })
      }
      return
    }
    assert(Number(match.participantCount || 0) < Number(match.capacity || 0), 'MATCH_FULL', '球局名额已满')
    nextState = 'joined'
    await friends.linkJoinedPlayer(context, transaction, match, member.userId)
    const participantCount = Number(match.participantCount || 0) + 1
    await memberRef.update({ data: {
      status: nextState,
      reviewRequestId: context.requestId,
      confirmedScheduleVersion: Number(match.scheduleVersion || 1),
      updatedAt: context.serverDate(),
      reviewedAt: context.serverDate()
    } })
    await matchRef.update({ data: {
      participantCount,
      participants: (match.participants || []).concat([member.playerSnapshot]),
      participantIds: (match.participantIds || []).concat([member.userId]),
      waitlistCount: member.status === 'waitlisted' ? Math.max(0, Number(match.waitlistCount || 0) - 1) : Number(match.waitlistCount || 0),
      status: participantCount >= Number(match.capacity) ? 'full' : match.status,
      version: expectedVersion + 1,
      updatedAt: context.serverDate()
    } })
  })
  await writeAudit(context, 'matches.respondJoin', 'match', matchId, { membershipId, decision })
  return { match: presentMatch(await requireMatch(context, matchId)), membershipId, status: nextState }
}

async function cancel(context, payload) {
  const matchId = validate.id(payload.matchId, '球局 ID')
  const expectedVersion = validate.integer(payload.expectedVersion, '球局版本', { min: 1 })
  const reason = validate.text(payload.reason, '取消原因', { min: 2, max: 120 })
  await checkText(context, [reason], 2)
  let cancelledAs = ''
  await context.db.runTransaction(async (transaction) => {
    const matchRef = transaction.collection(COLLECTIONS.matches).doc(matchId)
    const match = await getDocument(matchRef)
    assert(match, 'NOT_FOUND', '球局不存在')
    const memberRef = transaction.collection(COLLECTIONS.matchMembers).doc(memberDocumentId(matchId, context.openid))
    const member = await getDocument(memberRef)
    assert(member, 'FORBIDDEN', '你不在该球局中')
    if (match.status === 'cancelled' && match.cancellationRequestId === context.requestId) {
      cancelledAs = 'host'
      return
    }
    if (member.status === 'cancelled' && member.cancellationRequestId === context.requestId) {
      cancelledAs = match.hostId === context.openid ? 'host' : 'member'
      return
    }
    assert(activeMatch(match), 'MATCH_CLOSED', '球局已开始或结束，无法取消')
    sameVersion(match, expectedVersion)
    if (match.hostId === context.openid) {
      cancelledAs = 'host'
      if (match.status !== 'cancelled') {
        await matchRef.update({ data: {
          status: 'cancelled',
          cancelledBy: context.openid,
          cancellationReason: reason,
          cancellationRequestId: context.requestId,
          cancelledAt: context.serverDate(),
          version: expectedVersion + 1,
          updatedAt: context.serverDate()
        } })
      }
      await memberRef.update({ data: { status: 'cancelled', wasAccepted: true, cancellationRequestId: context.requestId, updatedAt: context.serverDate() } })
      return
    }
    assert(['joined', 'pending', 'waitlisted'].includes(member.status), 'MATCH_CLOSED', '当前状态无法取消')
    cancelledAs = 'member'
    await memberRef.update({ data: { status: 'cancelled', wasAccepted: member.status === 'joined', cancellationReason: reason, cancellationRequestId: context.requestId, cancelledAt: context.serverDate(), updatedAt: context.serverDate() } })
    const patch = { version: expectedVersion + 1, updatedAt: context.serverDate() }
    if (member.status === 'joined') {
      const participantIds = (match.participantIds || []).filter((id) => id !== context.openid)
      patch.participantIds = participantIds
      patch.participants = (match.participants || []).filter((_, index) => (match.participantIds || [])[index] !== context.openid)
      patch.participantCount = Math.max(1, Number(match.participantCount || 1) - 1)
      if (match.status === 'full') patch.status = 'recruiting'
    }
    if (member.status === 'waitlisted') patch.waitlistCount = Math.max(0, Number(match.waitlistCount || 0) - 1)
    await matchRef.update({ data: patch })
  })
  await writeAudit(context, 'matches.cancel', 'match', matchId, { cancelledAs })
  return { match: presentMatch(await requireMatch(context, matchId)), membership: { status: 'cancelled' } }
}

async function reschedule(context, payload) {
  const matchId = validate.id(payload.matchId, '球局 ID')
  const expectedVersion = validate.integer(payload.expectedVersion, '球局版本', { min: 1 })
  const schedule = validate.schedule(payload.date, payload.startTime || payload.time, payload.endTime)
  await context.db.runTransaction(async (transaction) => {
    const ref = transaction.collection(COLLECTIONS.matches).doc(matchId)
    const match = await getDocument(ref)
    assert(match, 'NOT_FOUND', '球局不存在')
    assert(match.hostId === context.openid, 'FORBIDDEN', '仅发起人可调整时间')
    if (match.lastRescheduleRequestId === context.requestId) return
    assert(activeMatch(match), 'MATCH_CLOSED', '球局已开始或结束，无法改期')
    sameVersion(match, expectedVersion)
    await ref.update({ data: {
      date: schedule.date,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      status: 'changed',
      scheduleVersion: Number(match.scheduleVersion || 1) + 1,
      lastRescheduleRequestId: context.requestId,
      version: expectedVersion + 1,
      updatedAt: context.serverDate()
    } })
  })
  await writeAudit(context, 'matches.reschedule', 'match', matchId, { startAt: schedule.startAt })
  return { match: presentMatch(await requireMatch(context, matchId)) }
}

function updateSchedule(payload, current) {
  const date = validate.date(payload.date)
  const startTime = validate.time(payload.startTime || payload.time, '开始时间')
  const endTime = validate.time(payload.endTime, '结束时间')
  const startAt = new Date(`${date}T${startTime}:00+08:00`)
  const endAt = new Date(`${date}T${endTime}:00+08:00`)
  const duration = endAt.getTime() - startAt.getTime()
  assert(duration > 0, 'INVALID_ARGUMENT', '结束时间必须晚于开始时间')
  assert(duration >= 30 * 60 * 1000, 'INVALID_ARGUMENT', '球局时长至少需要 30 分钟')
  assert(duration <= 6 * 60 * 60 * 1000, 'INVALID_ARGUMENT', '单场球局不能超过 6 小时')
  const changed = current.date !== date || current.startTime !== startTime || current.endTime !== endTime
  // Editing text shortly before an existing match is allowed. A newly selected
  // schedule still keeps the same ten-minute preparation window as publishing.
  if (changed) {
    assert(startAt.getTime() >= Date.now() + 10 * 60 * 1000, 'INVALID_ARGUMENT', '新的开始时间至少应晚于当前时间 10 分钟')
  }
  return { date, startTime, endTime, startAt, endAt, changed }
}

function updateFingerprint(intent) {
  return JSON.stringify(intent)
}

function sameUpdateValues(match, intent) {
  return Object.keys(intent).every((field) => {
    const current = match[field]
    const next = intent[field]
    if (typeof next === 'number') return Number(current || 0) === next
    return String(current || '') === next
  })
}

function venueSnapshot(venue, venueId) {
  const nameOnly = venue.listingMode === 'name_only'
  return {
    id: venueId,
    name: venue.name,
    address: nameOnly ? '' : venue.address || '',
    location: nameOnly ? null : venue.location || null,
    listingMode: nameOnly ? 'name_only' : (venue.listingMode === 'address_only' ? 'address_only' : 'full')
  }
}

function structuredMatchTitle(venueName, practiceIntent) {
  const suffix = ` · ${practiceIntent}`
  const available = Math.max(1, 30 - suffix.length)
  return `${String(venueName || '乒乓球馆').trim().slice(0, available)}${suffix}`
}

async function update(context, payload) {
  const district = requestedDistrict(payload)
  const matchId = validate.id(payload.matchId, '球局 ID')
  const expectedVersion = validate.integer(payload.expectedVersion, '球局版本', { min: 1 })
  const requestId = validate.id(context.requestId, '请求 ID')
  const venueId = validate.id(payload.venueId, '球馆 ID')
  const capacity = validate.integer(payload.capacity, '总人数', { min: 1, max: 8 })
  const feePerPerson = validate.integer(payload.feePerPerson === undefined ? payload.fee || 0 : payload.feePerPerson, '人均费用', { min: 0, max: 999 })
  const expectedBallAge = validate.text(payload.expectedBallAge || '不限球龄', '球龄要求', { max: 30 })
  const practiceIntent = validate.oneOf(payload.practiceIntent, matchOptions.PRACTICE_INTENTS, '想练什么')
  const joinMode = capacity === 1 ? 'direct' : validate.oneOf(payload.joinMode || 'direct', ['direct', 'confirm'], '加入方式')
  const requestedCourtStatus = validate.oneOf(payload.courtStatus || 'unbooked', ['booked', 'unbooked'], '球台预订状态')

  const current = await requireMatch(context, matchId)
  assert(current.hostId === context.openid, 'FORBIDDEN', '仅发起人可修改球局')
  const title = Object.prototype.hasOwnProperty.call(payload, 'title')
    ? validate.text(payload.title, '球局名称', { min: 2, max: 30 })
    : String(current.title || structuredMatchTitle(current.venueSnapshot && current.venueSnapshot.name, practiceIntent)).slice(0, 30)
  const note = Object.prototype.hasOwnProperty.call(payload, 'note')
    ? validate.text(payload.note || '', '补充说明', { required: false, max: 300 })
    : String(current.note || '')
  const courtBookingNote = Object.prototype.hasOwnProperty.call(payload, 'courtBookingNote')
    ? validate.text(payload.courtBookingNote || '', '球台说明', { required: false, max: 120 })
    : String(current.courtBookingNote || '')
  const schedule = updateSchedule(payload, current)
  const submittedIntent = {
    title,
    venueId,
    date: schedule.date,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    capacity,
    expectedBallAge,
    practiceIntent,
    feePerPerson,
    note,
    courtBookingNote,
    courtStatus: requestedCourtStatus,
    joinMode
  }
  // Omit the new field for old clients so their retry fingerprints stay valid.
  if (district !== undefined) submittedIntent.district = district
  const fingerprint = updateFingerprint(submittedIntent)

  if (current.lastUpdateRequestId === requestId) {
    assert(current.lastUpdateFingerprint === fingerprint && Number(current.version || 1) === expectedVersion + 1,
      'IDEMPOTENCY_CONFLICT', '请求 ID 已用于不同的球局修改，请刷新后重新提交', {
        currentVersion: Number(current.version || 1)
      })
    return { match: presentMatch(current), idempotent: true, noop: false }
  }
  assert(activeMatch(current), 'MATCH_CLOSED', '球局已开始或结束，无法修改')
  assert(capacity >= Number(current.participantCount || 1), 'INVALID_ARGUMENT', `当前已有 ${Number(current.participantCount || 1)} 人，不能把总人数调得更少`)
  await checkText(context, [title, expectedBallAge, note, courtBookingNote, practiceIntent], 2)

  let noop = false
  let idempotent = false
  let arrangementChanged = false
  await context.db.runTransaction(async (transaction) => {
    const ref = transaction.collection(COLLECTIONS.matches).doc(matchId)
    const match = await getDocument(ref)
    assert(match, 'NOT_FOUND', '球局不存在')
    assert(match.hostId === context.openid, 'FORBIDDEN', '仅发起人可修改球局')
    if (match.lastUpdateRequestId === requestId) {
      assert(match.lastUpdateFingerprint === fingerprint && Number(match.version || 1) === expectedVersion + 1,
        'IDEMPOTENCY_CONFLICT', '请求 ID 已用于不同的球局修改，请刷新后重新提交', {
          currentVersion: Number(match.version || 1)
        })
      idempotent = true
      return
    }
    assert(activeMatch(match), 'MATCH_CLOSED', '球局已开始或结束，无法修改')
    sameVersion(match, expectedVersion)
    assert(capacity >= Number(match.participantCount || 1), 'INVALID_ARGUMENT', `当前已有 ${Number(match.participantCount || 1)} 人，不能把总人数调得更少`)

    const scheduleChanged = match.date !== schedule.date || match.startTime !== schedule.startTime || match.endTime !== schedule.endTime
    const venueChanged = match.venueId !== venueId
    arrangementChanged = scheduleChanged || venueChanged
    const courtStatus = arrangementChanged ? 'unbooked' : requestedCourtStatus
    const venue = await getDocument(transaction.collection(COLLECTIONS.venues).doc(venueId))
    const selectableVenue = venue && venue.active && venue.verificationStatus === 'verified'
    // An existing venue may be taken offline after publication. Keeping that
    // same snapshot must not block editing the title or capacity, but moving to
    // a different venue always requires a currently available catalog entry.
    assert(selectableVenue || (!venueChanged && match.venueSnapshot && match.venueSnapshot.id === venueId),
      'NOT_FOUND', '球馆不存在或暂未开放，请选择其他球馆')
    const nextVenueSnapshot = selectableVenue ? venueSnapshot(venue, venueId) : match.venueSnapshot
    const nextDistrict = (selectableVenue && venue.district) ||
      (district !== undefined ? district : venueChanged ? '' : match.district || '')
    const intent = Object.assign({}, submittedIntent, {
      district: nextDistrict,
      courtStatus,
      courtBookingNote,
      note
    })
    if (sameUpdateValues(match, intent)) {
      noop = true
      return
    }
    const nextScheduleVersion = Number(match.scheduleVersion || 1) + (arrangementChanged ? 1 : 0)
    const nextStatus = arrangementChanged
      ? 'changed'
      : match.status === 'changed' ? 'changed' : capacity <= Number(match.participantCount || 1) ? 'full' : 'recruiting'
    await ref.update({ data: {
      title,
      city: selectableVenue ? venue.city : match.city,
      district: nextDistrict,
      venueId,
      venueSnapshot: nextVenueSnapshot,
      date: schedule.date,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      capacity,
      expectedBallAge,
      practiceIntent,
      feePerPerson,
      courtStatus,
      courtBookingNote,
      note,
      joinMode,
      status: nextStatus,
      scheduleVersion: nextScheduleVersion,
      lastUpdateRequestId: requestId,
      lastUpdateFingerprint: fingerprint,
      version: expectedVersion + 1,
      updatedAt: context.serverDate()
    } })
    if (arrangementChanged) {
      await transaction.collection(COLLECTIONS.matchMembers)
        .doc(memberDocumentId(matchId, context.openid))
        .update({ data: { confirmedScheduleVersion: nextScheduleVersion, updatedAt: context.serverDate() } })
    }
  })

  const updated = await requireMatch(context, matchId)
  if (idempotent) return { match: presentMatch(updated), idempotent: true, noop: false }
  if (noop) return { match: presentMatch(updated), idempotent: false, noop: true }
  await writeAudit(context, 'matches.update', 'match', matchId, { venueId, arrangementChanged, capacity })
  return { match: presentMatch(updated), idempotent: false, noop: false }
}

async function confirmSchedule(context, payload) {
  const matchId = validate.id(payload.matchId, '球局 ID')
  const match = await requireMatch(context, matchId)
  assert(activeMatch(match), 'MATCH_CLOSED', '球局已开始或结束，无法确认时间')
  const member = await getMembership(context, matchId, context.openid)
  assert(member && ['host', 'joined'].includes(member.status), 'FORBIDDEN', '仅球局成员可确认时间')
  await context.db.collection(COLLECTIONS.matchMembers).doc(memberDocumentId(matchId, context.openid)).update({
    data: { confirmedScheduleVersion: Number(match.scheduleVersion || 1), updatedAt: context.serverDate() }
  })
  await writeAudit(context, 'matches.confirmSchedule', 'match', matchId, { scheduleVersion: Number(match.scheduleVersion || 1) })
  return { matchId, confirmedScheduleVersion: Number(match.scheduleVersion || 1) }
}

module.exports = { list, get, create, update, join, pending, respondJoin, cancel, reschedule, confirmSchedule }
