const { COLLECTIONS, VENUE_ACTIVITY_TAGS } = require('./constants')
const { ApiError, assert } = require('./errors')
const validate = require('./validate')
const { getDocument, stableId } = require('./database')
const { checkText } = require('./moderation')
const { requireAdmin, isAdmin } = require('./auth')
const { writeAudit } = require('./audit')
const presenters = require('./presenters')

const REVIEWING = 'reviewing'
const APPROVED = 'approved'
const REJECTED = 'rejected'
const WITHDRAWN = 'withdrawn'

function normalizedName(value) {
  const input = validate.text(value, '球馆名称', { min: 2, max: 60 })
  return validate.text(input.normalize('NFKC').replace(/\s+/g, ' '), '球馆名称', { min: 2, max: 60 })
}

function nameKey(value) { return normalizedName(value).replace(/\s/g, '').toLowerCase() }

function venueIdFor(city, key) { return `venue_${stableId('community-venue', city, key)}` }

function submissionIdFor(userId, city, key) {
  return `venuesub_${stableId('venue-submission', userId, city, key)}`
}

function isAvailable(document) {
  return Boolean(document && document.active === true && document.verificationStatus === 'verified')
}

function submissionStatus(value) {
  return [REVIEWING, APPROVED, REJECTED, WITHDRAWN].includes(value) ? value : REVIEWING
}

function sameVenueIdentity(venue, submission) {
  if (!venue || !submission) return false
  const city = submission.city || '杭州'
  if (venue.city !== city) return false
  const key = submission.nameKey || nameKey(submission.name)
  return venue.nameKey ? venue.nameKey === key : venue.name === submission.name
}

function isDuplicateKeyError(error) {
  const code = Number(error && (error.code !== undefined ? error.code : error.errCode))
  const message = `${error && error.errMsg || ''} ${error && error.message || ''}`
  return code === 11000 || /E11000|duplicate key|duplicate.*index|唯一.*(?:冲突|重复)|重复键/i.test(message)
}

function communityVenueDocument(submission, now) {
  const address = String(submission.address || '').trim()
  return {
    name: submission.name,
    nameKey: submission.nameKey || nameKey(submission.name),
    city: submission.city || '杭州',
    district: submission.district || '', address, location: null,
    phone: '', openingHours: '', bookingTip: '',
    tags: [], facilityTags: [],
    activityTags: Array.isArray(submission.activityTags) ? submission.activityTags : [],
    coverFileIds: [], photoFileIds: [], featuredRank: 9999,
    listingMode: address ? 'full' : 'name_only', source: 'community', adminVerified: false,
    // `verified` is the directory visibility state. Community venues remain
    // distinct from administrator certification (adminVerified), even when
    // the contributor supplied a full address.
    verificationStatus: 'verified', verificationDate: '', sourceUrls: [],
    partnerVerified: false, partnershipReference: '', active: true,
    createdAt: now, updatedAt: now
  }
}

async function publishCommunityVenue(transaction, context, submission, lookup) {
  const venues = transaction.collection(COLLECTIONS.venues)
  if (lookup.available) {
    const venue = await getDocument(venues.doc(lookup.available._id))
    assert(isAvailable(venue), 'VERSION_CONFLICT', '同名球馆状态已变更，请重试')
    assert(sameVenueIdentity(venue, submission), 'VENUE_NAME_CONFLICT', '同名球馆信息已变更，请重试')
    return { venueId: venue._id, venueCreated: false }
  }

  // Do not reactivate an administrator-owned, rejected or disabled record.
  // It may carry operational history which a community submission must not
  // overwrite. Existing historical review tooling can still resolve it.
  if (lookup.conflict) {
    const conflict = await getDocument(venues.doc(lookup.conflict._id))
    if (isAvailable(conflict) && sameVenueIdentity(conflict, submission)) {
      return { venueId: conflict._id, venueCreated: false }
    }
    assert(!conflict || !sameVenueIdentity(conflict, submission), 'VENUE_NAME_CONFLICT', '同名球馆已有记录，请联系平台处理')
  }

  const venueId = submission.targetVenueId || lookup.targetId
  const venueRef = venues.doc(venueId)
  const existing = await getDocument(venueRef)
  if (existing) {
    assert(isAvailable(existing), 'VENUE_NAME_CONFLICT', '同名球馆已有记录，请联系平台处理')
    assert(sameVenueIdentity(existing, submission), 'VENUE_NAME_CONFLICT', '目标球馆信息已变更，请重试')
    return { venueId, venueCreated: false }
  }

  await venueRef.set({ data: communityVenueDocument(submission, context.serverDate()) })
  return { venueId, venueCreated: true }
}

