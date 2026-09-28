const cloud = require('./cloud')
const config = require('./cloud-config')

function action(name) {
  return (payload = {}, options = {}) => cloud.call(name, payload, options)
}

module.exports = {
  init: cloud.init,
  invalidateReads: cloud.invalidateReads,
  diagnostics: require('./diagnostics'),
  createRequestId: cloud.createRequestId,
  bootstrap: (consentAccepted) => cloud.call('bootstrap', {
    consentAccepted: consentAccepted === true,
    consentVersion: config.privacyPolicyVersion
  }, { retry: true }),
  venues: {
    create: action('venues.create'),
    list: action('venues.list'),
    nearby: action('venues.nearby'),
    get: action('venues.get'),
    submissions: {
      list: action('venues.submissions.list'),
      get: action('venues.submissions.get'),
      resubmit: action('venues.submissions.resubmit')
    }
  },
  venuePhotos: {
    list: action('venuePhotos.list'),
    remove: action('venuePhotos.remove')
  },
  matches: {
    list: action('matches.list'),
    get: action('matches.get'),
    create: action('matches.create'),
    update: action('matches.update'),
    join: action('matches.join'),
    pending: action('matches.pending'),
    respondJoin: action('matches.respondJoin'),
    cancel: action('matches.cancel'),
    reschedule: action('matches.reschedule'),
    confirmSchedule: action('matches.confirmSchedule')
  },
  coaches: { list: action('coaches.list'), get: action('coaches.get') },
  coachBookings: {
    create: action('coachBookings.create'),
    cancel: action('coachBookings.cancel')
  },
  coachApplications: {
    get: action('coachApplications.get'),
    submit: action('coachApplications.submit')
  },
  appointments: { list: action('appointments.list') },
  favorites: {
    list: action('favorites.list'),
    status: action('favorites.status'),
    set: action('favorites.set')
  },
  profile: {
    get: action('profile.get'),
    stats: action('profile.stats.get'),
    update: action('profile.update'),
    uploadAvatar: cloud.uploadAvatar,
    avatarStatus: action('profile.avatar.status'),
    retryAvatar: action('profile.avatar.retry'),
    removeAvatar: action('profile.avatar.remove')
  },
  players: { get: action('players.get') },
  friends: { list: action('friends.list') },
  messages: {
    list: action('messages.list'),
    send: action('messages.send'),
    inbox: action('messages.inbox'),
    read: action('messages.read')
  },
  safety: {
    listBlocks: action('safety.blocks.list'),
    block: action('safety.block'),
    report: action('safety.report')
  },
  files: { resolve: cloud.resolveFileUrls },
  account: {
    delete: action('account.delete')
  },
  admin: {
    pendingVenueSubmissions: action('admin.venueSubmissions.pending'),
    getVenueSubmission: action('admin.venueSubmissions.get'),
    reviewVenueSubmission: action('admin.venueSubmissions.review'),
    pendingVenuePhotos: action('admin.venuePhotos.pending'),
    reviewVenuePhoto: action('admin.venuePhotos.review'),
    removeVenuePhoto: action('admin.venuePhotos.remove'),
    upsertVenue: action('admin.venues.upsert'),
    listVenues: action('admin.venues.list'),
    removeVenue: action('admin.venues.remove'),
    upsertCoach: action('admin.coaches.upsert'),
    listCoaches: action('admin.coaches.list'),
    removeCoach: action('admin.coaches.remove'),
    upsertCoachSlot: action('admin.coachSlots.upsert'),
    pendingCoachApplications: action('admin.coachApplications.pending'),
    getCoachApplication: action('admin.coachApplications.get'),
    reviewCoachApplication: action('admin.coachApplications.review')
  }
}
