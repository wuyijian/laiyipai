function timestamp(value) {
  if (value instanceof Date) return value.getTime()
  if (value && typeof value === 'object') {
    if (value.$date !== undefined) return new Date(value.$date).getTime()
    if (Number.isFinite(value._seconds)) return value._seconds * 1000
  }
  return new Date(value).getTime()
}

function detailState(match, membership) {
  const status = membership && membership.status || ''
  const closed = ['started', 'cancelled', 'completed'].includes(match.status)
  const isHost = status === 'host'
  const startAt = match.startAt && timestamp(match.startAt)
  const canEdit = Boolean(isHost && !closed && Number.isFinite(startAt) && startAt > Date.now())
  const joined = ['host', 'joined'].includes(status)
  const canChat = Boolean(joined && match.capacity > 1 && membership.canChat)
  const needsConfirmation = Boolean(!closed && status === 'joined' &&
    Number(match.scheduleVersion) > Number(membership.confirmedScheduleVersion))
  const hasReservation = joined || ['pending', 'waitlisted'].includes(status)
  let actionKind = 'join'
  let actionText = match.seats > 0 ? (match.joinMode === 'confirm' ? '申请加入' : '加入球局') : '加入候补'
  let statusTitle = ''
  let statusCopy = ''
  let actionHint = match.seats === 0 ? '满员后可候补，名额需另行确认' : match.joinMode === 'confirm' ? '发起人同意后，名额才会确认' : '确认加入后，即可沟通球台和时间'
  let statusTone = 'neutral'
  if (closed) {
    actionKind = hasReservation ? 'orders' : 'home'
    actionText = hasReservation ? '查看预约记录' : '找其他球局'
    statusTitle = match.statusLabel
    statusCopy = '当前球局已停止接受加入。'
    actionHint = match.statusLabel
  } else if (needsConfirmation) {
    actionKind = 'confirm'
    actionText = '确认新时间'
    statusTitle = '时间有调整，请确认是否能来'
    statusCopy = '下方已显示最新时间，不方便参加可在预约中取消。'
    actionHint = '确认后，发起人会看到你的最新状态'
    statusTone = 'attention'
  } else if (isHost) {
    actionKind = 'orders'
    actionText = match.capacity === 1 ? '管理我的练习' : '管理球局'
    statusTitle = '这是你发起的球局'
    statusCopy = match.capacity === 1 ? '单人练习不接受其他球友加入。' : '在预约中处理申请、确认安排或取消球局。'
    actionHint = match.capacity === 1 ? '已记录这次单人练习' : `${match.participantCount} 人已加入，含你自己`
  } else if (joined) {
    actionKind = canChat ? 'chat' : 'orders'
    actionText = canChat ? '打开球局沟通' : '查看预约状态'
    statusTitle = '你已加入，名额已确认'
    statusCopy = canChat ? '到馆前，在球局对话里确认球台和集合时间。' : '最新安排可在预约中查看。'
    actionHint = canChat ? '有变化及时说一声，大家都好安排' : '名额已确认'
    statusTone = 'success'
  } else if (status === 'pending' || status === 'waitlisted') {
    actionKind = 'orders'
    actionText = status === 'pending' ? '查看申请状态' : '查看候补状态'
    statusTitle = status === 'pending' ? '申请已发送，等待发起人确认' : '你已加入候补'
    statusCopy = '名额尚未确认，可在预约中查看进度或取消。'
    actionHint = '无需重复提交'
    statusTone = 'attention'
  } else if (match.capacity === 1) {
    actionKind = 'none'
    actionText = '单人练习'
    actionHint = '这是一场不开放加入的个人练习'
  }
  const [startHour, startMinute] = String(match.startTime || '').split(':').map(Number)
  const [endHour, endMinute] = String(match.endTime || '').split(':').map(Number)
  const minutes = (endHour - startHour) * 60 + endMinute - startMinute
  const durationLabel = Number.isFinite(minutes) && minutes > 0
    ? minutes % 60 === 0 ? `${minutes / 60} 小时` : minutes > 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`
    : ''
  const visibleParticipants = (match.participants || []).slice(0, 8)
  const seatSlots = visibleParticipants.map((item, index) => Object.assign({}, item, { key: item.playerId || `member-${index}`, empty: false }))
  // Unknown member details must not be represented as available places.
  const anonymousCount = Math.max(0, Math.min(8, match.participantCount) - seatSlots.length)
  for (let index = 0; index < anonymousCount; index += 1) seatSlots.push({ key: `private-${index}`, private: true, displayName: '已加入' })
  const openSlots = closed ? 0 : Math.max(0, Math.min(match.seats, 8 - seatSlots.length))
  for (let index = 0; index < openSlots; index += 1) seatSlots.push({ key: `seat-${index}`, empty: true })
  return {
    isHost, canChat, canEdit, needsConfirmation, hasReservation, durationLabel, seatSlots,
    actionKind, actionText, actionDisabled: actionKind === 'none', actionHint,
    statusTitle, statusCopy, statusTone,
    shareable: ['recruiting', 'full', 'changed'].includes(match.status)
  }
}

module.exports = { detailState }