function presentSubmission(document, options = {}) {
  if (!document) return null
  const status = submissionStatus(document.status)
  const result = {
    id: document._id,
    venueId: document.venueId || document.targetVenueId || '',
    name: document.name || '',
    city: document.city || '杭州',
    district: document.district || '',
    address: document.address || '',
    activityTags: Array.isArray(document.activityTags) ? document.activityTags.filter((tag) => VENUE_ACTIVITY_TAGS.includes(tag)) : [],
    status,
    reviewReason: status === REJECTED ? document.reviewReason || '' : '',
    version: Number(document.version || 1),
    submittedAt: document.submittedAt,
    reviewedAt: document.reviewedAt || null,
    updatedAt: document.updatedAt
  }
  if (options.admin) {
    const snapshot = document.submitterSnapshot || {}
    result.submitter = {
      playerId: snapshot.playerId || '',
      displayName: snapshot.displayName || '球友'
    }
  }
  return result
}

function validateActivityTags(value) {
  const tags = validate.stringArray(value, '适合活动', { maxItems: 4, itemMax: 4 })
  tags.forEach((tag) => validate.oneOf(tag, VENUE_ACTIVITY_TAGS, '适合活动'))
  return tags
}

function venueAddress(payload) {
  const address = validate.text(payload.address || '', '球馆地址', { required: false, max: 120 })
  assert(!address || address.length >= 4, 'INVALID_ARGUMENT', '请填写至少 4 个字的完整球馆地址')
  const district = validate.text(payload.district || '', '所在区域', { required: false, max: 20 })
  if (district) validate.oneOf(district, ['滨江区', '萧山区', '上城区', '西湖区', '拱墅区', '余杭区', '临平区', '钱塘区', '富阳区', '临安区'], '所在区域')
  return { address, district }
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

function assertMatchingReviewReplay(document, decision, expectedVersion, reviewReason) {
  const expectedStatus = decision === 'approve' ? APPROVED : REJECTED
  const storedVersion = Number(document.version || 1)
  const sameIntent = document.status === expectedStatus &&
    storedVersion === expectedVersion + 1 &&
    String(document.reviewReason || '') === reviewReason
  assert(sameIntent, 'IDEMPOTENCY_CONFLICT', '请求 ID 已用于不同的审核操作，请刷新后重新提交', {
    currentStatus: submissionStatus(document.status),
    currentVersion: storedVersion
  })
}

async function findVenueByName(db, city, name, key) {
  const venues = db.collection(COLLECTIONS.venues)
  const targetId = venueIdFor(city, key)
  const [canonical, keyed, legacy] = await Promise.all([
    getDocument(venues.doc(targetId)),
    venues.where({ city, nameKey: key }).limit(3).get(),
    venues.where({ city, name }).limit(3).get()
  ])
  const byId = new Map()
  ;[canonical].concat(keyed.data || [], legacy.data || []).filter(Boolean).forEach((item) => byId.set(item._id, item))
  const candidates = Array.from(byId.values())
  return {
    targetId,
    available: candidates.find(isAvailable) || null,
    conflict: candidates.find((item) => !isAvailable(item)) || null
  }
}

async function create(context, payload) {
  validate.id(context.requestId, '请求 ID')
  const name = normalizedName(payload.name)
  const key = nameKey(name)
  const city = '杭州'
  assert(payload.confirmPublic === true, 'PUBLIC_CONFIRMATION_REQUIRED', '提交后球馆名称和地址将立即公开，请确认后继续')
  const activityTags = validateActivityTags(payload.activityTags)
  const { address, district } = venueAddress(payload)

  const submissionId = submissionIdFor(context.openid, city, key)
  const stableSubmission = await getDocument(context.db.collection(COLLECTIONS.venueSubmissions).doc(submissionId))
  if (stableSubmission) {
    assert(stableSubmission.userId === context.openid, 'NOT_FOUND', '球馆提交记录不存在')
    const stableVenue = stableSubmission.venueId
      ? await getDocument(context.db.collection(COLLECTIONS.venues).doc(stableSubmission.venueId))
      : null
    return {
      submission: presentSubmission(stableSubmission),
      venue: isAvailable(stableVenue) ? presenters.venue(stableVenue) : null,
      created: false,
      venueCreated: false,
      duplicateExisting: false,
      idempotent: stableSubmission.requestId === context.requestId
    }
  }

  // Public supply is reused immediately; no meaningless application receipt.
  const existingVenue = await findVenueByName(context.db, city, name, key)
  if (existingVenue.available) {
    return {
      submission: null,
      venue: presenters.venue(existingVenue.available),
      created: false,
      duplicateExisting: true,
      idempotent: true
    }
  }
  assert(!existingVenue.conflict, 'VENUE_NAME_CONFLICT', '同名球馆已有记录，请联系平台处理')

  // A confirmed retry must not depend on the content-safety service being
  // available again. The transaction below still re-checks ownership/account.
  if (!stableSubmission || stableSubmission.requestId !== context.requestId) {
    await checkText(context, [name, address, district].concat(activityTags).filter(Boolean), 2)
  }
  let result
  try {
    result = await context.db.runTransaction(async (transaction) => {
      // Re-read the account in the write transaction. The identity loaded by
      // the gateway may have become stale because account deletion is async.
      await requireActiveUser(transaction, context.openid)
      const ref = transaction.collection(COLLECTIONS.venueSubmissions).doc(submissionId)
      const existing = await getDocument(ref)
      if (existing) {
        assert(existing.userId === context.openid, 'NOT_FOUND', '球馆提交记录不存在')
        return {
          document: existing,
          venueId: existing.venueId || '',
          venueCreated: false,
          created: false,
          idempotent: existing.requestId === context.requestId
        }
      }
      const now = context.serverDate()
      const profile = context.user && context.user.profile || {}
      const document = {
        userId: context.openid,
        submitterSnapshot: {
          playerId: context.user && context.user.publicId || '',
          displayName: profile.nickname || '球友'
        },
        targetVenueId: existingVenue.targetId,
        venueId: '',
        name,
        nameKey: key,
        city,
        address,
        district,
        activityTags,
        status: APPROVED,
        publicationMode: 'instant',
        reviewReason: '',
        reviewedBy: '',
        reviewedAt: null,
        reviewRequestId: '',
        reviewVenueCreated: false,
        requestId: context.requestId,
        version: 1,
        submittedAt: now,
        publishedAt: now,
        createdAt: now,
        updatedAt: now
      }
      const publication = await publishCommunityVenue(transaction, context, document, existingVenue)
      document.venueId = publication.venueId
      document.reviewVenueCreated = publication.venueCreated
      await ref.set({ data: document })
      return Object.assign({ document: Object.assign({ _id: submissionId }, document), created: true, idempotent: false }, publication)
    })
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new ApiError('VENUE_NAME_CONFLICT', '同名球馆已被其他操作创建，请重试')
    }
    throw error
  }
  if (result.created) {
    await writeAudit(context, 'venues.create.instant', 'venueSubmission', submissionId, {
      city,
      nameKey: key,
      venueId: result.venueId,
      venueCreated: result.venueCreated
    })
  }
  const venueDocument = result.venueId
    ? await getDocument(context.db.collection(COLLECTIONS.venues).doc(result.venueId))
    : null
  return {
    submission: presentSubmission(result.document),
    venue: isAvailable(venueDocument) ? presenters.venue(venueDocument) : null,
    created: result.created,
    venueCreated: result.venueCreated,
    duplicateExisting: false,
    idempotent: result.idempotent
  }
}

