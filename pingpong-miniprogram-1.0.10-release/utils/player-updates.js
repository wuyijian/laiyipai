const dateUtil = require('./date')

function dateValue(value) {
  if (!value) return NaN
  if (typeof value === 'object') {
    if (value.$date !== undefined) return new Date(value.$date).getTime()
    if (Number.isFinite(value._seconds)) return value._seconds * 1000
    if (Number.isFinite(value.seconds)) return value.seconds * 1000
  }
  return new Date(value).getTime()
}

function relativeTime(value) {
  const timestamp = dateValue(value)
  if (!Number.isFinite(timestamp)) return ''
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < 60 * 1000) return '刚刚'
  if (elapsed < 60 * 60 * 1000) return `${Math.floor(elapsed / 60000)} 分钟前`
  if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 3600000)} 小时前`
  if (elapsed < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 86400000)} 天前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function legacySchedule(raw) {
  if (!raw.date) return ''
  return `${dateUtil.displayDate(raw.date)} ${raw.startTime || ''}${raw.endTime ? `—${raw.endTime}` : ''}`.trim()
}

function presentUpdate(raw = {}, avatarUrl = '') {
  const author = raw.author || {}
  const kind = raw.kind === 'tip' ? 'tip' : 'availability'
  const ratingText = raw.ratingPlatform && raw.ratingPlatform !== '未填写' && raw.ratingValue
    ? `${raw.ratingPlatform} ${raw.ratingValue}` : ''
  const availabilityText = raw.availabilityText || legacySchedule(raw)
  return {
    id: raw.id || '',
    kind,
    kindText: kind === 'tip' ? '心得技巧' : '可约球',
    playerId: author.playerId || '',
    displayName: author.displayName || '球友',
    avatarFileId: author.avatarFileId || '',
    avatarUrl,
    district: raw.district || '',
    locationText: kind === 'availability' ? ['杭州', raw.district].filter(Boolean).join(' · ') : '',
    metaText: [kind === 'availability' ? ['杭州', raw.district].filter(Boolean).join(' · ') : '', relativeTime(raw.createdAt || raw.updatedAt)].filter(Boolean).join(' · '),
    availabilityText,
    scheduleText: availabilityText,
    timeNote: raw.timeNote || '',
    venueName: raw.venueName || '',
    content: raw.content || '',
    date: raw.date || '',
    startTime: raw.startTime || '',
    endTime: raw.endTime || '',
    ratingPlatform: raw.ratingPlatform || '未填写',
    ratingValue: raw.ratingValue || '',
    ratingText,
    commentCount: Math.max(0, Number(raw.commentCount || 0)),
    commentText: Number(raw.commentCount || 0) ? `${Number(raw.commentCount)} 条回复` : '查看并回复',
    mine: raw.mine === true,
    createdText: relativeTime(raw.createdAt || raw.updatedAt)
  }
}

function presentComment(raw = {}, avatarUrl = '') {
  const author = raw.author || {}
  return {
    id: raw.id || '',
    playerId: author.playerId || '',
    displayName: author.displayName || '球友',
    avatarFileId: author.avatarFileId || '',
    avatarUrl,
    content: raw.content || '',
    mine: raw.mine === true,
    createdText: relativeTime(raw.createdAt)
  }
}

module.exports = { presentUpdate, presentComment, relativeTime, dateValue }


