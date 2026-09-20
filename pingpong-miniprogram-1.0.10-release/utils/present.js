const dateUtil = require('./date')
const matchOptions = require('./match-options')
const geo = require('./geo')

const MATCH_STATUS_LABELS = {
  recruiting: '招募中',
  full: '已满员',
  changed: '时间有调整',
  started: '已开球',
  cancelled: '已取消',
  completed: '已结束'
}

const MEMBER_STATUS_LABELS = {
  host: '我发起的',
  joined: '已加入',
  pending: '待发起人确认',
  waitlisted: '候补中',
  rejected: '申请未通过',
  cancelled: '已取消',
  schedule_confirmation_required: '待确认新时间'
}

function jsDate(value) {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof value === 'object') {
    if (value.$date) return new Date(value.$date)
    if (Number.isFinite(value._seconds)) return new Date(value._seconds * 1000)
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function timeText(value) {
  const date = jsDate(value)
  if (!date) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function fullDateTime(value) {
  const date = jsDate(value)
  if (!date) return ''
  return `${date.getMonth() + 1}月${date.getDate()}日 ${timeText(date)}`
}

function durationText(startAt, endAt) {
  const start = jsDate(startAt)
  const end = jsDate(endAt)
  if (!start || !end) return ''
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000))
  return `${minutes} 分钟`
}

function money(value, suffix = '/人') {
  const amount = Number(value || 0)
  return amount > 0 ? `¥${amount}${suffix}` : '免费'
}

function textList(value) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value
    .map((item) => String(item || '').trim())
    .filter(Boolean)))
}

function player(raw = {}, hostId) {
  const skills = Array.isArray(raw.skills) ? raw.skills : []
  return Object.assign({}, raw, {
    displayName: raw.displayName || '球友',
    ballAge: raw.ballAge || '未填写球龄',
    skills,
    skillsText: skills.length ? ` · ${skills.join('、')}` : '',
    host: Boolean(hostId && raw.playerId === hostId),
    avatarUrl: raw.avatarUrl || ''
  })
}

function match(raw = {}) {
  const capacity = Number(raw.capacity || 0)
  const participantCount = Number(raw.participantCount || 0)
  const seats = Math.max(0, Number(raw.seats !== undefined ? raw.seats : capacity - participantCount))
  const soloPractice = capacity === 1
  const host = player(raw.host)
  const participants = (raw.participants || []).map((item) => player(item, host.playerId))
  const courtStatus = raw.courtStatus || 'unbooked'
  const courtBooked = courtStatus === 'booked'
  const joinSheetTitle = seats === 0 ? '加入候补' : raw.joinMode === 'confirm' ? '申请加入' : '加入球局'
  const joinSheetCopy = seats === 0
    ? '提交后进入候补，尚未获得名额，也不能进入球局对话。'
    : raw.joinMode === 'confirm'
      ? '提交的是加入申请，发起人同意后才会获得名额并进入球局对话。'
      : '提交时会再次确认名额，名额确认后即可进入球局对话。'
  const practiceIntent = matchOptions.normalizePracticeIntent(raw.practiceIntent, raw.skills)
  const matchVenue = venue(raw.venue || {})
  return Object.assign({}, raw, {
    dateLabel: dateUtil.displayDate(raw.date),
    scheduleText: `${dateUtil.displayDate(raw.date)} ${raw.startTime || ''}—${raw.endTime || ''}`,
    venueName: matchVenue.name || '球馆待确认',
    address: matchVenue.address,
    venueLocationText: matchVenue.locationText,
    venueActivityTags: matchVenue.activityTags,
    location: matchVenue.location,
    hasLocation: matchVenue.hasLocation,
    participantCount,
    capacity,
    seats,
    openSeatCount: seats,
    full: seats === 0,
    soloPractice,
    seatText: soloPractice ? '单人练习' : seats > 0 ? `还差 ${seats} 人` : '已满员',
    feeText: money(raw.feePerPerson),
    expectedBallAge: raw.expectedBallAge || '不限球龄',
    practiceIntent,
    practiceIntentLabel: practiceIntent,
    skills: Array.isArray(raw.skills) ? raw.skills : [],
    joinModeText: soloPractice ? '不开放加入' : raw.joinMode === 'confirm' ? '需发起人确认' : '直接加入',
    courtStatus,
    courtStatusText: courtBooked ? '发起人已订台' : '发起人尚未订台',
    courtStatusMeta: courtBooked ? '发起人填写 · 平台未核验' : '还需确认球台',
    courtBookingNotice: courtBooked
      ? '订台状态由发起人填写，平台未核验；加入球局不等于向球馆预订。'
      : '发起人尚未订台，还需确认球台；加入球局不等于向球馆预订。',
    courtBookingNote: raw.courtBookingNote || '',
    joinSheetTitle,
    joinSheetCopy,
    joinSubmitText: seats === 0 ? '确认加入候补' : raw.joinMode === 'confirm' ? '提交申请' : '确认加入',
    statusLabel: soloPractice && raw.status === 'full' ? '单人练习' : MATCH_STATUS_LABELS[raw.status] || '状态待确认',
    host: Object.assign(host, {
      ratingText: host.ratingPlatform && host.ratingPlatform !== '未填写' && host.ratingValue
        ? `${host.ratingPlatform} ${host.ratingValue}` : ''
    }),
    participants
  })
}