async function listMine(context, payload) {
  const paging = validate.pagination(payload)
  const result = await context.db.collection(COLLECTIONS.venueSubmissions)
    .where({ userId: context.openid })
    .orderBy('updatedAt', 'desc')
    .skip((paging.page - 1) * paging.pageSize)
    .limit(paging.pageSize)
    .get()
  return { items: result.data.map((item) => presentSubmission(item)), page: paging.page, pageSize: paging.pageSize }
}

async function getMine(context, payload) {
  const submissionId = validate.id(payload.submissionId, '球馆提交 ID')
  const document = await getDocument(context.db.collection(COLLECTIONS.venueSubmissions).doc(submissionId))
  assert(document && document.userId === context.openid, 'NOT_FOUND', '球馆提交记录不存在')
  let venue = null
  if (document.status === APPROVED && document.venueId) {
    const approvedVenue = await getDocument(context.db.collection(COLLECTIONS.venues).doc(document.venueId))
    if (isAvailable(approvedVenue)) venue = presenters.venue(approvedVenue)
  }
  return { submission: presentSubmission(document), venue }
}

async function resubmit(context, payload) {
  validate.id(context.requestId, '请求 ID')
  const submissionId = validate.id(payload.submissionId, '球馆提交 ID')
  const expectedVersion = validate.integer(payload.expectedVersion, '申请版本', { min: 1 })
  assert(payload.confirmPublic === true, 'PUBLIC_CONFIRMATION_REQUIRED', '提交后球馆名称和地址将立即公开，请确认后继续')
  const activityTags = validateActivityTags(payload.activityTags)
  const initial = await getDocument(context.db.collection(COLLECTIONS.venueSubmissions).doc(submissionId))
  assert(initial && initial.userId === context.openid, 'NOT_FOUND', '球馆提交记录不存在')
  const { address, district } = venueAddress({
    address: payload.address === undefined ? initial.address : payload.address,
    district: payload.district === undefined ? initial.district : payload.district
  })
  if (initial.requestId !== context.requestId) {
    await checkText(context, [initial.name, address, district].concat(activityTags).filter(Boolean), 2)
  }

  const lookup = initial.requestId === context.requestId
    ? null
    : await findVenueByName(context.db, initial.city || '杭州', initial.name, initial.nameKey || nameKey(initial.name))
  if (lookup) assert(!lookup.conflict, 'VENUE_NAME_CONFLICT', '同名球馆已有记录，请联系平台处理')

  let result
  try {
    result = await context.db.runTransaction(async (transaction) => {
      await requireActiveUser(transaction, context.openid)
      const ref = transaction.collection(COLLECTIONS.venueSubmissions).doc(submissionId)
      const document = await getDocument(ref)
      assert(document && document.userId === context.openid, 'NOT_FOUND', '球馆提交记录不存在')
      if (document.requestId === context.requestId) {
        return { document, venueId: document.venueId || '', venueCreated: false, idempotent: true }
      }
      assert(document.status === REJECTED, 'VERSION_CONFLICT', '只有未通过的球馆才能重新提交')
      assert(Number(document.version || 1) === expectedVersion, 'VERSION_CONFLICT', '提交状态已更新，请刷新后重试')
      const publication = await publishCommunityVenue(transaction, context, Object.assign({}, document, { activityTags, address, district }), lookup)
      const now = context.serverDate()
      const patch = {
        activityTags,
        address,
        district,
        status: APPROVED,
        venueId: publication.venueId,
        publicationMode: 'instant',
        reviewReason: '',
        reviewedBy: '',
        reviewedAt: null,
        reviewRequestId: '',
        reviewVenueCreated: publication.venueCreated,
        requestId: context.requestId,
        version: expectedVersion + 1,
        submittedAt: now,
        publishedAt: now,
        updatedAt: now
      }
      await ref.update({ data: patch })
      return Object.assign({ document: Object.assign({}, document, patch), idempotent: false }, publication)
    })
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new ApiError('VENUE_NAME_CONFLICT', '同名球馆已被其他操作创建，请重试')
    }
    throw error
  }
  if (!result.idempotent) {
    await writeAudit(context, 'venues.submissions.resubmit.instant', 'venueSubmission', submissionId, {
      version: result.document.version,
      venueId: result.venueId,
      venueCreated: result.venueCreated
    })
  }
  const venueDocument = result.venueId
    ? await getDocument(context.db.collection(COLLECTIONS.venues).doc(result.venueId))
    : null
  return {
    submission: presentSubmission(result.document),
    venue: isAvailable(venueDocument) ? presenters.venue(venueDocument) : null,
    venueCreated: result.venueCreated,
    idempotent: result.idempotent
  }
}

