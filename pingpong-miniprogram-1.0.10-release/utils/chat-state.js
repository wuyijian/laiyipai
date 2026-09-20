const present = require('./present')

function timeOf(message) {
  const value = present.jsDate(message.createdAt)
  return value ? value.getTime() : 0
}

function mergeMessages(previous, incoming) {
  const byId = new Map(previous.map((item) => [item.id, item]))
  incoming.forEach((item) => byId.set(item.id, Object.assign({}, byId.get(item.id), item)))
  return Array.from(byId.values()).sort((a, b) => timeOf(a) - timeOf(b) || String(a.id).localeCompare(String(b.id)))
}

// Refresh the authoritative latest page, but retain loaded history and sends
// completed after this fetch began. Removed/blocked messages in this window drop out.
function reconcileMessages(previous, incoming, cursor, sentSinceFetch = []) {
  const boundary = cursor ? timeOf({ createdAt: cursor }) : 0
  const retained = previous.filter((item) => (boundary && timeOf(item) < boundary) || sentSinceFetch.includes(item.id))
  return mergeMessages(retained, incoming)
}

function decorateMessages(messages, avatarUrls = {}, hostId = '') {
  let previousTime = 0
  return messages.map((raw, index) => {
    const item = present.message(raw)
    const sender = item.sender || {}
    const time = timeOf(item)
    const showTime = Boolean(time && (index === 0 || time - previousTime >= 5 * 60000))
    previousTime = time || previousTime
    return Object.assign({}, item, {
      avatarUrl: avatarUrls[sender.avatarFileId] || sender.avatarUrl || '',
      avatarSeed: sender.playerId || item.senderName,
      isHost: Boolean(hostId && sender.playerId === hostId),
      showTime,
      timeLabel: present.fullDateTime(item.createdAt)
    })
  })
}

function arrangement(raw, membership, confirmedCount, venue) {
  const value = present.match(raw)
  const place = venue || present.venue(raw.venue || {})
  const scheduleVersion = Number(value.scheduleVersion || 1)
  const canArrange = ['recruiting', 'full', 'changed'].includes(value.status) &&
    (!value.startAt || new Date(value.startAt).getTime() > Date.now())
  const isHost = membership.status === 'host'
  return Object.assign(value, {
    address: place.address,
    venueLocationText: place.locationText,
    venueActivityTags: place.activityTags,
    hasLocation: place.hasLocation,
    location: place.location,
    isHost,
    canArrange,
    scheduleChanged: scheduleVersion > 1,
    myScheduleConfirmed: Number(membership.confirmedScheduleVersion || 0) >= scheduleVersion,
    needsConfirmation: canArrange && Number(membership.confirmedScheduleVersion || 0) < scheduleVersion,
    confirmedCount: Number(confirmedCount || 0),
    cancelPolicyText: isHost
      ? '取消后球局将关闭，所有人的预约状态都会更新。已支付的费用需与收款方协商。'
      : '取消后会释放你的名额；已在线下支付的费用请与收款方协商。'
  })
}

module.exports = { mergeMessages, reconcileMessages, decorateMessages, arrangement }
