const assert = require('assert')

let definition
global.Page = value => { definition = value }
global.wx = {}

const modulePath = require.resolve('../pages/friends/friends.js')
delete require.cache[modulePath]
const exported = require(modulePath)

const presented = exported.presentFriend({
  player: {
    playerId: 'player-one',
    displayName: '林小拍',
    city: '杭州',
    district: '滨江区',
    ballAge: '球龄 2—5 年',
    skills: ['正手攻球', '反手拧拉', '发球', '多余技术']
  },
  matchCount: 3
})

assert.strictEqual(presented.relationshipText, '一起打过 3 场')
assert.strictEqual(presented.metaText, '杭州 · 滨江区 · 球龄 2—5 年')
assert.deepStrictEqual(presented.skills, ['正手攻球', '反手拧拉', '发球'])
const update = exported.presentUpdate({
  id: 'update-one',
  author: { playerId: 'player-two', displayName: '陈小拍' },
  district: '萧山区', date: '2099-05-01', startTime: '19:00', endTime: '20:30',
  ratingPlatform: '开球网', ratingValue: '1700'
})
assert.strictEqual(update.ratingText, '开球网 1700')
assert(update.scheduleText.includes('19:00—20:30'))
assert.strictEqual(typeof definition.loadFriends, 'function')
assert.strictEqual(typeof definition.loadUpdates, 'function')
assert.strictEqual(typeof definition.submitUpdate, 'function')
assert.strictEqual(typeof definition.openPlayer, 'function')

console.log('friends page tests passed')
