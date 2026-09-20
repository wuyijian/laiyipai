const assert = require('assert')
const entry = require('../lib/venue-entry')
const venues = require('../lib/venues')
const matches = require('../lib/matches')
const terms = require('../lib/terms')
const rateLimit = require('../lib/rate-limit')

function database() {
  const stores = Object.fromEntries([
    'users', 'venues', 'venue_submissions', 'matches', 'match_members', 'audit_logs'
  ].map((name) => [name, new Map()]))
  let sequence = 0
  let transactionTail = Promise.resolve()
  function collection(name) {
    const store = stores[name]
    assert(store, `unexpected collection ${name}`)
    return {
      doc(id) {
        return {
          async get() { return { data: store.get(id) || null } },
          async set({ data }) {
            const hook = api.beforeNextSet
            if (hook) {
              api.beforeNextSet = null
              await hook({ collection: name, id, data })
            }
            store.set(id, Object.assign({ _id: id }, data))
          },
          async update({ data }) {
            const current = store.get(id)
            if (!current) throw new Error(`missing document ${name}/${id}`)
            store.set(id, Object.assign({}, current, data))
          }
        }
      },
      async add({ data }) {
        const id = `audit_${++sequence}`
        store.set(id, Object.assign({ _id: id }, data))
        return { _id: id }
      },
      where(condition) {
        let count = 100
        let offset = 0
        let order = null
        return {
          orderBy(field, direction) { order = { field, direction }; return this },
          skip(value) { offset = value; return this },
          limit(value) { count = value; return this },
          async get() {
            let data = Array.from(store.values()).filter((item) => Object.keys(condition).every((key) => item[key] === condition[key]))
            if (order) data.sort((a, b) => String(a[order.field] || '').localeCompare(String(b[order.field] || '')) * (order.direction === 'desc' ? -1 : 1))
            return { data: data.slice(offset, offset + count) }
          }
        }
      }
    }
  }
  const api = {
    stores,
    collection,
    beforeNextTransaction: null,
    beforeNextSet: null,
    runTransaction(work) {
      const hook = api.beforeNextTransaction
      api.beforeNextTransaction = null
      const result = transactionTail.then(async () => {
        if (hook) await hook()
        return work({ collection })
      })
      transactionTail = result.catch(() => {})
      return result
    }
  }
  return api
}

function context(db, openid = 'player_1', overrides = {}) {
  const value = Object.assign({
    db,
    openid,
    requestId: `request_${openid}_0001`,
    user: {
      publicId: `public_${openid}`,
      role: 'player',
      profile: { nickname: `球友${openid}` }
    },
    cloud: { openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } } },
    serverDate: () => new Date('2026-09-06T08:00:00Z')
  }, overrides)
  if (!db.stores.users.has(openid)) {
    db.stores.users.set(openid, {
      _id: openid,
      status: 'active',
      role: value.user && value.user.role || 'player',
      publicId: value.user && value.user.publicId || ''
    })
  }
  return value
}

const payload = (patch = {}) => Object.assign({ name: '新球馆', activityTags: ['训练', '切磋'], confirmPublic: true }, patch)
function seedLegacySubmission(db, openid, patch = {}) {
  const owner = context(db, openid)
  const name = entry.normalizedName(patch.name || '历史待审球馆')
  const city = '杭州'
  const key = entry.nameKey(name)
  const submissionId = entry._private.submissionIdFor(openid, city, key)
  const now = owner.serverDate()
  const document = Object.assign({
    _id: submissionId,
    userId: openid,
    submitterSnapshot: { playerId: owner.user.publicId, displayName: owner.user.profile.nickname },
    targetVenueId: entry._private.venueIdFor(city, key),
    venueId: '',
    name,
    nameKey: key,
    city,
    activityTags: ['训练', '切磋'],
    status: 'reviewing',
    reviewReason: '',
    reviewedBy: '',
    reviewedAt: null,
    reviewRequestId: '',
    requestId: `legacy_${openid}_request`,
    version: 1,
    submittedAt: now,
    createdAt: now,
    updatedAt: now
  }, patch)
  db.stores.venue_submissions.set(submissionId, document)
  return { context: owner, document, submission: entry.presentSubmission(document) }
}
async function rejectsCode(work, code) { await assert.rejects(work, (error) => error.code === code) }
async function captureError(work, code) {
  try {
    await work()
    assert.fail(`expected ${code}`)
  } catch (error) {
    assert.strictEqual(error.code, code)
    return error
  }
}

