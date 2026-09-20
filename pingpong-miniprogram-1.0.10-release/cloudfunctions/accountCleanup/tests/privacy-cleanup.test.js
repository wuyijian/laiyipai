const assert = require('assert')
const Module = require('module')

function createDatabase(seed) {
  const stores = new Map(Object.entries(seed).map(([name, records]) => [
    name,
    new Map(records.map((record) => [record._id, Object.assign({}, record)]))
  ]))
  let timestamp = 0

  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map())
    return stores.get(name)
  }

  function document(name, id) {
    return {
      async get() {
        const value = store(name).get(id)
        return { data: value ? Object.assign({}, value) : null }
      },
      async update({ data }) {
        const current = store(name).get(id) || { _id: id }
        store(name).set(id, Object.assign({}, current, data))
      },
      async remove() { store(name).delete(id) }
    }
  }

  function collection(name) {
    return {
      doc(id) { return document(name, id) },
      where(condition) {
        const query = {
          orderBy() { return query },
          limit(limit) {
            return {
              async get() {
                const data = Array.from(store(name).values())
                  .filter((record) => Object.entries(condition).every(([key, value]) => record[key] === value))
                  .slice(0, limit)
                  .map((record) => Object.assign({}, record))
                return { data }
              }
            }
          }
        }
        return query
      }
    }
  }

  return {
    collection,
    async runTransaction(callback) { return callback({ collection }) },
    serverDate() { timestamp += 1; return `server-date-${timestamp}` },
    record(name, id) { return store(name).get(id) }
  }
}

