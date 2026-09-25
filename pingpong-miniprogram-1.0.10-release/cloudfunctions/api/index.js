const crypto = require('crypto')
const cloud = require('wx-server-sdk')
const { ApiError } = require('./lib/errors')
const validate = require('./lib/validate')
const auth = require('./lib/auth')
const rateLimit = require('./lib/rate-limit')
const venues = require('./lib/venues')
const venueEntry = require('./lib/venue-entry')
const venuePhotos = require('./lib/venue-photos')
const matches = require('./lib/matches')
const coaches = require('./lib/coaches')
const coachBookings = require('./lib/coach-bookings')
const coachApplications = require('./lib/coach-applications')
const favorites = require('./lib/favorites')
const profile = require('./lib/profile')
const profileStats = require('./lib/profile-stats')
const appointments = require('./lib/appointments')
const messages = require('./lib/messages')
const videos = require('./lib/videos')
const avatar = require('./lib/avatar')
const safety = require('./lib/safety')
const admin = require('./lib/admin')
const files = require('./lib/files')
const uploads = require('./lib/uploads')
const players = require('./lib/players')
const friends = require('./lib/friends')
const { createTrace } = require('./lib/timing')
const { isPublicRead } = require('./lib/action-policy')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const API_VERSION = 2
const SUPPORTED_API_VERSIONS = [1, API_VERSION]
const RETIRED_FEED_ACTIONS = new Set([
  'friendUpdates.list', 'friendUpdates.get', 'friendUpdates.publish', 'friendUpdates.remove',
  'updateComments.list', 'updateComments.send'
])
let invoked = false

const routes = {
  bootstrap: auth.bootstrap,
  'venues.list': venues.list,
  'venues.nearby': venues.nearby,
  'venues.get': venues.get,
  'venues.create': venueEntry.create,
  'venues.submissions.list': venueEntry.listMine,
  'venues.submissions.get': venueEntry.getMine,
  'venues.submissions.resubmit': venueEntry.resubmit,
  'venuePhotos.list': venuePhotos.list,
  'venuePhotos.register': venuePhotos.register,
  'venuePhotos.remove': venuePhotos.remove,
  'admin.venuePhotos.pending': venuePhotos.pending,
  'admin.venuePhotos.review': venuePhotos.review,
  'admin.venuePhotos.remove': venuePhotos.removeAsAdmin,
  'matches.list': matches.list,
  'matches.get': matches.get,
  'matches.create': matches.create,
  'matches.update': matches.update,
  'matches.join': matches.join,
  'matches.pending': matches.pending,
  'matches.respondJoin': matches.respondJoin,
  'matches.cancel': matches.cancel,
  'matches.reschedule': matches.reschedule,
  'matches.confirmSchedule': matches.confirmSchedule,
  'coaches.list': coaches.list,
  'coaches.get': coaches.get,
  'coachBookings.create': coachBookings.create,
  'coachBookings.cancel': coachBookings.cancel,
  'coachApplications.get': coachApplications.getMine,
  'coachApplications.submit': coachApplications.submit,
  'appointments.list': appointments.list,
  'favorites.list': favorites.list,
  'favorites.status': favorites.status,
  'favorites.set': favorites.set,
  'profile.get': profile.get,
  'profile.stats.get': profileStats.get,
  'players.get': players.get,
  'friends.list': friends.list,
  'profile.update': profile.update,
  'profile.avatar.status': avatar.status,
  'profile.avatar.register': avatar.register,
  'profile.avatar.retry': avatar.retry,
  'profile.avatar.remove': avatar.remove,
  'messages.list': messages.list,
  'messages.send': messages.send,
  'messages.inbox': messages.inbox,
  'messages.read': messages.read,
  'videos.list': videos.list,
  'videos.register': videos.register,
  'videos.remove': videos.remove,
  'safety.block': safety.setBlock,
  'safety.blocks.list': safety.listBlocks,
  'safety.report': safety.report,
  'account.delete': safety.deleteAccount,
  'admin.venues.upsert': admin.upsertVenue,
  'admin.venues.list': admin.listVenues,
  'admin.venues.remove': admin.removeVenue,
  'admin.venueSubmissions.pending': venueEntry.pending,
  'admin.venueSubmissions.get': venueEntry.getForAdmin,
  'admin.venueSubmissions.review': venueEntry.review,
  'admin.coaches.upsert': admin.upsertCoach,
  'admin.coaches.list': admin.listCoaches,
  'admin.coaches.remove': admin.removeCoach,
  'admin.coachSlots.upsert': admin.upsertCoachSlot,
  'admin.coachApplications.pending': coachApplications.pending,
  'admin.coachApplications.get': coachApplications.getForAdmin,
  'admin.coachApplications.review': coachApplications.review,
  'admin.videos.pending': admin.pendingVideos,
  'admin.videos.review': admin.reviewVideo,
  'files.resolve': files.resolve,
  'files.prepareUpload': uploads.prepare
}

