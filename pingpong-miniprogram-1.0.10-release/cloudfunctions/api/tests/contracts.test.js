const assert = require('assert')
const validate = require('../lib/validate')
const presenters = require('../lib/presenters')
const { stableId } = require('../lib/database')

const schedule = validate.schedule('2099-05-01', '19:00', '21:00')
assert(schedule.startAt < schedule.endAt)
assert.strictEqual(validate.timestamp({ _seconds: 1700000000 }).getTime(), 1700000000000)
assert.strictEqual(validate.timestamp({ $date: '2030-01-02T03:04:05.000Z' }).toISOString(), '2030-01-02T03:04:05.000Z')

const profilePatch = validate.profilePatch({
  nickname: '小拍',
  role: 'admin',
  avatarFileId: 'cloud://bypass',
  videoFileIds: ['cloud://bypass']
})
assert.deepStrictEqual(profilePatch, { nickname: '小拍' })

const publicProfile = presenters.userProfile({
  publicId: 'player-profile',
  profile: { nickname: '球友', videoFileIds: ['cloud://legacy/video.mp4'] }
})
assert.strictEqual(publicProfile.videoFileIds, undefined)

const publicMatch = presenters.match({
  _id: 'match-id',
  hostId: 'private-openid',
  participantIds: ['private-openid'],
  hostSnapshot: { playerId: 'player-id', displayName: '球友' },
  participants: [{ playerId: 'player-id', displayName: '球友' }],
  venueSnapshot: {
    id: 'venue-id',
    name: '球馆',
    address: '地址',
    location: { longitude: 120.1551, latitude: 30.2741 },
    listingMode: 'full',
    internalNote: 'private'
  },
  capacity: 4,
  participantCount: 1,
  feePerPerson: 30,
  cancellationReason: '私人原因',
  version: 1,
  scheduleVersion: 1
})
assert.strictEqual(publicMatch.seats, 3)
assert.strictEqual(publicMatch.cancellationReason, undefined)
assert.strictEqual(publicMatch.hostId, undefined)
assert.strictEqual(publicMatch.participantIds, undefined)
assert.strictEqual(publicMatch.venue.internalNote, undefined)
assert.deepStrictEqual(publicMatch.venue.location, { longitude: 120.1551, latitude: 30.2741 })
assert.strictEqual(publicMatch.venue.listingMode, 'full')
assert.strictEqual(publicMatch.practiceIntent, '随便练练')
assert.strictEqual(publicMatch.practiceIntentLabel, '随便练练')

const legacyCompetitiveMatch = presenters.match({ skills: ['基本功', '实战对抗'] })
assert.strictEqual(legacyCompetitiveMatch.practiceIntent, '切磋球技')

const explicitCompetitiveMatch = presenters.match({ practiceIntent: '切磋球技', skills: ['基本功'] })
assert.strictEqual(explicitCompetitiveMatch.practiceIntentLabel, '切磋球技')

const publicVenue = presenters.venue({
  _id: 'venue-id',
  name: '萧潮乒乓球俱乐部',
  activityTags: ['教学', '比赛', '训练', '切磋', '内部标签'],
  sourceUrls: ['https://internal.example.com'],
  partnershipReference: 'private-reference'
})
assert.deepStrictEqual(publicVenue.activityTags, ['教学', '比赛', '训练', '切磋'])
assert.strictEqual(publicVenue.sourceUrls, undefined)
assert.strictEqual(publicVenue.partnershipReference, undefined)

const legacyVenueTags = presenters.venue({ tags: ['公共体育场馆', '切磋', '切磋'] })
assert.deepStrictEqual(legacyVenueTags.activityTags, ['切磋'])

const nameOnlyVenue = presenters.venue({
  _id: 'venue-name-only',
  name: '桂语朝阳乒乓球室',
  listingMode: 'name_only',
  activityTags: ['切磋'],
  address: '不应公开的地址',
  location: { longitude: 120, latitude: 30 },
  phone: '10086',
  verificationStatus: 'verified',
  partnerVerified: true
})
assert.strictEqual(nameOnlyVenue.listingMode, 'name_only')
assert.strictEqual(nameOnlyVenue.nameOnly, true)
assert.strictEqual(nameOnlyVenue.address, '')
assert.strictEqual(nameOnlyVenue.location, null)
assert.strictEqual(nameOnlyVenue.phone, '')
assert.strictEqual(nameOnlyVenue.verified, false)
assert.strictEqual(nameOnlyVenue.partnerVerified, false)

const nameOnlyMatch = presenters.match({
  venueSnapshot: {
    id: 'venue-name-only',
    name: '名称球馆',
    address: '不应公开的地址',
    location: { longitude: 120, latitude: 30 },
    listingMode: 'name_only'
  }
})
assert.strictEqual(nameOnlyMatch.venue.address, '')
assert.strictEqual(nameOnlyMatch.venue.location, null)
assert.strictEqual(nameOnlyMatch.venue.listingMode, 'name_only')

const fullVenue = presenters.venue({ verificationStatus: 'verified', partnerVerified: true })
assert.strictEqual(fullVenue.listingMode, 'full')
assert.strictEqual(fullVenue.nameOnly, false)
assert.strictEqual(fullVenue.verified, true)
assert.strictEqual(fullVenue.partnerVerified, true)

assert.strictEqual(stableId('a', 'b'), stableId('a', 'b'))
assert.notStrictEqual(stableId('a', 'b'), stableId('a', 'c'))

console.log('cloud-api-contract-tests-ok')