async function run() {
  const now = Date.now()
  const userId = 'openid_coach_and_player'
  const db = createDatabase({
    coach_bookings: [
      {
        _id: 'future_booking', userId, slotId: 'future_slot', status: 'confirmed',
        startAt: new Date(now + 60 * 60 * 1000), version: 3, cancellationReason: '', cancelledAt: null,
        userSnapshot: { playerId: 'public_player', displayName: '待注销用户', avatarFileId: 'cloud://avatar.jpg' }
      },
      {
        _id: 'historical_booking', userId, slotId: 'historical_slot', status: 'confirmed',
        startAt: new Date(now - 60 * 60 * 1000), version: 5, cancellationReason: '', cancelledAt: null,
        userSnapshot: { playerId: 'public_player', displayName: '待注销用户', avatarFileId: 'cloud://avatar.jpg' }
      }
    ],
    coach_slots: [
      { _id: 'future_slot', bookedCount: 2, capacity: 2, status: 'full', version: 4 },
      { _id: 'historical_slot', bookedCount: 1, capacity: 1, status: 'full', version: 7 }
    ],
    coach_applications: [
      {
        _id: 'owned_reviewing', userId, openid: userId, publicId: 'public_player', realName: '真实姓名', mobile: '13800000000',
        avatarFileId: 'cloud://avatar.jpg', city: '杭州', district: '西湖区', experienceYears: 8,
        specialty: ['正手攻球'], venueName: '测试球馆', introduction: '包含个人经历', qualification: '证书编号',
        status: 'reviewing', reviewReason: '', reviewedBy: '', requestId: 'submit-request', reviewRequestId: '', version: 2
      },
      {
        _id: 'owned_approved_legacy_duplicate', userId, publicId: 'public_player', realName: '真实姓名', mobile: '13800000000',
        avatarFileId: 'cloud://avatar.jpg', city: '杭州', district: '西湖区', experienceYears: 8,
        specialty: ['反手拧拉'], venueName: '测试球馆', introduction: '公开介绍', qualification: '认证资历',
        status: 'approved', coachId: 'owned_coach', reviewReason: '', reviewedBy: 'admin_openid',
        requestId: 'submit-request-2', reviewRequestId: 'review-request', version: 4
      },
      {
        _id: 'reviewed_by_deleting_user', userId: 'another_openid', publicId: 'another_player', realName: '其他申请人',
        mobile: '13900000000', status: 'approved', coachId: 'other_coach', reviewedBy: userId, version: 6
      }
    ],
    coaches: [
      {
        _id: 'owned_coach', userId, openid: userId, applicationId: 'owned_approved_legacy_duplicate', name: '真实教练名',
        avatarFileId: 'cloud://coach-avatar.jpg', city: '杭州', district: '西湖区', venueIds: ['venue_1'],
        specialty: ['反手拧拉'], introduction: '个人介绍', experienceYears: 8, qualification: '认证资历',
        verificationStatus: 'verified', verificationDate: '2030-01-01', verificationReference: 'private-record', active: true
      },
      { _id: 'other_coach', userId: 'another_openid', name: '其他教练', verificationStatus: 'verified', active: true }
    ],
    player_updates: [
      {
        _id: 'owned_player_update', userId, active: true, district: '滨江区',
        authorSnapshot: { playerId: 'public_player', displayName: '待注销用户' }
      },
      {
        _id: 'other_player_update', userId: 'another_openid', active: true, district: '上城区',
        authorSnapshot: { playerId: 'another_player', displayName: '其他用户' }
      }
    ],
    message_inboxes: [
      { _id: 'owned_inbox', userId, matchId: 'match_1', lastMessageId: 'message_1', unread: true, unreadCount: 2 },
      { _id: 'other_inbox', userId: 'another_openid', matchId: 'match_1', lastMessageId: 'message_1', unread: true, unreadCount: 1 }
    ],
    account_deletion_jobs: [
      { _id: 'cleanup_job', userId, openid: userId, status: 'pending', attempts: 0 },
      { _id: 'legacy_completed_job', openid: userId, status: 'completed', attempts: 2 }
    ]
  })
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    database() { return db },
    async deleteFile() { throw new Error('没有媒体时不应调用 deleteFile') }
  }
  const originalLoad = Module._load
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud
    return originalLoad.call(this, request, parent, isMain)
  }
  let cleanup
  try {
    cleanup = require('../index')
  } finally {
    Module._load = originalLoad
  }

  await cleanup._private.cleanJob(db.record('account_deletion_jobs', 'cleanup_job'))
  const reference = cleanup._private.deletedReference(userId)
  assert.strictEqual(cleanup._private.deletedReference(reference), reference, '删除引用必须是幂等的')

  const futureBooking = db.record('coach_bookings', 'future_booking')
  assert.strictEqual(futureBooking.userId, reference)
  assert.strictEqual(futureBooking.status, 'cancelled')
  assert.strictEqual(futureBooking.cancellationReason, '用户已注销账号')
  assert(futureBooking.cancelledAt)
  assert.deepStrictEqual(futureBooking.userSnapshot, {
    playerId: reference, displayName: '已注销用户', avatarFileId: '', ballAge: '', skills: []
  })
  assert.strictEqual(db.record('coach_slots', 'future_slot').bookedCount, 1)
  assert.strictEqual(db.record('coach_slots', 'future_slot').status, 'open')

  const historicalBooking = db.record('coach_bookings', 'historical_booking')
  assert.strictEqual(historicalBooking.userId, reference)
  assert.strictEqual(historicalBooking.status, 'confirmed', '已发生的预约必须保留历史状态')
  assert.strictEqual(historicalBooking.cancellationReason, '')
  assert.strictEqual(historicalBooking.cancelledAt, null)
  assert.strictEqual(db.record('coach_slots', 'historical_slot').bookedCount, 1, '历史时段库存不得回退')
  assert.strictEqual(db.record('coach_slots', 'historical_slot').status, 'full')

  const reviewing = db.record('coach_applications', 'owned_reviewing')
  assert.strictEqual(reviewing.userId, reference)
  assert.strictEqual(reviewing.openid, reference)
  assert.strictEqual(reviewing.publicId, reference)
  assert.strictEqual(reviewing.status, 'rejected')
  assert.strictEqual(reviewing.reviewReason, '申请人已注销账号')
  assert.strictEqual(reviewing.realName, '已注销用户')
  assert.strictEqual(reviewing.mobile, '')
  assert.strictEqual(reviewing.avatarFileId, '')
  assert.deepStrictEqual(reviewing.specialty, [])
  assert.strictEqual(reviewing.qualification, '')
  assert.strictEqual(reviewing.requestId, '')

  const approved = db.record('coach_applications', 'owned_approved_legacy_duplicate')
  assert.strictEqual(approved.userId, reference)
  assert.strictEqual(approved.status, 'approved', '既有审核结论必须保留')
  assert.strictEqual(approved.coachId, 'owned_coach')
  assert.strictEqual(approved.realName, '已注销用户')
  assert.strictEqual(approved.mobile, '')
  assert.strictEqual(approved.reviewedBy, 'admin_openid')

  const reviewed = db.record('coach_applications', 'reviewed_by_deleting_user')
  assert.strictEqual(reviewed.userId, 'another_openid')
  assert.strictEqual(reviewed.realName, '其他申请人')
  assert.strictEqual(reviewed.reviewedBy, reference)
  assert(reviewed.reviewerAnonymizedAt)

  const coach = db.record('coaches', 'owned_coach')
  assert.strictEqual(coach.userId, reference)
  assert.strictEqual(coach.openid, reference)
  assert.strictEqual(coach.active, false)
  assert.strictEqual(coach.verificationStatus, 'rejected')
  assert.strictEqual(coach.name, '已注销教练')
  assert.strictEqual(coach.avatarFileId, '')
  assert.deepStrictEqual(coach.venueIds, [])
  assert.deepStrictEqual(coach.specialty, [])
  assert.strictEqual(coach.introduction, '')
  assert.strictEqual(coach.qualification, '')
  assert.strictEqual(coach.verificationReference, '')
  assert.strictEqual(db.record('coaches', 'other_coach').active, true)
  assert.strictEqual(db.record('player_updates', 'owned_player_update'), undefined, '注销时必须删除本人可约动态')
  assert(db.record('player_updates', 'other_player_update'), '不得删除其他用户动态')
  assert.strictEqual(db.record('message_inboxes', 'owned_inbox'), undefined, '注销时必须删除本人消息未读状态')
  assert(db.record('message_inboxes', 'other_inbox'), '不得删除其他用户消息未读状态')

  const job = db.record('account_deletion_jobs', 'cleanup_job')
  assert.strictEqual(job.status, 'completed')
  assert.strictEqual(job.userId, reference)
  assert.strictEqual(job.openid, reference)
  assert.strictEqual(job.attempts, 1)
  assert.strictEqual(JSON.stringify(job).includes(userId), false, '完成任务不得保留原始 userId/openid')

  const versionsBeforeRetry = {
    futureBooking: futureBooking.version,
    application: approved.version
  }
  await cleanup._private.cleanJob(job)
  assert.strictEqual(db.record('account_deletion_jobs', 'cleanup_job').userId, reference)
  assert.strictEqual(db.record('account_deletion_jobs', 'cleanup_job').attempts, 1)
  assert.strictEqual(db.record('coach_bookings', 'future_booking').version, versionsBeforeRetry.futureBooking)
  assert.strictEqual(db.record('coach_applications', 'owned_approved_legacy_duplicate').version, versionsBeforeRetry.application)

  const legacyCompleted = db.record('account_deletion_jobs', 'legacy_completed_job')
  await cleanup._private.cleanJob(legacyCompleted)
  const sanitizedLegacyCompleted = db.record('account_deletion_jobs', 'legacy_completed_job')
  assert.strictEqual(sanitizedLegacyCompleted.userId, reference)
  assert.strictEqual(sanitizedLegacyCompleted.openid, reference)
  assert.strictEqual(sanitizedLegacyCompleted.attempts, 2)

  console.log('account-cleanup-privacy-tests-ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