function venue(raw = {}) {
  const nameOnly = raw.nameOnly === true || raw.listingMode === 'name_only'
  const district = String(raw.district || '').trim()
  const address = String(raw.address || '').trim()
  const activityTags = textList(raw.activityTags)
  const location = geo.normalizePoint(raw.location)
  const hasLocation = !nameOnly && Boolean(location)
  const distance = Number(raw.distanceMeters)
  const distanceText = Number.isFinite(distance) && distance >= 0
    ? distance < 100
      ? '100 米内'
      : distance < 1000
        ? `${Math.round(distance / 100) * 100} 米`
        : distance < 10000
          ? `${(distance / 1000).toFixed(1)} 公里`
          : `${Math.round(distance / 1000)} 公里`
    : ''
  const locationText = nameOnly ? '' : [district, address].filter(Boolean).join(' · ')
  const businessHoursText = nameOnly ? '' : String(raw.openingHours || '').trim()
  const bookingNotice = nameOnly ? '' : String(raw.bookingTip || '').trim()
  const phone = nameOnly ? '' : String(raw.phone || '').trim()
  return Object.assign({}, raw, {
    nameOnly,
    district: nameOnly ? '' : district,
    address: nameOnly ? '' : address,
    phone,
    verified: nameOnly ? false : raw.verified,
    partnerVerified: nameOnly ? false : raw.partnerVerified,
    activityTags,
    activityTagsText: activityTags.join(' · '),
    locationText,
    distanceText,
    imageUrls: Array.isArray(raw.imageUrls) ? raw.imageUrls : [],
    coverFileIds: Array.isArray(raw.coverFileIds) ? raw.coverFileIds : [],
    businessHoursText,
    bookingNotice,
    hasInformation: Boolean(businessHoursText || phone || bookingNotice),
    updatedText: raw.updatedText || '近期',
    location: nameOnly ? null : location,
    hasLocation
  })
}

function slot(raw = {}) {
  const start = jsDate(raw.startAt)
  const date = start ? dateUtil.toDateString(start) : ''
  return Object.assign({}, raw, {
    date,
    timeText: timeText(raw.startAt),
    durationText: durationText(raw.startAt, raw.endAt),
    scheduleText: `${dateUtil.displayDate(date)} ${timeText(raw.startAt)}—${timeText(raw.endAt)}`,
    priceText: money(raw.price, '/节')
  })
}

function coach(raw = {}, venueMap = {}) {
  const slots = (raw.nextSlots || raw.slots || []).map(slot)
  const firstVenue = raw.venueIds && venueMap[raw.venueIds[0]]
  const defaultPrice = slots.length ? slots[0].price : 0
  return Object.assign({}, raw, {
    displayName: raw.name || '教练',
    specialtyText: Array.isArray(raw.specialty) && raw.specialty.length ? raw.specialty.join(' · ') : '乒乓球训练',
    venueName: raw.venueName || (firstVenue && firstVenue.name) || '上课球馆见时段',
    avatarUrl: raw.avatarUrl || '',
    nextSlots: slots,
    nextSlotText: slots.length ? `最近 ${slots[0].scheduleText}` : '暂无可约时段',
    priceText: defaultPrice ? money(defaultPrice, '/节') : '按时段计费'
  })
}

