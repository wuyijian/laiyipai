const { COLLECTIONS } = require('./constants')
const { ApiError } = require('./errors')
const { stableId, getDocument } = require('./database')

const RULES = {
  bootstrap: [30, 60],
  read: [180, 60],
  write: [40, 60],
  message: [30, 60],
  publish: [10, 600],
  safety: [10, 3600]
}

function groupFor(action) {
  if (action === 'bootstrap') return 'bootstrap'
  if (action === 'venues.create' || action === 'venues.submissions.resubmit') return 'publish'
  if (action === 'messages.send') return 'message'
  if (action === 'messages.inbox') return 'read'
  if (action === 'friendUpdates.publish') return 'publish'
  if (action === 'updateComments.send') return 'message'
  if (action === 'venuePhotos.register') return 'publish'
  if (action === 'matches.create' || action === 'coachBookings.create' || action === 'coachApplications.submit' || action === 'videos.register' || action === 'profile.avatar.register' || action === 'profile.avatar.retry') return 'publish'
  if (action.startsWith('safety.') || action === 'account.delete') return 'safety'
  if (/\.(list|get|pending|status)$/.test(action) || action === 'appointments.list' || action === 'files.resolve') return 'read'
  return 'write'
}

function scopeFor(action, group = groupFor(action)) {
  // Home startup performs several independent reads in parallel. Keeping all
  // of them on one counter document creates avoidable transaction conflicts,
  // so reads are limited per route while sensitive writes retain their shared
  // group budget.
  return group === 'read' ? `read:${action}` : group
}

async function consume(context, action) {
  const group = groupFor(action)
  const [limit, seconds] = RULES[group]
  const bucket = Math.floor(Date.now() / (seconds * 1000))
  const scope = scopeFor(action, group)
  const id = stableId('rate-limit', context.openid, scope, bucket)
  try {
    await context.db.runTransaction(async (transaction) => {
      const ref = transaction.collection(COLLECTIONS.rateLimits).doc(id)
      const current = await getDocument(ref)
      if (current && Number(current.count || 0) >= limit) {
        throw new ApiError('RATE_LIMITED', '操作太频繁，请稍后重试', { retryAfterSeconds: seconds })
      }
      const data = {
        userId: context.openid,
        group,
        scope,
        bucket,
        count: Number(current && current.count || 0) + 1,
        expiresAt: new Date((bucket + 2) * seconds * 1000),
        updatedAt: context.serverDate()
      }
      await ref.set({ data })
    })
  } catch (error) {
    if (error instanceof ApiError) throw error
    console.error('RATE_LIMIT_FAILED', context.requestId, error)
    throw new ApiError('SERVICE_UNAVAILABLE', '服务繁忙，请稍后重试')
  }
}

module.exports = { consume, _private: { RULES, groupFor, scopeFor } }
