const matchOptions = require('./match-options')
const { VENUE_ACTIVITY_TAGS } = require('./constants')

function venueActivityTags(document) {
  const source = Array.isArray(document.activityTags) ? document.activityTags : document.tags
  return Array.from(new Set((Array.isArray(source) ? source : []).filter((tag) => VENUE_ACTIVITY_TAGS.includes(tag))))
}

function userProfile(user) {
  const profile = user && user.profile || {}
  return {
    playerId: user && user.publicId || '',
    nickname: profile.nickname || '新球友',
    // Player avatars are generated locally from playerId in the review build.
    // Do not expose historical uploaded media or trigger an extra URL resolve.
    avatarFileId: '',
    city: profile.city || '杭州',
    district: profile.district || '',
    ballAge: profile.ballAge || '未填写',
    skills: Array.isArray(profile.skills) ? profile.skills : [],
    ratingPlatform: profile.ratingPlatform || '未填写',
    ratingValue: profile.ratingValue || '',
    completedMatches: Number(user && user.completedMatches || 0),
    punctualityRate: Number(user && user.completedMatches || 0) > 0 ? Number(user.punctualityRate || 0) : null
  }
}

function playerSnapshot(user) {
  const profile = userProfile(user)
  return {
    playerId: user.publicId || '',
    displayName: profile.nickname,
    avatarFileId: '',
    ballAge: profile.ballAge,
    skills: profile.skills.slice(0, 3),
    ratingPlatform: profile.ratingPlatform,
    ratingValue: profile.ratingValue
  }
}

function venue(document, distanceMeters) {
  const listingMode = document.listingMode === 'name_only' ? 'name_only' : 'full'
  const nameOnly = listingMode === 'name_only'
  const result = {
    id: document._id,
    name: document.name,
    city: document.city,
    district: nameOnly ? '' : document.district || '',
    address: nameOnly ? '' : document.address || '',
    location: nameOnly ? null : document.location || null,
    coverFileIds: Array.from(new Set((nameOnly ? [] : Array.isArray(document.coverFileIds) ? document.coverFileIds : [])
      .concat(Array.isArray(document.photoFileIds) ? document.photoFileIds : []))),
    phone: nameOnly ? '' : document.phone || '',
    openingHours: nameOnly ? '' : document.openingHours || '',
    bookingTip: nameOnly ? '' : document.bookingTip || '',
    tags: nameOnly ? [] : Array.isArray(document.tags) ? document.tags : [],
    activityTags: venueActivityTags(document),
    facilityTags: nameOnly ? [] : Array.isArray(document.facilityTags) ? document.facilityTags : [],
    listingMode,
    nameOnly,
    userContributed: document.source === 'community',
    verified: !nameOnly && document.verificationStatus === 'verified',
    verificationDate: nameOnly ? '' : document.verificationDate || '',
    partnerVerified: !nameOnly && document.partnerVerified === true,
    updatedAt: document.updatedAt
  }
  if (Number.isFinite(distanceMeters)) result.distanceMeters = Math.round(distanceMeters)
  return result
}

function participant(snapshot) {
  if (!snapshot) return null
  return {
    playerId: snapshot.playerId || '',
    displayName: snapshot.displayName || '球友',
    avatarFileId: '',
    ballAge: snapshot.ballAge || '未填写',
    skills: Array.isArray(snapshot.skills) ? snapshot.skills : [],
    ratingPlatform: snapshot.ratingPlatform || '未填写',
    ratingValue: snapshot.ratingValue || ''
  }
}

function match(document) {
  const venueSnapshot = document.venueSnapshot || {}
  const venueNameOnly = venueSnapshot.listingMode === 'name_only'
  const practiceIntent = matchOptions.normalizeStoredPracticeIntent(document.practiceIntent, document.skills)
  return {
    id: document._id,
    title: document.title,
    city: document.city,
    district: document.district,
    venueId: document.venueId,
    venue: venueSnapshot.id ? {
      id: venueSnapshot.id,
      name: venueSnapshot.name,
      address: venueNameOnly ? '' : venueSnapshot.address || '',
      location: venueNameOnly ? null : venueSnapshot.location || null,
      listingMode: venueNameOnly ? 'name_only' : 'full'
    } : null,
    date: document.date,
    startTime: document.startTime,
    endTime: document.endTime,
    startAt: document.startAt,
    endAt: document.endAt,
    capacity: Number(document.capacity || 0),
    participantCount: Number(document.participantCount || 0),
    seats: Math.max(0, Number(document.capacity || 0) - Number(document.participantCount || 0)),
    waitlistCount: Number(document.waitlistCount || 0),
    participants: (document.participants || []).map(participant).filter(Boolean),
    host: participant(document.hostSnapshot),
    expectedBallAge: document.expectedBallAge || '不限球龄',
    practiceIntent,
    practiceIntentLabel: practiceIntent,
    skills: Array.isArray(document.skills) ? document.skills : [],
    feePerPerson: Number(document.feePerPerson || 0),
    fee: `¥${Number(document.feePerPerson || 0)}/人`,
    courtStatus: document.courtStatus || 'unbooked',
    courtBookingNote: document.courtBookingNote || '',
    note: document.note || '',
    joinMode: document.joinMode,
    status: document.status,
    scheduleVersion: Number(document.scheduleVersion || 1),
    version: Number(document.version || 1),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  }
}

function coach(document) {
  return {
    id: document._id,
    name: document.name,
    avatarFileId: document.avatarFileId || '',
    city: document.city,
    district: document.district,
    venueIds: Array.isArray(document.venueIds) ? document.venueIds : [],
    specialty: Array.isArray(document.specialty) ? document.specialty : [],
    introduction: document.introduction || '',
    experienceYears: Number(document.experienceYears || 0),
    qualification: document.qualification || '',
    rating: Number(document.rating || 0),
    completedSessions: Number(document.completedSessions || 0),
    verified: document.verificationStatus === 'verified',
    verificationDate: document.verificationDate || ''
  }
}

function booking(document) {
  const coachSnapshot = document.coachSnapshot || {}
  const venueSnapshot = document.venueSnapshot || {}
  return {
    id: document._id,
    coachId: document.coachId,
    coach: coachSnapshot.id ? { id: coachSnapshot.id, name: coachSnapshot.name, avatarFileId: coachSnapshot.avatarFileId || '' } : null,
    slotId: document.slotId,
    venue: venueSnapshot.id ? { id: venueSnapshot.id, name: venueSnapshot.name, address: venueSnapshot.address } : null,
    startAt: document.startAt,
    endAt: document.endAt,
    price: Number(document.price || 0),
    status: document.status,
    cancellationReason: document.status === 'cancelled' ? document.cancellationReason || '' : '',
    version: Number(document.version || 1),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  }
}

function message(document, actorId) {
  return {
    id: document._id,
    matchId: document.matchId,
    type: document.type,
    text: document.text,
    sender: participant(document.senderSnapshot),
    mine: Boolean(document.senderId && document.senderId === actorId),
    createdAt: document.createdAt
  }
}

module.exports = { userProfile, playerSnapshot, player: participant, venue, match, coach, booking, message }