function appointment(raw = {}) {
  if (raw.type === 'coach') {
    const booking = raw.booking || {}
    const end = jsDate(booking.endAt)
    const upcoming = Boolean(end && end.getTime() > Date.now() && raw.status !== 'cancelled')
    return {
      id: raw.id,
      resourceId: booking.id,
      kind: 'coach',
      kindLabel: '教练课',
      title: booking.coach && booking.coach.name || '教练预约',
      venueName: booking.venue && booking.venue.name || '',
      scheduleText: `${fullDateTime(booking.startAt)}—${timeText(booking.endAt)}`,
      dateLabel: jsDate(booking.startAt) ? dateUtil.displayDate(dateUtil.toDateString(jsDate(booking.startAt))) : '时间待确认',
      timeRange: `${timeText(booking.startAt)}—${timeText(booking.endAt)}`,
      status: raw.status,
      statusLabel: raw.status === 'confirmed' ? '已确认' : MEMBER_STATUS_LABELS[raw.status] || '已更新',
      statusTone: raw.status === 'cancelled' ? 'muted' : 'success',
      paymentText: Number(booking.price) > 0 ? `${money(booking.price, '/节')} · 到店支付` : '课时免费',
      period: upcoming ? 'upcoming' : 'history',
      version: booking.version,
      canCancel: upcoming && raw.status === 'confirmed',
      canChat: false,
      canConfirmSchedule: false,
      showActions: upcoming && raw.status === 'confirmed',
      cancelPolicyText: '取消截止时间以预约时展示的规则为准；临近开课请联系球馆处理。',
      raw
    }
  }

  const value = match(raw.match || {})
  const start = jsDate(raw.match && raw.match.startAt)
  const end = jsDate(raw.match && raw.match.endAt)
  const upcoming = Boolean(end && end.getTime() > Date.now() && raw.status !== 'cancelled')
  const inProgress = Boolean(upcoming && start && start.getTime() <= Date.now())
  const beforeStart = upcoming && !inProgress
  const canCancel = beforeStart && ['host', 'joined', 'pending', 'waitlisted', 'schedule_confirmation_required'].includes(raw.status)
  const canChat = !value.soloPractice && ['host', 'joined', 'schedule_confirmation_required'].includes(raw.status)
  return {
    id: raw.id,
    resourceId: value.id,
    matchId: value.id,
    kind: 'match',
    canReviewRequests: beforeStart && raw.membershipStatus === 'host' && !value.soloPractice && ['recruiting', 'full', 'changed'].includes(value.status),
    kindLabel: value.soloPractice ? '单人练习' : raw.membershipStatus === 'host' ? '我发起的球局' : '球友局',
    title: value.title,
    venueName: value.venueName,
    scheduleText: value.scheduleText,
    dateLabel: value.dateLabel,
    timeRange: `${value.startTime || ''}—${value.endTime || ''}`,
    status: raw.status,
    statusLabel: inProgress && ['host', 'joined', 'schedule_confirmation_required'].includes(raw.status)
      ? '进行中' : raw.status === 'host' ? value.statusLabel : MEMBER_STATUS_LABELS[raw.status] || value.statusLabel,
    statusTone: raw.status === 'cancelled' || raw.status === 'rejected' ? 'muted' : (raw.status === 'schedule_confirmation_required' ? '' : 'success'),
    paymentText: Number(value.feePerPerson) > 0 ? `${value.feeText} · 到店支付` : value.feeText,
    period: upcoming ? 'upcoming' : 'history',
    version: value.version,
    canCancel,
    canChat,
    canConfirmSchedule: beforeStart && raw.status === 'schedule_confirmation_required',
    showActions: upcoming && (canCancel || canChat || ['pending', 'waitlisted'].includes(raw.status)),
    actionHint: raw.status === 'pending' ? '等待发起人处理' : '',
    cancelPolicyText: value.soloPractice
      ? '取消后会关闭这次单人练习。'
      : raw.membershipStatus === 'host' ? '取消后会通知所有参与者并关闭球局。' : '取消后会释放名额；已经线下支付的费用请与收款方协商。',
    raw
  }
}

function message(raw = {}) {
  const sender = raw.sender || {}
  const created = jsDate(raw.createdAt)
  return Object.assign({}, raw, {
    domId: `message-${raw.id}`,
    senderName: sender.displayName || '球友',
    timeText: created ? timeText(created) : '',
    type: raw.type || 'text'
  })
}

module.exports = { jsDate, timeText, fullDateTime, money, player, match, venue, slot, coach, appointment, message }
