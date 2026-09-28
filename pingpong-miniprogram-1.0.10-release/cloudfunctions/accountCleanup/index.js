const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const CLEANUP_BATCH = 20
const EXPIRY_CLEANUP_BATCH = 100
const EXPIRY_COLLECTIONS = ['upload_tickets', 'rate_limits']

function deletedReference(userId) {
  const value = String(userId || '')
  if (/^deleted_[a-f0-9]{24}$/.test(value)) return value
  return `deleted_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}

async function get(ref) {
  try {
    const result = await ref.get()
    return Array.isArray(result.data) ? result.data[0] || null : result.data || null
  } catch (error) {
    if (/not exist|DOCUMENT_NOT_EXIST|不存在/i.test(`${error.errCode || ''} ${error.errMsg || ''} ${error.message || ''}`)) return null
    throw error
  }
}

async function cleanupExpiredCollection(collectionName, expiresBefore = new Date()) {
  if (!EXPIRY_COLLECTIONS.includes(collectionName)) {
    throw new Error(`EXPIRY_CLEANUP_COLLECTION_NOT_ALLOWED:${collectionName}`)
  }
  const result = await db.collection(collectionName)
    .where({ expiresAt: db.command.lt(expiresBefore) })
    .orderBy('expiresAt', 'asc')
    .limit(EXPIRY_CLEANUP_BATCH)
    .field({ _id: true })
    .get()
  const removals = await Promise.allSettled((result.data || []).map((record) => (
    db.collection(collectionName).doc(record._id).remove()
  )))
  let removed = 0
  let failed = 0
  removals.forEach((removal, index) => {
    if (removal.status === 'fulfilled') {
      removed += Number(removal.value && removal.value.stats && removal.value.stats.removed || 0)
      return
    }
    failed += 1
    console.error('EXPIRY_RECORD_REMOVE_FAILED', collectionName, result.data[index]._id, removal.reason)
  })
  const matched = (result.data || []).length
  const batchFull = matched === EXPIRY_CLEANUP_BATCH
  if (batchFull) console.warn('EXPIRY_CLEANUP_BATCH_FULL', collectionName, matched)
  return { matched, removed, failed, batchFull }
}

async function cleanupExpiredRecords(expiresBefore = new Date()) {
  const removed = {}
  for (const collectionName of EXPIRY_COLLECTIONS) {
    try {
      removed[collectionName] = await cleanupExpiredCollection(collectionName, expiresBefore)
    } catch (error) {
      removed[collectionName] = { matched: 0, removed: 0, failed: 1, batchFull: false }
      console.error('EXPIRY_CLEANUP_FAILED', collectionName, error)
    }
  }
  return removed
}

async function cleanMembership(userId, reference, membership) {
  await db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('match_members').doc(membership._id)
    const currentMember = await get(memberRef)
    if (!currentMember || currentMember.userId !== userId) return
    const matchRef = transaction.collection('matches').doc(currentMember.matchId)
    const match = await get(matchRef)
    if (match) {
      const patch = { version: Number(match.version || 0) + 1, updatedAt: db.serverDate() }
      const futureActive = ['recruiting', 'full', 'changed'].includes(match.status) && new Date(match.endAt).getTime() > Date.now()
      const participantIds = match.participantIds || []
      const anonymizedSnapshot = { playerId: reference, displayName: '已注销用户', avatarFileId: '', ballAge: '', skills: [] }
      if (match.hostId === userId) {
        patch.hostId = reference
        patch.hostSnapshot = anonymizedSnapshot
        patch.participants = (match.participants || []).map((item, index) => participantIds[index] === userId ? anonymizedSnapshot : item)
        patch.participantIds = participantIds.map((id) => id === userId ? reference : id)
        if (futureActive) {
          patch.status = 'cancelled'
          patch.cancellationReason = '发起人已注销账号'
          patch.cancelledAt = db.serverDate()
        }
      } else if (currentMember.status === 'joined') {
        if (futureActive) {
          patch.participants = (match.participants || []).filter((_, index) => participantIds[index] !== userId)
          patch.participantIds = participantIds.filter((id) => id !== userId)
          patch.participantCount = Math.max(1, Number(match.participantCount || 1) - 1)
          if (match.status === 'full') patch.status = 'recruiting'
        } else {
          patch.participants = (match.participants || []).map((item, index) => participantIds[index] === userId ? anonymizedSnapshot : item)
          patch.participantIds = participantIds.map((id) => id === userId ? reference : id)
        }
      } else if (currentMember.status === 'waitlisted') {
        patch.waitlistCount = Math.max(0, Number(match.waitlistCount || 0) - 1)
      }
      await matchRef.update({ data: patch })
    }
    await memberRef.update({ data: {
      userId: reference,
      status: match && ['recruiting', 'full', 'changed'].includes(match.status) && new Date(match.endAt).getTime() > Date.now()
        ? 'cancelled'
        : currentMember.status,
      playerSnapshot: { playerId: reference, displayName: '已注销用户', avatarFileId: '', ballAge: '', skills: [] },
      updatedAt: db.serverDate()
    } })
  })
}

async function cleanBooking(userId, reference, booking) {
  await db.runTransaction(async (transaction) => {
    const bookingRef = transaction.collection('coach_bookings').doc(booking._id)
    const current = await get(bookingRef)
    if (!current || current.userId !== userId) return
    const futureConfirmed = current.status === 'confirmed' && new Date(current.startAt).getTime() > Date.now()
    if (futureConfirmed) {
      const slotRef = transaction.collection('coach_slots').doc(current.slotId)
      const slot = await get(slotRef)
      if (slot) await slotRef.update({ data: {
        bookedCount: Math.max(0, Number(slot.bookedCount || 0) - 1),
        status: 'open',
        version: Number(slot.version || 0) + 1,
        updatedAt: db.serverDate()
      } })
    }
    await bookingRef.update({ data: {
      userId: reference,
      userSnapshot: { playerId: reference, displayName: '已注销用户', avatarFileId: '', ballAge: '', skills: [] },
      status: futureConfirmed ? 'cancelled' : current.status,
      cancellationReason: futureConfirmed ? '用户已注销账号' : current.cancellationReason || '',
      cancelledAt: futureConfirmed ? db.serverDate() : current.cancelledAt || null,
      version: Number(current.version || 0) + 1,
      updatedAt: db.serverDate()
    } })
  })
}

async function cleanCoachApplication(userId, reference, application) {
  await db.runTransaction(async (transaction) => {
    const applicationRef = transaction.collection('coach_applications').doc(application._id)
    const current = await get(applicationRef)
    if (!current || current.userId !== userId) return
    const reviewing = current.status === 'reviewing'
    const patch = {
      userId: reference,
      publicId: reference,
      realName: '已注销用户',
      mobile: '',
      avatarFileId: '',
      city: '',
      district: '',
      experienceYears: 0,
      specialty: [],
      venueName: '',
      introduction: '',
      qualification: '',
      status: reviewing ? 'rejected' : current.status,
      reviewReason: reviewing ? '申请人已注销账号' : current.reviewReason || '',
      reviewedBy: current.reviewedBy === userId ? reference : current.reviewedBy || '',
      requestId: '',
      reviewRequestId: '',
      version: Number(current.version || 1) + 1,
      anonymizedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
    if (Object.prototype.hasOwnProperty.call(current, 'openid')) patch.openid = reference
    await applicationRef.update({ data: patch })
  })
}

async function cleanCoachApplicationReviewer(userId, reference, application) {
  await db.runTransaction(async (transaction) => {
    const applicationRef = transaction.collection('coach_applications').doc(application._id)
    const current = await get(applicationRef)
    if (!current || current.reviewedBy !== userId) return
    await applicationRef.update({ data: {
      reviewedBy: reference,
      reviewerAnonymizedAt: db.serverDate(),
      version: Number(current.version || 1) + 1,
      updatedAt: db.serverDate()
    } })
  })
}

async function cleanCoach(userId, reference, coach) {
  await db.runTransaction(async (transaction) => {
    const coachRef = transaction.collection('coaches').doc(coach._id)
    const current = await get(coachRef)
    if (!current || current.userId !== userId) return
    const patch = {
      userId: reference,
      name: '已注销教练',
      avatarFileId: '',
      city: '',
      district: '',
      venueIds: [],
      specialty: [],
      introduction: '',
      experienceYears: 0,
      qualification: '',
      verificationStatus: 'rejected',
      verificationDate: '',
      verificationReference: '',
      active: false,
      deactivationReason: '账号已注销',
      anonymizedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
    if (Object.prototype.hasOwnProperty.call(current, 'openid')) patch.openid = reference
    await coachRef.update({ data: patch })
  })
}

async function cleanVenueSubmission(userId, reference, submission) {
  await db.runTransaction(async (transaction) => {
    const submissionRef = transaction.collection('venue_submissions').doc(submission._id)
    const current = await get(submissionRef)
    if (!current || current.userId !== userId) return
    const reviewing = current.status === 'reviewing'
    const patch = {
      userId: reference,
      submitterSnapshot: { playerId: reference, displayName: '已注销用户' },
      version: Number(current.version || 1) + 1,
      anonymizedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
    if (reviewing) {
      patch.status = 'withdrawn'
      patch.reviewReason = '提交者已注销账号'
      patch.withdrawnAt = db.serverDate()
    }
    await submissionRef.update({ data: patch })
  })
}

async function cleanVenueSubmissionReviewer(userId, reference, submission) {
  await db.runTransaction(async (transaction) => {
    const submissionRef = transaction.collection('venue_submissions').doc(submission._id)
    const current = await get(submissionRef)
    if (!current || current.reviewedBy !== userId) return
    await submissionRef.update({ data: {
      reviewedBy: reference,
      version: Number(current.version || 1) + 1,
      reviewerAnonymizedAt: db.serverDate(),
      updatedAt: db.serverDate()
    } })
  })
}

async function cleanVenueReview(userId, review) {
  await db.runTransaction(async (transaction) => {
    const reviewRef = transaction.collection('venue_reviews').doc(review._id)
    const current = await get(reviewRef)
    if (!current || current.userId !== userId) return
    const venueRef = transaction.collection('venues').doc(current.venueId)
    const venue = await get(venueRef)
    if (venue) {
      const tagCounts = Object.assign({}, venue.ratingTagCounts || {})
      ;(current.tags || []).forEach((tag) => { if (Object.prototype.hasOwnProperty.call(tagCounts, tag)) tagCounts[tag] = Math.max(0, Number(tagCounts[tag] || 0) - 1) })
      const count = Math.max(0, Number(venue.ratingCount || 0) - 1)
      const total = Math.max(0, Number(venue.ratingTotal || 0) - Number(current.rating || 0))
      await venueRef.update({ data: {
        ratingCount: count,
        ratingTotal: total,
        ratingAverage: count ? Math.round((total / count) * 10) / 10 : 0,
        ratingTagCounts: tagCounts,
        updatedAt: db.serverDate()
      } })
    }
    await reviewRef.remove()
  })
}

async function cleanJob(job) {
  const userId = String(job && (job.userId || job.openid) || '')
  if (!userId) throw new Error('ACCOUNT_CLEANUP_USER_ID_MISSING')
  const reference = deletedReference(userId)
  if (job.status === 'completed') {
    const patch = { userId: reference, updatedAt: db.serverDate() }
    if (Object.prototype.hasOwnProperty.call(job, 'openid')) patch.openid = reference
    await db.collection('account_deletion_jobs').doc(job._id).update({ data: patch })
    return
  }
  const [members, bookings, coachApplications, reviewedCoachApplications, coaches, venueSubmissions, reviewedVenueSubmissions, venueReviews, videos, media, messages, messageInboxes, favorites, ownedFriendships, incomingFriendships, playerUpdates, authoredUpdateComments, ownedUpdateComments, outgoingBlocks, incomingBlocks] = await Promise.all([
    db.collection('match_members').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('coach_bookings').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('coach_applications').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('coach_applications').where({ reviewedBy: userId }).limit(CLEANUP_BATCH).get(),
    db.collection('coaches').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('venue_submissions').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('venue_submissions').where({ reviewedBy: userId }).limit(CLEANUP_BATCH).get(),
    db.collection('venue_reviews').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('user_videos').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('user_media').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('match_messages').where({ senderId: userId }).limit(CLEANUP_BATCH).get(),
    db.collection('message_inboxes').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('venue_favorites').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('player_friends').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('player_friends').where({ friendId: userId }).limit(CLEANUP_BATCH).get(),
    db.collection('player_updates').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('player_update_comments').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('player_update_comments').where({ updateOwnerId: userId }).limit(CLEANUP_BATCH).get(),
    db.collection('user_blocks').where({ userId }).limit(CLEANUP_BATCH).get(),
    db.collection('user_blocks').where({ targetUserId: userId }).limit(CLEANUP_BATCH).get()
  ])
  for (const membership of members.data) await cleanMembership(userId, reference, membership)
  for (const booking of bookings.data) await cleanBooking(userId, reference, booking)
  for (const application of coachApplications.data) await cleanCoachApplication(userId, reference, application)
  for (const application of reviewedCoachApplications.data) await cleanCoachApplicationReviewer(userId, reference, application)
  for (const coach of coaches.data) await cleanCoach(userId, reference, coach)
  for (const submission of venueSubmissions.data) await cleanVenueSubmission(userId, reference, submission)
  for (const submission of reviewedVenueSubmissions.data) await cleanVenueSubmissionReviewer(userId, reference, submission)
  for (const review of venueReviews.data) await cleanVenueReview(userId, review)
  // Detach public venue photos before deleting their storage objects.
  for (const photo of media.data.filter(item => item.purpose === 'venue_photo' && item.venueId && item.fileId)) {
    await db.runTransaction(async transaction => {
      const venueRef = transaction.collection('venues').doc(photo.venueId)
      const venue = await get(venueRef)
      if (venue) await venueRef.update({ data: {
        photoFileIds: (venue.photoFileIds || []).filter(id => id !== photo.fileId), updatedAt: db.serverDate()
      } })
    })
  }
  const fileIds = Array.from(new Set(
    videos.data.concat(media.data).map((item) => item.fileId)
      .concat(Array.isArray(job.legacyVideoFileIds) ? job.legacyVideoFileIds : [])
      .filter((fileId) => typeof fileId === 'string' && /^cloud:\/\//.test(fileId))
  ))
  for (let index = 0; index < fileIds.length; index += 50) {
    try {
      await cloud.deleteFile({ fileList: fileIds.slice(index, index + 50) })
    } catch (error) {
      const message = String(error && (error.errMsg || error.message) || error)
      if (!/not exist|不存在/i.test(message)) throw error
    }
  }
  await Promise.all([
    ...messages.data.map((item) => db.collection('match_messages').doc(item._id).update({ data: {
      senderId: reference,
      senderSnapshot: { playerId: reference, displayName: '已注销用户', avatarFileId: '', ballAge: '', skills: [] }
    } })),
    ...messageInboxes.data.map((item) => db.collection('message_inboxes').doc(item._id).remove()),
    ...videos.data.map((item) => db.collection('user_videos').doc(item._id).update({ data: { userId: reference, deleted: true, status: 'deleted', fileId: '', updatedAt: db.serverDate() } })),
    ...media.data.map((item) => db.collection('user_media').doc(item._id).update({ data: { userId: reference, deleted: true, status: 'deleted', fileId: '', updatedAt: db.serverDate() } })),
    ...favorites.data.map((item) => db.collection('venue_favorites').doc(item._id).remove()),
    ...ownedFriendships.data.map((item) => db.collection('player_friends').doc(item._id).remove()),
    ...incomingFriendships.data.map((item) => db.collection('player_friends').doc(item._id).remove()),
    ...playerUpdates.data.map((item) => db.collection('player_updates').doc(item._id).remove()),
    ...authoredUpdateComments.data.filter(item => item.updateOwnerId !== userId).map((item) => db.collection('player_update_comments').doc(item._id).update({ data: {
      userId: reference,
      authorSnapshot: { playerId: reference, displayName: '已注销用户', avatarFileId: '' },
      updatedAt: db.serverDate()
    } })),
    ...ownedUpdateComments.data.map((item) => db.collection('player_update_comments').doc(item._id).remove()),
    ...outgoingBlocks.data.map((item) => db.collection('user_blocks').doc(item._id).remove()),
    ...incomingBlocks.data.map((item) => db.collection('user_blocks').doc(item._id).remove())
  ])
  const hasMore = [members, bookings, coachApplications, reviewedCoachApplications, coaches, venueSubmissions, reviewedVenueSubmissions, venueReviews, videos, media, messages, messageInboxes, favorites, ownedFriendships, incomingFriendships, playerUpdates, authoredUpdateComments, ownedUpdateComments, outgoingBlocks, incomingBlocks]
    .some((result) => result.data.length === CLEANUP_BATCH)
  const jobPatch = {
    status: hasMore ? 'pending' : 'completed',
    userId: hasMore ? userId : reference,
    attempts: Number(job.attempts || 0) + 1,
    legacyVideoFileIds: hasMore ? (job.legacyVideoFileIds || []) : [],
    updatedAt: db.serverDate(),
    completedAt: hasMore ? null : db.serverDate()
  }
  if (Object.prototype.hasOwnProperty.call(job, 'openid')) jobPatch.openid = hasMore ? userId : reference
  await db.collection('account_deletion_jobs').doc(job._id).update({ data: jobPatch })
}

exports.main = async () => {
  const result = await db.collection('account_deletion_jobs').where({ status: 'pending' }).orderBy('requestedAt', 'asc').limit(10).get()
  for (const job of result.data) {
    try {
      await cleanJob(job)
    } catch (error) {
      console.error('ACCOUNT_CLEANUP_FAILED', job._id, error)
      await db.collection('account_deletion_jobs').doc(job._id).update({ data: {
        attempts: Number(job.attempts || 0) + 1,
        lastError: String(error.message || error).slice(0, 300),
        updatedAt: db.serverDate()
      } })
    }
  }
  // Account deletion is privacy-critical, so it keeps priority within the short timer-function budget.
  const expiryCleanup = await cleanupExpiredRecords()
  return { processed: result.data.length, expiryCleanup }
}

exports._private = {
  cleanJob,
  cleanBooking,
  cleanCoachApplication,
  cleanCoachApplicationReviewer,
  cleanCoach,
  cleanVenueSubmission,
  cleanVenueSubmissionReviewer,
  cleanVenueReview,
  cleanupExpiredCollection,
  cleanupExpiredRecords,
  deletedReference,
  EXPIRY_CLEANUP_BATCH,
  EXPIRY_COLLECTIONS
}
