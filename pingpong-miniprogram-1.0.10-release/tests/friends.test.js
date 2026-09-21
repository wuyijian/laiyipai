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
assert.strictEqual(typeof definition.loadFriends, 'function')
assert.strictEqual(definition.loadUpdates, undefined)
assert.strictEqual(definition.submitUpdate, undefined)
assert.strictEqual(typeof definition.openPlayer, 'function')

console.log('friends page tests passed')
