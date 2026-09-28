const assert = require('assert')
const validate = require('../lib/validate')
const presenters = require('../lib/presenters')
const profile = require('../lib/profile')
const players = require('../lib/players')
const { normalize } = require('../lib/player-levels')
const value = { handedness: '左手', grip: '横板', rubber: '两面反胶', styles: ['控制型'], strengths: ['落点精准'], habits: [], abilities: { fh_drive: 4, placement_lines: 3 } }
assert.deepStrictEqual(validate.profilePatch({ playingProfile: value }).playingProfile, value)
for (const bad of [null, [], { styles: ['控制型','正手主导','削球型'] }, { strengths: ['未知标签'] }, { abilities: { invented: 3 } }, { abilities: { fh_drive: 5 } }, { abilities: { fh_drive: '4' } }, { ratingStatus: 'verified' }]) {
  assert.throws(() => validate.profilePatch({ playingProfile: bad }), error => error.code === 'INVALID_ARGUMENT')
}
assert.deepStrictEqual(validate.profilePatch({ playingProfile: { abilities: { fh_drive: 0 } } }).playingProfile.abilities, {})
const timestamp = '2026-09-28T12:00:00.000Z'
const user = { _id: 'user', publicId: 'player', status: 'active', profile: { nickname: '球友', skills: ['旧技术'], ratingPlatform: '未填写', ratingValue: '' } }
let writes = 0, moderation = 'pass'
const context = {
  user, openid: 'user', serverDate: () => timestamp, command: { set: value => ({ replaceValue: value }) },
  cloud: { openapi: { security: { msgSecCheck: async () => ({ result: { suggest: moderation } }) } } },
  db: { runTransaction: work => work(context.db), collection(name) {
    return {
      doc() { return { get: async () => ({ data: user }), update: async ({ data }) => {
        writes++
        for (const [key, value] of Object.entries(data)) {
          if (key.startsWith('profile.')) user.profile[key.slice(8)] = value && Object.hasOwn(value, 'replaceValue') ? value.replaceValue : value
        }
      } } },
      add: async () => ({}), where() { return this }, limit() { return this }, get: async () => ({ data: [user] })
    }
  } }
}
async function run() {
  const updated = await profile.update(context, { playingProfile: value, ratingPlatform: '开球网', ratingValue: '1628', ratingStatus: 'verified', level: 'S+' })
  assert.strictEqual(updated.ratingStatus, 'self_reported')
  assert.strictEqual(updated.level, undefined)
  assert.strictEqual(updated.ratingUpdatedAt, timestamp)
  assert.deepStrictEqual(updated.playingProfile, value)
  await profile.update(context, { nickname: '新球友名' })
  assert.deepStrictEqual(user.profile.playingProfile, value, 'old clients preserve new fields')
  assert.strictEqual(user.profile.ratingUpdatedAt, timestamp)
  const publicPlayer = await players.get(context, { playerId: 'player' })
  assert.deepStrictEqual(publicPlayer.player.playingProfile, value)
  assert.strictEqual(publicPlayer.player.ratingStatus, 'self_reported')
  assert.strictEqual(publicPlayer.player.userId, undefined)
  await profile.update(context, { playingProfile: {} })
  assert.deepStrictEqual(user.profile.playingProfile, normalize())
  moderation = 'risky'
  const before = writes
  await assert.rejects(profile.update(context, { nickname: '需审核的文本' }), error => error.code === 'CONTENT_REJECTED')
  assert.strictEqual(writes, before)
  assert.strictEqual(presenters.userProfile({ profile: {} }).ratingStatus, 'self_reported')
  console.log('player levels cloud: validation, allowlist, persistence, public presentation and backward compatibility passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
