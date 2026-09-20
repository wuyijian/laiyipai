const COLLECTIONS = Object.freeze({
  users: 'users',
  venues: 'venues',
  venueSubmissions: 'venue_submissions',
  matches: 'matches',
  matchMembers: 'match_members',
  playerFriends: 'player_friends',
  playerUpdates: 'player_updates',
  updateComments: 'player_update_comments',
  coaches: 'coaches',
  coachSlots: 'coach_slots',
  coachBookings: 'coach_bookings',
  coachApplications: 'coach_applications',
  venueFavorites: 'venue_favorites',
  messages: 'match_messages',
  messageInboxes: 'message_inboxes',
  userVideos: 'user_videos',
  userMedia: 'user_media',
  uploadTickets: 'upload_tickets',
  userBlocks: 'user_blocks',
  reports: 'reports',
  accountDeletionJobs: 'account_deletion_jobs',
  rateLimits: 'rate_limits',
  auditLogs: 'audit_logs'
})

const MATCH_ACTIVE_STATUSES = ['recruiting', 'full', 'changed']
const MEMBER_ACTIVE_STATUSES = ['host', 'joined']
const RATING_PLATFORMS = ['未填写', '开球网', 'ChinaTT', '其他平台']
const VENUE_ACTIVITY_TAGS = ['教学', '比赛', '训练', '切磋']
const HANGZHOU_DISTRICTS = ['全杭州', '滨江区', '萧山区', '上城区', '西湖区', '拱墅区', '余杭区', '临平区', '钱塘区', '富阳区', '临安区', '桐庐县', '淳安县', '建德市']

module.exports = {
  COLLECTIONS,
  MATCH_ACTIVE_STATUSES,
  MEMBER_ACTIVE_STATUSES,
  RATING_PLATFORMS,
  VENUE_ACTIVITY_TAGS,
  HANGZHOU_DISTRICTS
}
