const api = require('./api')

const POLL_INTERVAL_MS = 15000
const RECOVERY_POLL_INTERVAL_MS = 800
let running = false
let polling = false
let timer = null
let generation = 0
let modalVisible = false
let activeMatchId = ''
const announced = new Set()
const readByMatch = Object.create(null)
const listeners = new Set()
let inboxState = { unreadCount: 0, items: [] }
let nextPollDelay = POLL_INTERVAL_MS
let recoveryPollAttempts = 0

function sessionReady() {
  try {
    const app = getApp()
    return Boolean(app && app.globalData && app.globalData.session)
  } catch (_) {
    return false
  }
}

function updateBadge(count) {
  // “我的”是第 4 个主导航。原实现写到了“预约”(index 2)，并且
  // wx.setTabBarBadge 对 custom tabBar 不生效；原生调用仅作为兼容兜底，
  // 真正的自定义角标由下面的订阅状态驱动。
  if (count > 0 && typeof wx.setTabBarBadge === 'function') {
    wx.setTabBarBadge({ index: 3, text: count > 99 ? '99+' : String(count), fail() {} })
  } else if (count === 0 && typeof wx.removeTabBarBadge === 'function') {
    wx.removeTabBarBadge({ index: 3, fail() {} })
  }
}

function snapshot() {
  return {
    unreadCount: inboxState.unreadCount,
    items: inboxState.items.slice()
  }
}

function publishInbox(result = {}) {
  const items = Array.isArray(result.items) ? result.items.filter(Boolean) : []
  const unreadCount = Math.max(0, Number(result.unreadCount || 0))
  inboxState = { unreadCount, items }
  updateBadge(unreadCount)
  const value = snapshot()
  listeners.forEach((listener) => {
    try { listener(value) } catch (_) {}
  })
  return value
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  try { listener(snapshot()) } catch (_) {}
  return () => listeners.delete(listener)
}

function schedule(delay = POLL_INTERVAL_MS) {
  if (!running) return
  clearTimeout(timer)
  const token = generation
  timer = setTimeout(() => {
    timer = null
    poll(token).finally(() => {
      if (running && token === generation) schedule(nextPollDelay)
    })
  }, delay)
  if (timer && typeof timer.unref === 'function') timer.unref()
}

function recommendedPollDelay(result = {}, attempt = 1) {
  if (result.recoveryPending !== true) return POLL_INTERVAL_MS
  return Math.min(POLL_INTERVAL_MS, RECOVERY_POLL_INTERVAL_MS * (2 ** Math.max(0, Number(attempt || 1) - 1)))
}

function noticeText(item) {
  const match = item.match || {}
  const sender = item.sender || {}
  const schedule = [match.date, match.startTime].filter(Boolean).join(' ')
  return [
    `${sender.displayName || '球友'}：${item.preview || '发来一条新消息'}`,
    [schedule, match.venueName].filter(Boolean).join(' · ')
  ].filter(Boolean).join('\n').slice(0, 180)
}

function showNotice(item) {
  if (!item || modalVisible || typeof wx.showModal !== 'function') return false
  announced.add(item.messageId)
  modalVisible = true
  wx.showModal({
    title: item.unreadCount > 1 ? `球局沟通 · ${item.unreadCount} 条新消息` : '球局沟通有新消息',
    content: noticeText(item),
    confirmText: '查看消息',
    cancelText: '稍后',
    success(result) {
      if (result && result.confirm && item.matchId) {
        wx.navigateTo({ url: `/pages/chat/chat?id=${encodeURIComponent(item.matchId)}` })
      }
    },
    complete() { modalVisible = false }
  })
  return true
}

async function poll(token = generation) {
  if (!running || polling || token !== generation || !sessionReady()) return false
  polling = true
  nextPollDelay = POLL_INTERVAL_MS
  try {
    const result = await api.messages.inbox({ pageSize: 10 })
    if (!running || token !== generation) return false
    publishInbox(result)
    const recovering = result.recoveryPending === true
    recoveryPollAttempts = recovering ? recoveryPollAttempts + 1 : 0
    nextPollDelay = recommendedPollDelay(result, recoveryPollAttempts)
    const items = result.items || []
    for (const item of items) {
      if (item.matchId === activeMatchId) {
        markRead(item.matchId, item.messageId)
        continue
      }
      if (!announced.has(item.messageId) && showNotice(item)) break
    }
    return true
  } catch (_) {
    return false
  } finally {
    polling = false
  }
}

function start() {
  if (!sessionReady()) return false
  if (running) return true
  running = true
  generation += 1
  schedule(1200)
  return true
}

function stop() {
  running = false
  generation += 1
  clearTimeout(timer)
  timer = null
}

function reset() {
  stop()
  announced.clear()
  Object.keys(readByMatch).forEach((key) => delete readByMatch[key])
  activeMatchId = ''
  modalVisible = false
  nextPollDelay = POLL_INTERVAL_MS
  recoveryPollAttempts = 0
  publishInbox({ unreadCount: 0, items: [] })
}

function setActiveMatch(matchId = '') {
  activeMatchId = String(matchId || '')
}

async function markRead(matchId, messageId) {
  const safeMatchId = String(matchId || '')
  const safeMessageId = String(messageId || '')
  if (!safeMatchId || !safeMessageId || readByMatch[safeMatchId] === safeMessageId) return false
  readByMatch[safeMatchId] = safeMessageId
  announced.add(safeMessageId)
  try {
    const result = await api.messages.read({ matchId: safeMatchId, messageId: safeMessageId })
    if (result && result.read) {
      const item = inboxState.items.find((entry) => entry && entry.matchId === safeMatchId)
      if (item) {
        publishInbox({
          unreadCount: Math.max(0, inboxState.unreadCount - Math.max(1, Number(item.unreadCount || 1))),
          items: inboxState.items.filter((entry) => !entry || entry.matchId !== safeMatchId)
        })
      }
      if (running) schedule(300)
      return true
    }
  } catch (_) {}
  if (readByMatch[safeMatchId] === safeMessageId) delete readByMatch[safeMatchId]
  return false
}

module.exports = {
  start,
  stop,
  reset,
  poll,
  setActiveMatch,
  markRead,
  subscribe,
  getSnapshot: snapshot,
  _private: { noticeText, showNotice, updateBadge, publishInbox, recommendedPollDelay, POLL_INTERVAL_MS, RECOVERY_POLL_INTERVAL_MS }
}