async function run() {
  assert.strictEqual(rateLimit._private.groupFor('venues.create'), 'publish')
  assert.strictEqual(rateLimit._private.groupFor('venues.submissions.resubmit'), 'publish')
  assert.strictEqual(rateLimit._private.groupFor('admin.venueSubmissions.get'), 'read')

  const db = database()
  const applicant = context(db)
  const submitted = await entry.create(applicant, payload({
    city: '上海', address: '私人地址', location: { latitude: 1, longitude: 2 },
    listingMode: 'full', active: true, verificationStatus: 'verified', status: 'approved', userId: 'forged'
  }))
  assert.strictEqual(submitted.created, true)
  assert.strictEqual(submitted.venueCreated, true)
  assert.strictEqual(submitted.duplicateExisting, false)
  assert.strictEqual(submitted.venue.id, submitted.submission.venueId)
  assert.strictEqual(submitted.submission.status, 'approved')
  assert.strictEqual(submitted.submission.city, '杭州')
  assert.strictEqual(db.stores.venues.size, 1)
  const stored = db.stores.venue_submissions.get(submitted.submission.id)
  assert.strictEqual(stored.userId, 'player_1')
  assert.strictEqual(stored.status, 'approved')
  assert.strictEqual(stored.publicationMode, 'instant')
  assert.strictEqual(stored.venueId, submitted.venue.id)
  assert.strictEqual(stored.address, undefined)
  assert.strictEqual(stored.active, undefined)
  assert.strictEqual(stored.verificationStatus, undefined)
  assert.strictEqual(submitted.submission.userId, undefined)
  assert.strictEqual(submitted.submission.submitter, undefined)
  assert.strictEqual(db.stores.audit_logs.size, 1)
  assert.strictEqual((await venues.get(applicant, { venueId: stored.targetVenueId })).id, submitted.venue.id)
  const immediateMatch = await matches.create(applicant, {
    title: '一起练球', venueId: stored.targetVenueId, date: '2099-09-12', startTime: '19:00', endTime: '21:00', capacity: 2,
    termsAccepted: true, termsVersion: terms.currentVersion()
  })
  assert.strictEqual(immediateMatch.match.venueId, submitted.venue.id)
  console.log('PASS 普通用户录入后立即公开可用，且不能伪造目录字段')

  const invalidDB = database()
  for (const patch of [{ name: '' }, { name: '球' }, { name: '馆'.repeat(61) }, { activityTags: ['广告'] }, { activityTags: '训练' }]) {
    await rejectsCode(() => entry.create(context(invalidDB), payload(patch)), 'INVALID_ARGUMENT')
  }
  await rejectsCode(() => entry.create(context(invalidDB), payload({ confirmPublic: false })), 'PUBLIC_CONFIRMATION_REQUIRED')
  await rejectsCode(() => entry.create(context(invalidDB, 'reject', {
    cloud: { openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'risky' } }) } } }
  }), payload()), 'CONTENT_REJECTED')
  assert.strictEqual(invalidDB.stores.venue_submissions.size, 0)
  assert.strictEqual(invalidDB.stores.venues.size, 0)
  console.log('PASS 名称、标签、公开确认与内容安全校验')

  const mine = await entry.listMine(applicant, { page: 1, pageSize: 20 })
  assert.strictEqual(mine.items.length, 1)
  const mineDetail = await entry.getMine(applicant, { submissionId: submitted.submission.id })
  assert.strictEqual(mineDetail.submission.id, submitted.submission.id)
  await rejectsCode(() => entry.getMine(context(db, 'other_player'), { submissionId: submitted.submission.id }), 'NOT_FOUND')
  const otherMine = await entry.listMine(context(db, 'other_player'), { page: 1, pageSize: 20 })
  assert.strictEqual(otherMine.items.length, 0)
  console.log('PASS 普通用户只能查看自己的提交')

  const retry = await entry.create(context(db, 'player_1', { requestId: applicant.requestId }), payload())
  assert.strictEqual(retry.created, false)
  assert.strictEqual(retry.idempotent, true)
  const sameUserVariant = await entry.create(context(db, 'player_1', { requestId: 'request_player_1_0002' }), payload({ name: ' 新   球馆 ' }))
  assert.strictEqual(sameUserVariant.submission.id, submitted.submission.id)
  assert.strictEqual(db.stores.venue_submissions.size, 1)

  const second = await entry.create(context(db, 'player_2'), payload({ name: '新 球馆' }))
  assert.strictEqual(second.submission, null)
  assert.strictEqual(second.duplicateExisting, true)
  assert.strictEqual(second.venue.id, submitted.venue.id)
  assert.strictEqual(db.stores.venue_submissions.size, 1)
  console.log('PASS 同一用户超时重试幂等，不同用户同名录入直接复用公开球馆')

  const concurrentDB = database()
  const [concurrentA, concurrentB] = await Promise.all([
    entry.create(context(concurrentDB, 'concurrent_a', { requestId: 'request_concurrent_a' }), payload({ name: '并发同名球馆' })),
    entry.create(context(concurrentDB, 'concurrent_b', { requestId: 'request_concurrent_b' }), payload({ name: '并发 同名球馆' }))
  ])
  assert.strictEqual(concurrentA.venue.id, concurrentB.venue.id)
  assert.strictEqual(concurrentDB.stores.venues.size, 1)
  assert.strictEqual(concurrentDB.stores.venue_submissions.size, 2)
  assert.deepStrictEqual(
    Array.from(concurrentDB.stores.venue_submissions.values()).map((item) => item.status),
    ['approved', 'approved']
  )
  console.log('PASS 不同用户并发录入同名球馆时只生成一条公开目录记录')

  const directUniqueConflictDB = database()
  directUniqueConflictDB.beforeNextSet = ({ collection }) => {
    if (collection === 'venues') throw Object.assign(new Error('E11000 duplicate key error index: city_name_key'), { code: 11000 })
  }
  await rejectsCode(() => entry.create(context(directUniqueConflictDB, 'direct_unique'), payload({ name: '即时唯一冲突球馆' })), 'VENUE_NAME_CONFLICT')
  assert.strictEqual(directUniqueConflictDB.stores.venues.size, 0)
  assert.strictEqual(directUniqueConflictDB.stores.venue_submissions.size, 0)
  console.log('PASS 即时录入唯一索引竞态映射为可重试冲突且不写提交记录')

  await rejectsCode(() => entry.pending(applicant, {}), 'FORBIDDEN')
  await rejectsCode(() => entry.getForAdmin(applicant, { submissionId: submitted.submission.id }), 'FORBIDDEN')
  await rejectsCode(() => entry.review(applicant, {
    submissionId: submitted.submission.id, expectedVersion: 1, decision: 'approve'
  }), 'FORBIDDEN')
  const directAdmin = context(db, 'admin_openid', {
    requestId: 'request_admin_review_001',
    user: { role: 'admin', profile: {} }
  })
  const directQueue = await entry.pending(directAdmin, { pageSize: 20 })
  assert.strictEqual(directQueue.items.length, 0)
  await rejectsCode(() => entry.review(directAdmin, {
    submissionId: submitted.submission.id, expectedVersion: 1, decision: 'approve'
  }), 'VERSION_CONFLICT')

  // Old clients may have left reviewing records in production. Keep the
  // complete administrator workflow operational for those historical rows.
  const reviewDB = database()
  const legacySubmitted = seedLegacySubmission(reviewDB, 'legacy_player_1', { name: '历史新球馆' })
  const legacySecond = seedLegacySubmission(reviewDB, 'legacy_player_2', { name: '历史 新球馆' })
  const admin = context(reviewDB, 'admin_openid', {
    requestId: 'request_admin_review_001',
    user: { role: 'admin', profile: {} }
  })
  const queue = await entry.pending(admin, { pageSize: 20 })
  assert.strictEqual(queue.items.length, 2)
  assert.strictEqual(queue.items[0].submitter.displayName.startsWith('球友'), true)
  assert.deepStrictEqual({ page: queue.page, pageSize: queue.pageSize, hasMore: queue.hasMore }, { page: 1, pageSize: 20, hasMore: false })
  const queuePage1 = await entry.pending(admin, { page: 1, pageSize: 1 })
  const queuePage2 = await entry.pending(admin, { page: 2, pageSize: 1 })
  assert.strictEqual(queuePage1.items.length, 1)
  assert.strictEqual(queuePage1.hasMore, true)
  assert.strictEqual(queuePage2.items.length, 1)
  assert.strictEqual(queuePage2.hasMore, false)
  assert.notStrictEqual(queuePage1.items[0].id, queuePage2.items[0].id)
  await rejectsCode(() => entry.getForAdmin(admin, { submissionId: 'missing_submission' }), 'NOT_FOUND')
  const reviewingDetail = await entry.getForAdmin(admin, { submissionId: legacySubmitted.submission.id })
  assert.strictEqual(reviewingDetail.submission.status, 'reviewing')
  assert.strictEqual(reviewingDetail.venue, null)
  assert(reviewingDetail.submission.submitter)
  for (const privateField of ['userId', 'reviewedBy', 'requestId', 'reviewRequestId', 'nameKey', 'targetVenueId']) {
    assert.strictEqual(reviewingDetail.submission[privateField], undefined)
  }
  const staleReviewError = await captureError(() => entry.review(context(reviewDB, 'admin_openid', {
    requestId: 'request_admin_stale_001', user: { role: 'admin', profile: {} }
  }), {
    submissionId: legacySubmitted.submission.id, expectedVersion: 9, decision: 'approve'
  }), 'VERSION_CONFLICT')
  assert.deepStrictEqual(staleReviewError.details, { currentStatus: 'reviewing', currentVersion: 1 })

  const approved = await entry.review(admin, {
    submissionId: legacySubmitted.submission.id,
    expectedVersion: 1,
    decision: 'approve'
  })
  assert.strictEqual(approved.submission.status, 'approved')
  assert.strictEqual(approved.venueCreated, true)
  assert.strictEqual(approved.venue.id, legacySubmitted.submission.venueId)
  const publicRecord = reviewDB.stores.venues.get(approved.venue.id)
  assert.strictEqual(publicRecord.active, true)
  assert.strictEqual(publicRecord.verificationStatus, 'verified')
  assert.strictEqual(publicRecord.listingMode, 'name_only')
  assert.strictEqual(publicRecord.source, 'community')
  assert.strictEqual(publicRecord.userId, undefined)
  assert.strictEqual(approved.venue.verified, false)
  assert.strictEqual(approved.venue.userContributed, true)
  const approvedDetail = await entry.getForAdmin(admin, { submissionId: legacySubmitted.submission.id })
  assert.strictEqual(approvedDetail.submission.status, 'approved')
  assert.strictEqual(approvedDetail.venue.id, approved.venue.id)
  publicRecord.active = false
  const approvedWithUnavailableVenue = await entry.getForAdmin(admin, { submissionId: legacySubmitted.submission.id })
  assert.strictEqual(approvedWithUnavailableVenue.submission.status, 'approved')
  assert.strictEqual(approvedWithUnavailableVenue.venue, null)
  publicRecord.active = true

  const replay = await entry.review(admin, {
    submissionId: legacySubmitted.submission.id,
    expectedVersion: 1,
    decision: 'approve'
  })
  assert.strictEqual(replay.idempotent, true)
  assert.strictEqual(replay.venueCreated, true)
  assert.strictEqual(reviewDB.stores.venues.size, 1)
  await rejectsCode(() => entry.review(admin, {
    submissionId: legacySubmitted.submission.id,
    expectedVersion: 1,
    decision: 'reject',
    reason: '同一个请求号不能改变审核结论'
  }), 'IDEMPOTENCY_CONFLICT')
  await rejectsCode(() => entry.review(admin, {
    submissionId: legacySubmitted.submission.id,
    expectedVersion: 2,
    decision: 'approve'
  }), 'IDEMPOTENCY_CONFLICT')
  assert.strictEqual(reviewDB.stores.venue_submissions.get(legacySubmitted.submission.id).status, 'approved')

  const approvedDuplicate = await entry.review(context(reviewDB, 'admin_openid', {
    requestId: 'request_admin_review_002', user: { role: 'admin', profile: {} }
  }), {
    submissionId: legacySecond.submission.id,
    expectedVersion: 1,
    decision: 'approve'
  })
  assert.strictEqual(approvedDuplicate.venueCreated, false)
  assert.strictEqual(approvedDuplicate.venue.id, approved.venue.id)
  assert.strictEqual(reviewDB.stores.venues.size, 1)
  const emptyQueue = await entry.pending(admin, { pageSize: 20 })
  assert.strictEqual(emptyQueue.items.length, 0)
  console.log('PASS 新录入不进队列，历史待审仍可幂等审核并复用同名球馆')

  const revokedDB = database()
  const revokedSubmission = seedLegacySubmission(revokedDB, 'revoked_applicant', { name: '撤权竞态球馆' })
  const revokedAdmin = context(revokedDB, 'revoked_admin', {
    requestId: 'request_revoked_admin_review', user: { role: 'admin', profile: {} }
  })
  revokedDB.beforeNextTransaction = () => { revokedDB.stores.users.get('revoked_admin').role = 'player' }
  await rejectsCode(() => entry.review(revokedAdmin, {
    submissionId: revokedSubmission.submission.id, expectedVersion: 1, decision: 'approve'
  }), 'FORBIDDEN')
  assert.strictEqual(revokedDB.stores.venues.size, 0)
  assert.strictEqual(revokedDB.stores.venue_submissions.get(revokedSubmission.submission.id).status, 'reviewing')
  console.log('PASS 审核提交事务会重新确认管理员权限，撤权并发不能落库')

  const duplicate = await entry.create(context(db, 'player_3'), payload())
  assert.strictEqual(duplicate.submission, null)
  assert.strictEqual(duplicate.duplicateExisting, true)
  assert.strictEqual(duplicate.venue.id, submitted.venue.id)
  assert.strictEqual(db.stores.venue_submissions.size, 1)
  const publicVenue = await venues.get(context(db, 'player_3'), { venueId: submitted.venue.id })
  assert.strictEqual(publicVenue.name, '新球馆')
  const match = await matches.create(context(db, 'player_3', { requestId: 'request_match_create_001' }), {
    title: '一起练球', venueId: submitted.venue.id, date: '2099-09-12', startTime: '19:00', endTime: '21:00', capacity: 2,
    termsAccepted: true, termsVersion: terms.currentVersion()
  })
  assert.strictEqual(match.match.venueId, submitted.venue.id)
  console.log('PASS 录入后公开可查可发布，已有公开球馆直接复用')

  const rejectedDB = database()
  const rejectedSeed = seedLegacySubmission(rejectedDB, 'rejected_player', { name: '待核对球馆' })
  const rejectedApplicant = rejectedSeed.context
  const toReject = rejectedSeed
  const rejectAdmin = context(rejectedDB, 'admin_openid', {
    requestId: 'request_admin_reject_001', user: { role: 'admin', profile: {} }
  })
  await rejectsCode(() => entry.review(rejectAdmin, {
    submissionId: toReject.submission.id, expectedVersion: 1, decision: 'reject', reason: ''
  }), 'INVALID_ARGUMENT')
  const rejected = await entry.review(rejectAdmin, {
    submissionId: toReject.submission.id, expectedVersion: 1, decision: 'reject', reason: '球馆名称无法核实'
  })
  assert.strictEqual(rejected.submission.status, 'rejected')
  assert.strictEqual(rejected.submission.reviewReason, '球馆名称无法核实')
  assert.strictEqual(rejected.venue, null)
  const rejectedDetail = await entry.getForAdmin(rejectAdmin, { submissionId: toReject.submission.id })
  assert.strictEqual(rejectedDetail.submission.status, 'rejected')
  assert.strictEqual(rejectedDetail.submission.reviewReason, '球馆名称无法核实')
  assert.strictEqual(rejectedDetail.venue, null)
  const rejectedMine = await entry.getMine(rejectedApplicant, { submissionId: toReject.submission.id })
  assert.strictEqual(rejectedMine.submission.reviewReason, '球馆名称无法核实')
  const queueAfterReject = await entry.pending(rejectAdmin, { pageSize: 20 })
  assert.strictEqual(queueAfterReject.items.length, 0)
  await rejectsCode(() => entry.resubmit(context(rejectedDB, 'other_player', { requestId: 'request_other_resubmit' }), {
    submissionId: toReject.submission.id, expectedVersion: 2, activityTags: ['切磋'], confirmPublic: true
  }), 'NOT_FOUND')
  await rejectsCode(() => entry.resubmit(context(rejectedDB, 'rejected_player', {
    requestId: 'request_resubmit_stale', user: rejectedApplicant.user
  }), {
    submissionId: toReject.submission.id, expectedVersion: 1, activityTags: ['切磋'], confirmPublic: true
  }), 'VERSION_CONFLICT')
  const resubmitted = await entry.resubmit(context(rejectedDB, 'rejected_player', {
    requestId: 'request_resubmit_001', user: rejectedApplicant.user
  }), {
    submissionId: toReject.submission.id, expectedVersion: 2, activityTags: ['切磋'], confirmPublic: true,
    status: 'approved', active: true
  })
  assert.strictEqual(resubmitted.submission.status, 'approved')
  assert.strictEqual(resubmitted.submission.version, 3)
  assert.strictEqual(resubmitted.submission.reviewReason, '')
  assert.strictEqual(resubmitted.venue.id, resubmitted.submission.venueId)
  assert.strictEqual(rejectedDB.stores.venues.size, 1)
  const queueAfterResubmit = await entry.pending(rejectAdmin, { pageSize: 20 })
  assert.strictEqual(queueAfterResubmit.items.length, 0)
  console.log('PASS 历史驳回理由只向申请人展示，仅本人可按版本重提并直接公开')

  const withdrawnDB = database()
  const withdrawnApplicant = context(withdrawnDB, 'withdrawn_player')
  const toWithdraw = await entry.create(withdrawnApplicant, payload({ name: '已撤回球馆' }))
  const withdrawnDocument = withdrawnDB.stores.venue_submissions.get(toWithdraw.submission.id)
  withdrawnDB.stores.venue_submissions.set(toWithdraw.submission.id, Object.assign({}, withdrawnDocument, {
    userId: 'anon_withdrawn_player',
    submitterSnapshot: { playerId: '', displayName: '已注销球友' },
    status: 'withdrawn',
    version: 2
  }))
  const withdrawnAdmin = context(withdrawnDB, 'withdrawn_admin', { user: { role: 'admin', profile: {} } })
  const withdrawnDetail = await entry.getForAdmin(withdrawnAdmin, { submissionId: toWithdraw.submission.id })
  assert.strictEqual(withdrawnDetail.submission.status, 'withdrawn')
  assert.strictEqual(withdrawnDetail.submission.submitter.playerId, '')
  assert.strictEqual(withdrawnDetail.venue, null)
  console.log('PASS 管理员精确查询覆盖 reviewing/approved/rejected/withdrawn 且不泄露内部身份字段')

  const legacyDB = database()
  legacyDB.stores.venues.set('legacy_exact', {
    _id: 'legacy_exact', name: '老球馆', city: '杭州', active: true,
    verificationStatus: 'verified', listingMode: 'name_only', activityTags: ['比赛']
  })
  const legacyReuse = await entry.create(context(legacyDB), payload({ name: '老球馆' }))
  assert.strictEqual(legacyReuse.duplicateExisting, true)
  assert.strictEqual(legacyReuse.venue.id, 'legacy_exact')
  assert.strictEqual(legacyDB.stores.venue_submissions.size, 0)
  console.log('PASS 兼容无 nameKey 的旧公开球馆数据')

  const conflictDB = database()
  conflictDB.stores.venues.set('legacy_pending', {
    _id: 'legacy_pending', name: '冲突球馆', nameKey: entry.nameKey('冲突球馆'), city: '杭州',
    active: false, verificationStatus: 'pending', listingMode: 'full'
  })
  await rejectsCode(() => entry.create(context(conflictDB), payload({ name: '冲突球馆' })), 'VENUE_NAME_CONFLICT')
  assert.strictEqual(conflictDB.stores.venue_submissions.size, 0)
  const conflictSubmission = seedLegacySubmission(conflictDB, 'legacy_conflict_player', { name: '冲突球馆' })
  await rejectsCode(() => entry.review(context(conflictDB, 'admin_openid', {
    requestId: 'request_admin_conflict', user: { role: 'admin', profile: {} }
  }), {
    submissionId: conflictSubmission.submission.id, expectedVersion: 1, decision: 'approve'
  }), 'VENUE_NAME_CONFLICT')
  assert.strictEqual(conflictDB.stores.venues.size, 1)
  assert.strictEqual(conflictDB.stores.venues.get('legacy_pending').active, false)
  assert.strictEqual(conflictDB.stores.venue_submissions.get(conflictSubmission.submission.id).status, 'reviewing')
  console.log('PASS 即时录入和历史审核都不会把同名停用记录意外重新上架')

  const deletedCreateDB = database()
  const staleCreateContext = context(deletedCreateDB, 'deleted_before_create')
  deletedCreateDB.stores.users.get('deleted_before_create').status = 'deleted'
  await rejectsCode(() => entry.create(staleCreateContext, payload({ name: '注销后球馆' })), 'ACCOUNT_DELETED')
  assert.strictEqual(deletedCreateDB.stores.venue_submissions.size, 0)

  const racingCreateDB = database()
  const racingCreateContext = context(racingCreateDB, 'deleted_during_create')
  racingCreateDB.beforeNextTransaction = () => { racingCreateDB.stores.users.get('deleted_during_create').status = 'deleted' }
  await rejectsCode(() => entry.create(racingCreateContext, payload({ name: '并发注销球馆' })), 'ACCOUNT_DELETED')
  assert.strictEqual(racingCreateDB.stores.venue_submissions.size, 0)
  console.log('PASS 用户已注销或在鉴权后并发注销时不能补写球馆申请')

  const retrySafetyDB = database()
  const retrySafetyContext = context(retrySafetyDB, 'retry_safety')
  const firstSafeSubmission = await entry.create(retrySafetyContext, payload({ name: '幂等安全检查球馆' }))
  let retryModerationCalls = 0
  const replayWithoutModeration = await entry.create(context(retrySafetyDB, 'retry_safety', {
    requestId: retrySafetyContext.requestId,
    user: retrySafetyContext.user,
    cloud: { openapi: { security: { msgSecCheck: async () => { retryModerationCalls++; throw new Error('security offline') } } } }
  }), payload({ name: '幂等安全检查球馆' }))
  assert.strictEqual(replayWithoutModeration.submission.id, firstSafeSubmission.submission.id)
  assert.strictEqual(replayWithoutModeration.idempotent, true)
  assert.strictEqual(retryModerationCalls, 0)
  console.log('PASS create 已成功请求的幂等重试不被外部文本安全服务故障阻断')

  const deletedResubmitDB = database()
  const rejectedForDeletion = seedLegacySubmission(deletedResubmitDB, 'deleted_resubmit', {
    name: '重提注销球馆', status: 'rejected', reviewReason: '请核对球馆正式名称', version: 2
  })
  const deletedResubmitApplicant = rejectedForDeletion.context
  const staleResubmitContext = context(deletedResubmitDB, 'deleted_resubmit', {
    requestId: 'request_resubmit_during_delete', user: deletedResubmitApplicant.user
  })
  deletedResubmitDB.beforeNextTransaction = () => { deletedResubmitDB.stores.users.get('deleted_resubmit').status = 'deleted' }
  await rejectsCode(() => entry.resubmit(staleResubmitContext, {
    submissionId: rejectedForDeletion.submission.id, expectedVersion: 2, activityTags: ['训练'], confirmPublic: true
  }), 'ACCOUNT_DELETED')
  assert.strictEqual(deletedResubmitDB.stores.venue_submissions.get(rejectedForDeletion.submission.id).status, 'rejected')
  console.log('PASS 重提写事务与注销并发时以已注销状态为准')

  const retryResubmitDB = database()
  const rejectedForRetry = seedLegacySubmission(retryResubmitDB, 'retry_resubmit', {
    name: '重提幂等球馆', status: 'rejected', reviewReason: '请补充更准确的球馆名称', version: 2
  })
  const retryResubmitApplicant = rejectedForRetry.context
  const resubmitRequest = context(retryResubmitDB, 'retry_resubmit', {
    requestId: 'request_resubmit_idempotent', user: retryResubmitApplicant.user
  })
  const successfulResubmit = await entry.resubmit(resubmitRequest, {
    submissionId: rejectedForRetry.submission.id, expectedVersion: 2, activityTags: ['切磋'], confirmPublic: true
  })
  let resubmitModerationCalls = 0
  const replayedResubmit = await entry.resubmit(context(retryResubmitDB, 'retry_resubmit', {
    requestId: resubmitRequest.requestId,
    user: retryResubmitApplicant.user,
    cloud: { openapi: { security: { msgSecCheck: async () => { resubmitModerationCalls++; throw new Error('security offline') } } } }
  }), {
    submissionId: rejectedForRetry.submission.id, expectedVersion: 2, activityTags: ['切磋'], confirmPublic: true
  })
  assert.strictEqual(successfulResubmit.submission.status, 'approved')
  assert.strictEqual(successfulResubmit.venue.id, successfulResubmit.submission.venueId)
  assert.strictEqual(replayedResubmit.idempotent, true)
  assert.strictEqual(resubmitModerationCalls, 0)
  console.log('PASS resubmit 直接公开后的幂等重试不重复依赖文本安全服务')

  const deletedApplicantDB = database()
  const deletedApplicantSubmission = seedLegacySubmission(deletedApplicantDB, 'deleted_applicant', { name: '申请人注销球馆' })
  const deletedApplicant = deletedApplicantSubmission.context
  deletedApplicantDB.stores.users.get('deleted_applicant').status = 'deleted'
  await rejectsCode(() => entry.review(context(deletedApplicantDB, 'admin_openid', {
    requestId: 'request_review_deleted_applicant', user: { role: 'admin', profile: {} }
  }), {
    submissionId: deletedApplicantSubmission.submission.id, expectedVersion: 1, decision: 'approve'
  }), 'ACCOUNT_DELETED')
  assert.strictEqual(deletedApplicantDB.stores.venues.size, 0)
  assert.strictEqual(deletedApplicantDB.stores.venue_submissions.get(deletedApplicantSubmission.submission.id).status, 'reviewing')

  const cleanupRaceDB = database()
  const cleanupRaceSubmission = seedLegacySubmission(cleanupRaceDB, 'cleanup_race_applicant', { name: '注销审核竞态球馆' })
  const cleanupRaceApplicant = cleanupRaceSubmission.context
  cleanupRaceDB.beforeNextTransaction = () => {
    cleanupRaceDB.stores.users.get('cleanup_race_applicant').status = 'deleted'
    const current = cleanupRaceDB.stores.venue_submissions.get(cleanupRaceSubmission.submission.id)
    cleanupRaceDB.stores.venue_submissions.set(cleanupRaceSubmission.submission.id, Object.assign({}, current, {
      userId: 'anon_deleted_applicant',
      submitterSnapshot: { playerId: '', displayName: '已注销球友' },
      status: 'withdrawn',
      version: 2
    }))
  }
  await rejectsCode(() => entry.review(context(cleanupRaceDB, 'admin_openid', {
    requestId: 'request_review_cleanup_race', user: { role: 'admin', profile: {} }
  }), {
    submissionId: cleanupRaceSubmission.submission.id, expectedVersion: 1, decision: 'approve'
  }), 'VERSION_CONFLICT')
  assert.strictEqual(cleanupRaceDB.stores.venues.size, 0)
  assert.strictEqual(cleanupRaceDB.stores.venue_submissions.get(cleanupRaceSubmission.submission.id).status, 'withdrawn')
  console.log('PASS 已注销申请人不可审核，注销/审核并发不会将 withdrawn 变为 approved')

  const renameRaceDB = database()
  const renameRaceSubmission = seedLegacySubmission(renameRaceDB, 'rename_race_applicant', { name: '错链防护球馆' })
  const renameRaceApplicant = renameRaceSubmission.context
  const reusableId = 'legacy_reusable_venue'
  renameRaceDB.stores.venues.set(reusableId, {
    _id: reusableId, name: '错链防护球馆', nameKey: entry.nameKey('错链防护球馆'), city: '杭州',
    active: true, verificationStatus: 'verified', listingMode: 'name_only'
  })
  renameRaceDB.beforeNextTransaction = () => {
    const current = renameRaceDB.stores.venues.get(reusableId)
    renameRaceDB.stores.venues.set(reusableId, Object.assign({}, current, {
      name: '已并发改名球馆', nameKey: entry.nameKey('已并发改名球馆')
    }))
  }
  await rejectsCode(() => entry.review(context(renameRaceDB, 'admin_openid', {
    requestId: 'request_review_rename_race', user: { role: 'admin', profile: {} }
  }), {
    submissionId: renameRaceSubmission.submission.id, expectedVersion: 1, decision: 'approve'
  }), 'VENUE_NAME_CONFLICT')
  assert.strictEqual(renameRaceDB.stores.venue_submissions.get(renameRaceSubmission.submission.id).status, 'reviewing')
  assert.strictEqual(renameRaceDB.stores.venue_submissions.get(renameRaceSubmission.submission.id).venueId, '')
  console.log('PASS 审核事务会重新校验可复用球馆的城市和名称键，避免并发改名错链')

  const uniqueRaceDB = database()
  const uniqueRaceSubmission = seedLegacySubmission(uniqueRaceDB, 'unique_race_applicant', { name: '唯一索引竞态球馆' })
  const uniqueRaceApplicant = uniqueRaceSubmission.context
  uniqueRaceDB.beforeNextSet = ({ collection }) => {
    if (collection === 'venues') throw Object.assign(new Error('E11000 duplicate key error index: city_name_key'), { code: 11000 })
  }
  await rejectsCode(() => entry.review(context(uniqueRaceDB, 'admin_openid', {
    requestId: 'request_review_unique_race', user: { role: 'admin', profile: {} }
  }), {
    submissionId: uniqueRaceSubmission.submission.id, expectedVersion: 1, decision: 'approve'
  }), 'VENUE_NAME_CONFLICT')
  assert.strictEqual(uniqueRaceDB.stores.venues.size, 0)
  assert.strictEqual(uniqueRaceDB.stores.venue_submissions.get(uniqueRaceSubmission.submission.id).status, 'reviewing')
  console.log('PASS 唯一索引冲突映射为可处理的 VENUE_NAME_CONFLICT')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
