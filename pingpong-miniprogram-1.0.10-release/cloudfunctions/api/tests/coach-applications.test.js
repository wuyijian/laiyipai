const assert = require('assert')
const coachApplications = require('../lib/coach-applications')
const presenters = require('../lib/presenters')
const rateLimit = require('../lib/rate-limit')
const terms = require('../lib/terms')

function database() {
  const stores = {
    users: new Map([
      ['coach_openid', { _id: 'coach_openid', role: 'player', status: 'active' }],
      ['rejected_coach_openid', { _id: 'rejected_coach_openid', role: 'player', status: 'active' }],
      ['admin_openid', { _id: 'admin_openid', role: 'admin', status: 'active' }]
    ]),
    coach_applications: new Map(),
    coaches: new Map(),
    venues: new Map([['venue_verified', {
      _id: 'venue_verified',
      name: '测试球馆',
      active: true,
      verificationStatus: 'verified'
    }]]),
    audit_logs: new Map()
  }
  let sequence = 0
  function collection(name) {
    const store = stores[name]
    if (!store) throw new Error(`unexpected collection ${name}`)
    return {
      doc(id) {
        return {
          async get() { return { data: store.get(id) || null } },
          async set({ data }) { store.set(id, Object.assign({ _id: id }, data)) },
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
        let offset = 0
        let limit = 100
        return {
          orderBy() { return this },
          skip(value) { offset = value; return this },
          limit(value) { limit = value; return this },
          async get() {
            return { data: Array.from(store.values()).filter((item) => Object.keys(condition).every((key) => item[key] === condition[key])).slice(offset, offset + limit) }
          }
        }
      }
    }
  }
  return {
    stores,
    collection,
    beforeNextTransaction: null,
    async runTransaction(work) {
      const hook = this.beforeNextTransaction
      this.beforeNextTransaction = null
      if (hook) hook()
      return work({ collection })
    }
  }
}

function context(db, overrides = {}) {
  return Object.assign({
    db,
    openid: 'coach_openid',
    requestId: 'request_submit_001',
    user: {
      publicId: 'player_public_1',
      role: 'player',
      profile: { avatarFileId: 'cloud://avatar.jpg', city: '杭州', district: '西湖区' }
    },
    cloud: {
      openapi: { security: { msgSecCheck: async () => ({ errCode: 0, result: { suggest: 'pass' } }) } }
    },
    serverDate: () => '2026-09-06T08:00:00.000Z'
  }, overrides)
}

function payload(overrides = {}) {
  return Object.assign({
    realName: '陈教练',
    mobile: '13800138000',
    experienceYears: 6,
    specialty: ['基本功', '反手训练'],
    venueName: '测试球馆',
    introduction: '注重节奏和动作细节。',
    qualification: '六年青少年教学经验',
    termsAccepted: true,
    termsVersion: terms.currentVersion()
  }, overrides)
}

async function rejectsCode(task, code) {
  let thrown = null
  try { await task() } catch (error) { thrown = error }
  assert(thrown, `expected ${code}`)
  assert.strictEqual(thrown.code, code)
  return thrown
}

async function run() {
  assert.strictEqual(rateLimit._private.groupFor('coachApplications.submit'), 'publish')
  const db = database()
  const applicant = context(db)
  const empty = await coachApplications.getMine(applicant)
  assert.deepStrictEqual(empty, { status: 'not_submitted', application: null })

  await rejectsCode(() => coachApplications.submit(applicant, payload({ mobile: '123' })), 'INVALID_ARGUMENT')
  const submitted = await coachApplications.submit(applicant, payload())
  assert.strictEqual(submitted.application.status, 'reviewing')
  assert.strictEqual(submitted.application.mobile, '13800138000')
  assert.strictEqual(submitted.application.version, 1)
  await rejectsCode(() => coachApplications.submit(context(db, { requestId: 'request_submit_while_reviewing' }), payload({
    expectedVersion: 1,
    qualification: '不应覆盖待审材料'
  })), 'VERSION_CONFLICT')
  assert.strictEqual(db.stores.coach_applications.get(submitted.application.id).qualification, '六年青少年教学经验')

  const admin = context(db, {
    openid: 'admin_openid',
    requestId: 'request_review_001',
    user: { role: 'admin', profile: {} }
  })
  const queue = await coachApplications.pending(admin, { pageSize: 20 })
  assert.strictEqual(queue.items.length, 1)
  assert.deepStrictEqual({ page: queue.page, pageSize: queue.pageSize, hasMore: queue.hasMore }, { page: 1, pageSize: 20, hasMore: false })

  const precise = await coachApplications.getForAdmin(admin, { applicationId: submitted.application.id })
  assert.strictEqual(precise.application.mobile, '13800138000')
  assert.strictEqual(precise.application.userId, undefined)
  assert.strictEqual(precise.application.reviewedBy, undefined)

  const reviewed = await coachApplications.review(admin, {
    applicationId: submitted.application.id,
    expectedVersion: 1,
    decision: 'approve',
    venueIds: ['venue_verified'],
    verificationDate: '2026-09-06'
  })
  assert.strictEqual(reviewed.application.status, 'approved')
  assert(reviewed.coachId)
  const coach = db.stores.coaches.get(reviewed.coachId)
  assert.strictEqual(coach.userId, 'coach_openid')
  assert.strictEqual(coach.active, false)
  assert.strictEqual(coach.verificationStatus, 'verified')
  assert.strictEqual(coach.experienceYears, 6)
  assert.strictEqual(coach.qualification, '六年青少年教学经验')
  assert(/^auto-[a-f0-9]{32}$/.test(coach.verificationReference))
  assert.strictEqual(coach.mobile, undefined)

  const publicCoach = presenters.coach(coach)
  assert.strictEqual(publicCoach.userId, undefined)
  assert.strictEqual(publicCoach.verificationReference, undefined)
  assert.strictEqual(publicCoach.experienceYears, 6)

  const replay = await coachApplications.review(admin, {
    applicationId: submitted.application.id,
    expectedVersion: 1,
    decision: 'approve',
    venueIds: ['venue_verified'],
    verificationDate: '2026-09-06'
  })
  assert.strictEqual(replay.idempotent, true)
  assert.strictEqual(Array.from(db.stores.audit_logs.values()).filter((item) => item.action === 'admin.coachApplications.review').length, 1)
  await rejectsCode(() => coachApplications.review(admin, {
    applicationId: submitted.application.id,
    expectedVersion: 1,
    decision: 'approve',
    venueIds: ['venue_verified'],
    verificationDate: '2026-09-06',
    featuredRank: 25
  }), 'IDEMPOTENCY_CONFLICT')
  await rejectsCode(() => coachApplications.submit(context(db, { requestId: 'request_submit_002' }), payload({ expectedVersion: 2 })), 'VERSION_CONFLICT')

  const rejectedApplicant = context(db, {
    openid: 'rejected_coach_openid',
    requestId: 'request_submit_reject_001',
    user: {
      publicId: 'player_public_2',
      role: 'player',
      profile: { city: '杭州', district: '萧山区' }
    }
  })
  const secondSubmission = await coachApplications.submit(rejectedApplicant, payload({ realName: '周教练' }))
  const rejection = await coachApplications.review(context(db, {
    openid: 'admin_openid',
    requestId: 'request_review_reject_001',
    user: { role: 'admin', profile: {} }
  }), {
    applicationId: secondSubmission.application.id,
    expectedVersion: 1,
    decision: 'reject',
    reason: '请补充可核验的执教经历'
  })
  assert.strictEqual(rejection.application.status, 'rejected')
  assert.strictEqual(rejection.application.reviewReason, '请补充可核验的执教经历')
  const mineAfterRejection = await coachApplications.getMine(rejectedApplicant)
  assert.strictEqual(mineAfterRejection.status, 'rejected')
  const resubmitted = await coachApplications.submit(context(db, {
    openid: 'rejected_coach_openid',
    requestId: 'request_submit_reject_002',
    user: rejectedApplicant.user
  }), payload({ expectedVersion: 2, qualification: '补充后的可核验执教经历' }))
  assert.strictEqual(resubmitted.application.status, 'reviewing')
  assert.strictEqual(resubmitted.application.version, 3)

  const pageDB = database()
  for (let index = 1; index <= 23; index += 1) {
    const id = `coach_application_page_${String(index).padStart(2, '0')}`
    pageDB.stores.coach_applications.set(id, {
      _id: id,
      realName: `教练${index}`,
      mobile: '13800138000',
      experienceYears: index,
      specialty: ['基本功'],
      venueName: '测试球馆',
      qualification: '可核验执教经历',
      status: 'reviewing',
      version: 1,
      submittedAt: `2026-09-${String(index).padStart(2, '0')}T08:00:00.000Z`
    })
  }
  const pageAdmin = context(pageDB, { openid: 'admin_openid', user: { role: 'admin', profile: {} } })
  const firstPage = await coachApplications.pending(pageAdmin, { page: 1, pageSize: 10 })
  const thirdPage = await coachApplications.pending(pageAdmin, { page: 3, pageSize: 10 })
  assert.strictEqual(firstPage.items.length, 10)
  assert.strictEqual(firstPage.hasMore, true)
  assert.strictEqual(thirdPage.items.length, 3)
  assert.strictEqual(thirdPage.hasMore, false)
  assert.deepStrictEqual({ page: thirdPage.page, pageSize: thirdPage.pageSize }, { page: 3, pageSize: 10 })

  const ordinaryUser = context(db, { openid: 'coach_openid', user: { role: 'player', profile: {} } })
  await rejectsCode(() => coachApplications.pending(ordinaryUser, {}), 'FORBIDDEN')
  await rejectsCode(() => coachApplications.getForAdmin(ordinaryUser, { applicationId: submitted.application.id }), 'FORBIDDEN')
  await rejectsCode(() => coachApplications.review(ordinaryUser, {
    applicationId: submitted.application.id,
    expectedVersion: 2,
    decision: 'reject',
    reason: '无权审核'
  }), 'FORBIDDEN')

  const revokedDB = database()
  const revokedSubmission = await coachApplications.submit(context(revokedDB), payload())
  const revokedAdmin = context(revokedDB, {
    openid: 'admin_openid',
    requestId: 'request_revoked_admin',
    user: { role: 'admin', profile: {} }
  })
  revokedDB.beforeNextTransaction = () => { revokedDB.stores.users.get('admin_openid').role = 'player' }
  await rejectsCode(() => coachApplications.review(revokedAdmin, {
    applicationId: revokedSubmission.application.id,
    expectedVersion: 1,
    decision: 'reject',
    reason: '不应由已撤权账号提交'
  }), 'FORBIDDEN')
  assert.strictEqual(revokedDB.stores.coach_applications.get(revokedSubmission.application.id).status, 'reviewing')

  const suspendedDB = database()
  const suspendedSubmission = await coachApplications.submit(context(suspendedDB), payload())
  const suspendedAdmin = context(suspendedDB, {
    openid: 'admin_openid',
    requestId: 'request_suspended_applicant',
    user: { role: 'admin', profile: {} }
  })
  suspendedDB.beforeNextTransaction = () => { suspendedDB.stores.users.get('coach_openid').status = 'suspended' }
  await rejectsCode(() => coachApplications.review(suspendedAdmin, {
    applicationId: suspendedSubmission.application.id,
    expectedVersion: 1,
    decision: 'reject',
    reason: '申请人状态已变化'
  }), 'ACCOUNT_SUSPENDED')
  assert.strictEqual(suspendedDB.stores.coach_applications.get(suspendedSubmission.application.id).status, 'reviewing')

  const staleDB = database()
  const staleSubmission = await coachApplications.submit(context(staleDB), payload())
  const staleError = await rejectsCode(() => coachApplications.review(context(staleDB, {
    openid: 'admin_openid',
    requestId: 'request_stale_review',
    user: { role: 'admin', profile: {} }
  }), {
    applicationId: staleSubmission.application.id,
    expectedVersion: 9,
    decision: 'reject',
    reason: '版本已经变化'
  }), 'VERSION_CONFLICT')
  assert.deepStrictEqual(staleError.details, { currentStatus: 'reviewing', currentVersion: 1 })

  const communityDB = database()
  communityDB.stores.venues.set('venue_community', {
    _id: 'venue_community',
    name: '社区录入名称球馆',
    active: true,
    verificationStatus: 'verified',
    listingMode: 'name_only',
    source: 'community'
  })
  const communitySubmission = await coachApplications.submit(context(communityDB), payload())
  const communityAdmin = context(communityDB, {
    openid: 'admin_openid',
    requestId: 'request_community_venue',
    user: { role: 'admin', profile: {} }
  })
  const communityReviewed = await coachApplications.review(communityAdmin, {
    applicationId: communitySubmission.application.id,
    expectedVersion: 1,
    decision: 'approve',
    venueIds: ['venue_community'],
    verificationDate: '2026-09-06'
  })
  assert.strictEqual(communityReviewed.application.status, 'approved')
  assert.deepStrictEqual(communityDB.stores.coaches.get(communityReviewed.coachId).venueIds, ['venue_community'])
  await rejectsCode(() => coachApplications.review(context(communityDB, {
    openid: 'admin_openid',
    requestId: 'request_invalid_venue_id',
    user: { role: 'admin', profile: {} }
  }), {
    applicationId: communitySubmission.application.id,
    expectedVersion: 1,
    decision: 'approve',
    venueIds: ['invalid/venue/id'],
    verificationDate: '2026-09-06'
  }), 'INVALID_ARGUMENT')

  console.log('coach-application-contract-tests-ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
