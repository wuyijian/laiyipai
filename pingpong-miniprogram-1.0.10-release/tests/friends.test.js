const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
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
assert.strictEqual(typeof definition.openPlayer, 'function')
assert.strictEqual(definition.loadUpdates, undefined)
assert.strictEqual(definition.submitUpdate, undefined)

const template = fs.readFileSync(path.join(root, 'pages/friends/friends.wxml'), 'utf8')
assert(template.includes('同一场球局后自动记录'))
assert(!/(发布动态|球友动态|心得技巧|公开回复)/.test(template))

console.log('same-match friends page tests passed')