async function pending(context, payload) {
  requireAdmin(context)
  const paging = validate.pagination(payload)
  const result = await context.db.collection(COLLECTIONS.venueSubmissions)
    .where({ status: REVIEWING })
    .orderBy('submittedAt', 'asc')
    .skip((paging.page - 1) * paging.pageSize)
    .limit(paging.pageSize + 1)
    .get()
  const documents = result.data || []
  return {
    items: documents.slice(0, paging.pageSize).map((item) => presentSubmission(item, { admin: true })),
    page: paging.page,
    pageSize: paging.pageSize,
    hasMore: documents.length > paging.pageSize
  }
}

async function getForAdmin(context, payload) {
  requireAdmin(context)
  const submissionId = validate.id(payload.submissionId, '球馆提交 ID')
  const document = await getDocument(context.db.collection(COLLECTIONS.venueSubmissions).doc(submissionId))
  assert(document, 'NOT_FOUND', '球馆提交记录不存在')
  let venue = null
  if (document.status === APPROVED && document.venueId) {
    const approvedVenue = await getDocument(context.db.collection(COLLECTIONS.venues).doc(document.venueId))
    if (isAvailable(approvedVenue)) venue = presenters.venue(approvedVenue)
  }
  return { submission: presentSubmission(document, { admin: true }), venue }
}

