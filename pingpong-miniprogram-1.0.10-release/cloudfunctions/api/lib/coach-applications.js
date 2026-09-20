const crypto = require('crypto')
const { COLLECTIONS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const { stableId, getDocument } = require('./database')
const { requireAdmin, isAdmin } = require('./auth')
const { checkText } = require('./moderation')
const { writeAudit } = require('./audit')
const terms = require('./terms')

const REVIEWING = 'reviewing'
const APPROVED = 'approved'
const REJECTED = 'rejected'

function applicationStatus(value) {
  return [REVIEWING, APPROVED, REJECTED].includes(value) ? value : REVIEWING
}

function applicationIdFor(userId) {
  return stableId('coach-application', userId)
}

function presentApplication(document) {
  if (!document) return null
  return {
    id: document._id,
    realName: document.realName || '',
    mobile: document.mobile || '',
    experienceYears: Number(document.experienceYears || 0),
    specialty: Array.isArray(document.specialty) ? document.specialty : [],
    venueName: document.venueName || '',
    introduction: document.introduction || '',
    qualification: document.qualification || '',
    status: applicationStatus(document.status),
    reviewReason: document.status === REJECTED ? document.reviewReason || '' : '',
    coachId: document.status === APPROVED ? document.coachId || '' : '',
    version: Number(document.version || 1),
    submittedAt: document.submittedAt,
    reviewedAt: document.reviewedAt || null,
    updatedAt: document.updatedAt
  }
}

function validateApplication(payload) {
  const specialty = validate.stringArray(payload.specialty, '擅长方向', { required: true, maxItems: 8, itemMax: 20 })
  assert(specialty.length > 0, 'INVALID_ARGUMENT', '请至少填写一项擅长方向')
  const mobile = validate.text(payload.mobile, '手机号', { min: 11, max: 11 })
  assert(/^1[3-9]\d{9}$/.test(mobile), 'INVALID_ARGUMENT', '请填写有效的手机号')
  return {
    realName: validate.text(payload.realName, '真实姓名', { min: 2, max: 30 }),
    mobile,
    experienceYears: validate.integer(payload.experienceYears, '执教年限', { min: 0, max: 60 }),
    specialty,
    venueName: validate.text(payload.venueName, '执教球馆', { min: 2, max: 60 }),
    introduction: validate.text(payload.introduction || '', '教练介绍', { required: false, max: 500 }),
    qualification: validate.text(payload.qualification, '资历说明', { min: 2, max: 300 })
  }
}

async function getMine(context) {
  const application = await getDocument(
    context.db.collection(COLLECTIONS.coachApplications).doc(applicationIdFor(context.openid))
  )
  return {
    status: application ? presentApplication(application).status : 'not_submitted',
    application: presentApplication(application)
  }
}

async function submit(context, payload) {
  const termsVersion = terms.requireAcceptance(payload)
  validate.id(context.requestId, '请求 ID')
  const data = validateApplication(payload)
  await checkText(context, [data.realName, data.venueName, data.introduction, data.qualification].concat(data.specialty), 2)

  const applicationId = applicationIdFor(context.openid)
  const ref = context.db.collection(COLLECTIONS.coachApplications).doc(applicationId)
  const existing = await getDocument(ref)
  if (existing && existing.requestId === context.requestId) {
    return { application: presentApplication(existing), idempotent: true }
  }
  assert(!existing || existing.status === REJECTED, 'VERSION_CONFLICT',
    existing && existing.status === APPROVED ? '教练认证已通过，不能重复提交' : '教练认证正在审核，不能重复提交')
  if (existing) {
    const expectedVersion = validate.integer(payload.expectedVersion, '申请版本', { min: 1 })
    assert(Number(existing.version || 1) === expectedVersion, 'VERSION_CONFLICT', '申请状态已更新，请刷新后重试')
  }

  const profile = context.user && context.user.profile || {}
  const next = Object.assign({}, data, {
    userId: context.openid,
    publicId: context.user && context.user.publicId || '',
    avatarFileId: profile.avatarFileId || '',
    city: profile.city || '杭州',
    district: profile.district || '',
    status: REVIEWING,
    reviewReason: '',
    coachId: '',
    reviewedBy: '',
    reviewedAt: null,
    reviewRequestId: '',
    version: Number(existing && existing.version || 0) + 1,
    requestId: context.requestId,
    termsVersion,
    termsAcceptedAt: context.serverDate(),
    submittedAt: context.serverDate(),
    createdAt: existing && existing.createdAt || context.serverDate(),
    updatedAt: context.serverDate()
  })
  if (existing) await ref.update({ data: next })
  else await ref.set({ data: next })
  await writeAudit(context, 'coachApplications.submit', 'coachApplication', applicationId, { version: next.version })
  return { application: presentApplication(Object.assign({ _id: applicationId }, next)), idempotent: false }
}

async function pending(context, payload) {
  requireAdmin(context)
  const paging = validate.pagination(payload)
  const result = await context.db.collection(COLLECTIONS.coachApplications)
    .where({ status: REVIEWING })
    .orderBy('submittedAt', 'asc')
    .skip((paging.page - 1) * paging.pageSize)
    .limit(paging.pageSize + 1)
    .get()
  const documents = result.data || []
  return {
    items: documents.slice(0, paging.pageSize).map(presentApplication),
    page: paging.page,
    pageSize: paging.pageSize,
    hasMore: documents.length > paging.pageSize
  }
}

async function getForAdmin(context, payload) {
  requireAdmin(context)
  const applicationId = validate.id(payload.applicationId, '教练申请 ID')
  const application = await getDocument(context.db.collection(COLLECTIONS.coachApplications).doc(applicationId))
  assert(application, 'NOT_FOUND', '教练申请不存在')
  return { application: presentApplication(application) }
}

async function requireActiveUser(transaction, userId, options = {}) {
  const user = await getDocument(transaction.collection(COLLECTIONS.users).doc(userId))
  const subject = options.applicant ? '申请人' : '账号'
  assert(user, 'ACCOUNT_DELETED', `${subject}已注销，无法继续操作`)
  assert(user.status !== 'deleted', 'ACCOUNT_DELETED', `${subject}已注销，无法继续操作`)
  assert(user.status === 'active', 'ACCOUNT_SUSPENDED', `${subject}当前不可用，无法继续操作`)
  return user
}

async function requireCurrentAdmin(transaction, context) {
  const user = await requireActiveUser(transaction, context.openid)
  assert(isAdmin(context, user), 'FORBIDDEN', '需要运营管理员权限')
  return user
}

function reviewIntentHash(intent) {
  const canonical = [
    intent.decision,
    intent.expectedVersion,
    intent.reviewReason,
    intent.coachId,
    intent.venueIds.slice().sort(),
    intent.verificationDate,
    intent.verificationReference,
    intent.featuredRank
  ]
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function sameStringSet(left, right) {
  const a = Array.isArray(left) ? left.slice().sort() : []
  const b = Array.isArray(right) ? right.slice().sort() : []
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function automaticReviewReference(requestId) {
  return `auto-${crypto.createHash('sha256').update(String(requestId)).digest('hex').slice(0, 32)}`
}

async function assertMatchingReviewReplay(transaction, application, intent, fingerprint) {
  const currentVersion = Number(application.version || 1)
  const expectedStatus = intent.decision === 'approve' ? APPROVED : REJECTED
  let sameIntent = application.status === expectedStatus &&
    currentVersion === intent.expectedVersion + 1 &&
    String(application.reviewReason || '') === intent.reviewReason

  if (application.reviewIntentHash) {
    sameIntent = sameIntent && application.reviewIntentHash === fingerprint
  } else if (sameIntent && intent.decision === 'approve') {
    // Compatibility for decisions committed before reviewIntentHash existed.
    // Compare the resulting private coach record; if it was changed later, a
    // caller must refresh rather than risk treating a different request as a replay.
    const coach = application.coachId
      ? await getDocument(transaction.collection(COLLECTIONS.coaches).doc(application.coachId))
      : null
    sameIntent = Boolean(coach) && application.coachId === intent.coachId &&
      sameStringSet(coach.venueIds, intent.venueIds) &&
      String(coach.verificationDate || '') === intent.verificationDate &&
      String(coach.verificationReference || '') === intent.verificationReference &&
      Number(coach.featuredRank === undefined ? 9999 : coach.featuredRank) === intent.featuredRank
  }

  assert(sameIntent, 'IDEMPOTENCY_CONFLICT', '请求 ID 已用于不同的审核操作，请刷新后重新提交', {
    currentStatus: applicationStatus(application.status),
    currentVersion
  })
}

async function review(context, payload) {
  requireAdmin(context)
  validate.id(context.requestId, '请求 ID')
  const applicationId = validate.id(payload.applicationId, '教练申请 ID')
  const expectedVersion = validate.integer(payload.expectedVersion, '申请版本', { min: 1 })
  const decision = validate.oneOf(payload.decision, ['approve', 'reject'], '审核结果')
  const reviewReason = decision === 'reject'
    ? validate.text(payload.reason, '审核说明', { min: 2, max: 200 })
    : validate.text(payload.reason || '', '审核说明', { required: false, max: 200 })

  const initial = await getDocument(context.db.collection(COLLECTIONS.coachApplications).doc(applicationId))
  assert(initial, 'NOT_FOUND', '教练申请不存在')

  let coachId = ''
  let venueIds = []
  let verificationDate = ''
  let verificationReference = ''
  let featuredRank = 9999
  if (decision === 'approve') {
    coachId = payload.coachId ? validate.id(payload.coachId, '教练 ID') : stableId('coach', initial.userId)
    venueIds = validate.stringArray(payload.venueIds, '执教球馆', { required: true, maxItems: 10, itemMax: 80 })
      .map((venueId) => validate.id(venueId, '执教球馆 ID'))
    assert(venueIds.length > 0, 'INVALID_ARGUMENT', '通过审核前请关联至少一家球馆')
    verificationDate = validate.date(payload.verificationDate, '身份核验日期')
    verificationReference = payload.verificationReference
      ? validate.text(payload.verificationReference, '核验记录编号', { min: 2, max: 80 })
      : automaticReviewReference(context.requestId)
    featuredRank = validate.integer(payload.featuredRank === undefined ? 9999 : payload.featuredRank, '推荐排序', { min: 0, max: 9999 })
  }

  const intent = {
    decision,
    expectedVersion,
    reviewReason,
    coachId,
    venueIds,
    verificationDate,
    verificationReference,
    featuredRank
  }
  const fingerprint = reviewIntentHash(intent)

  const result = await context.db.runTransaction(async (transaction) => {
    // Authentication happened before entering the route. Re-read the account
    // in the write transaction so a concurrent role revocation cannot commit.
    await requireCurrentAdmin(transaction, context)
    const applicationRef = transaction.collection(COLLECTIONS.coachApplications).doc(applicationId)
    const application = await getDocument(applicationRef)
    assert(application, 'NOT_FOUND', '教练申请不存在')
    await requireActiveUser(transaction, application.userId, { applicant: true })
    if (application.reviewRequestId === context.requestId) {
      await assertMatchingReviewReplay(transaction, application, intent, fingerprint)
      return { application, coachId: application.coachId || '', idempotent: true }
    }
    const currentVersion = Number(application.version || 1)
    assert(application.status === REVIEWING, 'VERSION_CONFLICT', '教练申请已被处理', {
      currentStatus: applicationStatus(application.status),
      currentVersion
    })
    assert(currentVersion === expectedVersion, 'VERSION_CONFLICT', '申请状态已更新，请刷新后重试', {
      currentStatus: applicationStatus(application.status),
      currentVersion
    })

    if (decision === 'approve') {
      const venues = await Promise.all(venueIds.map((venueId) => getDocument(
        transaction.collection(COLLECTIONS.venues).doc(venueId)
      )))
      assert(
        venues.every((venue) => venue && venue.active && venue.verificationStatus === 'verified'),
        'INVALID_ARGUMENT',
        '关联球馆必须是已上架的球馆目录记录'
      )

      const coachRef = transaction.collection(COLLECTIONS.coaches).doc(coachId)
      const existingCoach = await getDocument(coachRef)
      assert(!existingCoach || !existingCoach.userId || existingCoach.userId === application.userId, 'VERSION_CONFLICT', '该教练档案已关联其他账号')
      const coachData = {
        userId: application.userId,
        applicationId,
        name: application.realName,
        avatarFileId: application.avatarFileId || (existingCoach && existingCoach.avatarFileId) || '',
        city: application.city || '杭州',
        district: application.district || '',
        venueIds,
        specialty: application.specialty,
        introduction: application.introduction || '',
        experienceYears: Number(application.experienceYears || 0),
        qualification: application.qualification || '',
        rating: Number(existingCoach && existingCoach.rating || 0),
        completedSessions: Number(existingCoach && existingCoach.completedSessions || 0),
        featuredRank,
        verificationStatus: 'verified',
        verificationDate,
        verificationReference,
        active: false,
        updatedAt: context.serverDate()
      }
      if (existingCoach) await coachRef.update({ data: coachData })
      else await coachRef.set({ data: Object.assign(coachData, { createdAt: context.serverDate() }) })
    }

    const patch = {
      status: decision === 'approve' ? APPROVED : REJECTED,
      coachId: decision === 'approve' ? coachId : '',
      reviewReason,
      reviewedBy: context.openid,
      reviewedAt: context.serverDate(),
      reviewRequestId: context.requestId,
      reviewIntentHash: fingerprint,
      version: expectedVersion + 1,
      updatedAt: context.serverDate()
    }
    await applicationRef.update({ data: patch })
    return {
      application: Object.assign({}, application, patch),
      coachId: decision === 'approve' ? coachId : '',
      idempotent: false
    }
  })

  if (!result.idempotent) {
    await writeAudit(context, 'admin.coachApplications.review', 'coachApplication', applicationId, {
      decision,
      coachId: result.coachId
    })
  }
  return {
    application: presentApplication(result.application),
    coachId: result.coachId,
    idempotent: result.idempotent
  }
}

module.exports = { getMine, submit, pending, getForAdmin, review, presentApplication, applicationIdFor }
