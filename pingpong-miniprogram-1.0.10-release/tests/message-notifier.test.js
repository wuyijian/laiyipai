const assert = require('assert')
const fs = require('fs')
const path = require('path')

const calls = { inbox: 0, read: [], badges: [], modals: [], routes: [] }
let inboxUnread = true
let signedIn = true
const apiPath = require.resolve('../utils/api')
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    messages: {
      async inbox() {
        calls.inbox += 1
        if (!inboxUnread) return { unreadCount: 0, items: [] }
        return {
          unreadCount: 2,
          items: [{
            matchId: 'match_notice', messageId: 'message_notice', unreadCount: 2, preview: '我订好 3 号台了',
            sender: { displayName: '林小拍' },
            match: { title: '滨江晚场', date: '2030-01-01', startTime: '19:00', venueName: '萧潮乒乓球馆' }
          }]
        }
      },
      async read(payload) { calls.read.push(payload); inboxUnread = false; return { read: true } }
    }
  }
}

global.getApp = () => ({ globalData: { session: signedIn ? { profile: { playerId: 'player_me' } } : null } })
global.wx = {
  setTabBarBadge(options) { calls.badges.push(options) },
  removeTabBarBadge(options) { calls.badges.push(options) },
  showModal(options) { calls.modals.push(options) },
  navigateTo(options) { calls.routes.push(options.url) }
}

const notifier = require('../utils/message-notifier')

async function run() {
  const root = path.resolve(__dirname, '..')
  const tabTemplate = fs.readFileSync(path.join(root, 'custom-tab-bar/index.wxml'), 'utf8')
  const profileTemplate = fs.readFileSync(path.join(root, 'pages/profile/profile.wxml'), 'utf8')
  assert(tabTemplate.includes('index === 3 && messageUnreadCount'), '自定义 TabBar 的“我的”必须渲染未读角标')
  assert(tabTemplate.includes('class="message-badge"'))
  assert(profileTemplate.includes('球局消息'))
  assert(profileTemplate.includes('bindtap="openMessageConversation"'), '我的页应能按球局进入未读会话')
  assert.strictEqual(notifier._private.recommendedPollDelay({ recoveryPending: true }), 800, '清理失效指针后应短间隔继续推进')
  assert.strictEqual(notifier._private.recommendedPollDelay({ recoveryPending: true }, 6), 15000, '连续恢复失败必须退避，避免请求放大')
  assert.strictEqual(notifier._private.recommendedPollDelay({ items: Array(10).fill({}), hasMore: true, recoveryPending: false }), 15000, '只是预览分页时保持正常轮询，避免请求放大')

  const snapshots = []
  const unsubscribe = notifier.subscribe((state) => snapshots.push(state))
  assert.strictEqual(notifier.start(), true)
  assert.strictEqual(await notifier.poll(), true)
  assert.strictEqual(calls.inbox, 1)
  assert.strictEqual(calls.badges.at(-1).index, 3, '未读角标必须显示在“我的”')
  assert.strictEqual(calls.badges.at(-1).text, '2')
  assert.strictEqual(snapshots.at(-1).unreadCount, 2, '自定义 TabBar 应收到未读状态')
  assert.strictEqual(calls.modals.length, 1)
  assert(calls.modals[0].title.includes('2 条新消息'))
  assert(calls.modals[0].content.includes('林小拍：我订好 3 号台了'))
  calls.modals[0].success({ confirm: true })
  calls.modals[0].complete()
  assert.strictEqual(calls.routes[0], '/pages/chat/chat?id=match_notice')

  assert.strictEqual(await notifier.markRead('match_notice', 'message_notice'), true)
  assert.deepStrictEqual(calls.read[0], { matchId: 'match_notice', messageId: 'message_notice' })
  assert.strictEqual(notifier.getSnapshot().unreadCount, 0, '进入会话后应即时扣减未读数')
  assert.strictEqual(notifier.getSnapshot().items.length, 0)
  assert.strictEqual(await notifier.markRead('match_notice', 'message_notice'), false, '同一条消息不得重复提交已读')

  notifier.setActiveMatch('match_notice')
  assert.strictEqual(await notifier.poll(), true)
  assert.strictEqual(calls.modals.length, 1, '当前正在查看的球局不得再次弹窗')
  notifier.reset()
  signedIn = false
  assert.strictEqual(notifier.start(), false, '未登录时不应启动消息请求')
  assert.strictEqual(await notifier.poll(), false, '未登录时轮询应安静跳过')
  unsubscribe()
  console.log('message notifier tests passed')
}

run().catch((error) => { notifier.reset(); console.error(error); process.exitCode = 1 })