async function review(context, payload) {
  requireAdmin(context)
  validate.id(context.requestId, '请求 ID')
  const submissionId = validate.id(payload.submissionId, '球馆提交 ID')
  const expectedVersion = validate.integer(payload.expectedVersion, '申请版本', { min: 1 })
  const decision = validate.oneOf(payload.decision, ['approve', 'reject'], '审核结果')
  const reviewReason = decision === 'reject'
    ? validate.text(payload.reason, '审核说明', { min: 2, max: 200 })
    : validate.text(payload.reason || '', '审核说明', { required: false, max: 200 })

  const initial = await getDocument(context.db.collection(COLLECTIONS.venueSubmissions).doc(submissionId))
  assert(initial, 'NOT_FOUND', '球馆提交记录不存在')
  const replayAtRead = initial.reviewRequestId === context.requestId

  const lookup = decision === 'approve' && !replayAtRead
    ? await findVenueByName(context.db, initial.city || '杭州', initial.name, initial.nameKey || nameKey(initial.name))
    : null

  let result
  try {
    result = await context.db.runTransaction(async (transaction) => {
      // Re-read both actors in the write transaction. This closes the window
      // where an administrator is revoked or an applicant is deleted after
      // gateway authentication but before the decision commits.
      await requireCurrentAdmin(transaction, context)
      const submissionRef = transaction.collection(COLLECTIONS.venueSubmissions).doc(submissionId)
      const document = await getDocument(submissionRef)
      assert(document, 'NOT_FOUND', '球馆提交记录不存在')
      if (document.reviewRequestId === context.requestId) {
        assertMatchingReviewReplay(document, decision, expectedVersion, reviewReason)
        return {
          document,
          venueId: document.venueId || '',
          venueCreated: document.reviewVenueCreated === true,
          idempotent: true
        }
      }
      const currentVersion = Number(document.version || 1)
      assert(document.status === REVIEWING, 'VERSION_CONFLICT', '球馆提交已被处理', {
        currentStatus: submissionStatus(document.status),
        currentVersion
      })
      assert(currentVersion === expectedVersion, 'VERSION_CONFLICT', '提交状态已更新，请刷新后重试', {
        currentStatus: submissionStatus(document.status),
        currentVersion
      })
      await requireActiveUser(transaction, document.userId, { applicant: true })

      let venueId = ''
      let venueCreated = false
      if (decision === 'approve') {
        if (lookup.available) {
          const venue = await getDocument(transaction.collection(COLLECTIONS.venues).doc(lookup.available._id))
          assert(isAvailable(venue), 'VERSION_CONFLICT', '同名球馆状态已变更，请刷新后重试')
          assert(sameVenueIdentity(venue, document), 'VENUE_NAME_CONFLICT', '同名球馆信息已变更，请刷新后重试')
          venueId = venue._id
        } else {
          // Never overwrite an administrator-owned pending/rejected venue.
          assert(!lookup.conflict, 'VENUE_NAME_CONFLICT', '同名球馆已有待处理记录，请先合并或处理后再审核')
          venueId = document.targetVenueId || lookup.targetId
          const venueRef = transaction.collection(COLLECTIONS.venues).doc(venueId)
          const existing = await getDocument(venueRef)
          if (existing) {
            assert(isAvailable(existing), 'VENUE_NAME_CONFLICT', '同名球馆已有待处理记录，请先合并或处理后再审核')
            assert(sameVenueIdentity(existing, document), 'VENUE_NAME_CONFLICT', '目标球馆信息已变更，请刷新后重试')
          } else {
            await venueRef.set({ data: communityVenueDocument(document, context.serverDate()) })
            venueCreated = true
          }
        }
      }

      const patch = {
        status: decision === 'approve' ? APPROVED : REJECTED,
        venueId,
        reviewReason,
        reviewedBy: context.openid,
        reviewedAt: context.serverDate(),
        reviewRequestId: context.requestId,
        reviewVenueCreated: venueCreated,
        version: expectedVersion + 1,
        updatedAt: context.serverDate()
      }
      await submissionRef.update({ data: patch })
      return { document: Object.assign({}, document, patch), venueId, venueCreated, idempotent: false }
    })
  } catch (error) {
    if (decision === 'approve' && isDuplicateKeyError(error)) {
      throw new ApiError('VENUE_NAME_CONFLICT', '同名球馆已被其他操作创建，请刷新后重试')
    }
    throw error
  }

  const venueDocument = result.venueId
    ? await getDocument(context.db.collection(COLLECTIONS.venues).doc(result.venueId))
    : null
  if (!result.idempotent) {
    await writeAudit(context, 'admin.venueSubmissions.review', 'venueSubmission', submissionId, {
      decision,
      venueId: result.venueId,
      venueCreated: result.venueCreated
    })
  }
  return {
    submission: presentSubmission(result.document, { admin: true }),
    venue: isAvailable(venueDocument) ? presenters.venue(venueDocument) : null,
    venueCreated: result.venueCreated,
    idempotent: result.idempotent
  }
}

module.exports = {
  create,
  listMine,
  getMine,
  resubmit,
  pending,
  getForAdmin,
  review,
  presentSubmission,
  normalizedName,
  nameKey,
  _private: {
    venueIdFor,
    submissionIdFor,
    findVenueByName,
    requireActiveUser,
    sameVenueIdentity,
    isDuplicateKeyError,
    communityVenueDocument,
    publishCommunityVenue
  }
}