function safeRequestId(value) {
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value)) return value
  return crypto.randomUUID()
}

function publicError(error, requestId) {
  if (error instanceof ApiError) {
    return {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details || null },
      requestId
    }
  }
  console.error('UNHANDLED_API_ERROR', requestId, error)
  return {
    ok: false,
    error: { code: 'INTERNAL', message: '服务暂时不可用，请稍后重试', details: null },
    requestId
  }
}

exports.main = async (event = {}) => {
  const requestId = safeRequestId(event.requestId)
  const trace = createTrace()
  const firstInvocation = !invoked
  invoked = true
  let routeName = 'invalid'
  let resultCode = 'OK'
  try {
    if (event.requestId !== requestId) throw new ApiError('INVALID_REQUEST_ID', '请求 ID 缺失或格式不正确')
    const requestedApiVersion = Number(event.apiVersion)
    if (!SUPPORTED_API_VERSIONS.includes(requestedApiVersion)) {
      const message = requestedApiVersion > API_VERSION
        ? '服务正在更新，请稍后重试'
        : '客户端版本过旧，请更新小程序'
      throw new ApiError('API_VERSION_UNSUPPORTED', message, { supportedVersion: API_VERSION })
    }
    const action = validate.text(event.action, '操作名称', { min: 2, max: 60 })
    if (RETIRED_FEED_ACTIONS.has(action)) {
      routeName = action
      throw new ApiError('FEATURE_REMOVED', '动态与公开回复已下线，请使用球局邀约')
    }
    const handler = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null
    if (!handler) throw new ApiError('ACTION_NOT_FOUND', '请求的操作不存在')
    routeName = action
    const payload = event.payload === undefined ? {} : validate.plainObject(event.payload)
    const wxContext = cloud.getWXContext()
    const context = {
      cloud,
      db,
      command: db.command,
      wxContext,
      action,
      apiVersion: requestedApiVersion,
      requestId,
      serverDate: () => db.serverDate()
    }
    const identityOptions = action === 'bootstrap' ? {
      allowCreate: true,
      consentAccepted: payload.consentAccepted,
      consentVersion: payload.consentVersion
    } : action === 'account.delete' ? {
      allowClosed: true,
      skipConsentCheck: true
    } : {}
    await trace.measure('identity', () => {
      if (event.publicRead === true && isPublicRead(action)) return auth.attachPublicIdentity(context)
      return auth.requireIdentity(context, identityOptions)
    })
    if (!(action === 'account.delete' && context.user.status === 'deleted')) {
      await trace.measure('rateLimit', () => rateLimit.consume(context, action))
    }
    const data = await trace.measure('handler', () => handler(context, payload))
    return { ok: true, data, requestId }
  } catch (error) {
    resultCode = error instanceof ApiError ? error.code : 'INTERNAL'
    return publicError(error, requestId)
  } finally {
    trace.finish({ action: routeName, requestId, code: resultCode, firstInvocation })
  }
}
