const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(value) {
  return String(value).padStart(2, '0')
}

function toDateString(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function today() {
  return toDateString(new Date())
}

function addDays(date, days) {
  const result = new Date(date.getTime())
  result.setDate(result.getDate() + days)
  return result
}

function dateTabs(length = 7) {
  const start = new Date()
  start.setHours(12, 0, 0, 0)
  const tabs = [{ value: '', weekday: '全部', label: '日期' }]
  for (let index = 0; index < length; index += 1) {
    const date = addDays(start, index)
    tabs.push({
      value: toDateString(date),
      weekday: index === 0 ? '今天' : WEEKDAYS[date.getDay()],
      label: `${date.getMonth() + 1}/${date.getDate()}`
    })
  }
  return tabs
}

function dateTab(value) {
  const parts = String(value || '').split('-').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null
  const date = new Date(parts[0], parts[1] - 1, parts[2], 12)
  if (Number.isNaN(date.getTime()) || toDateString(date) !== value) return null
  return {
    value,
    weekday: value === today() ? '今天' : WEEKDAYS[date.getDay()],
    label: `${parts[1]}/${parts[2]}`
  }
}

function displayDate(value) {
  if (!value) return ''
  const parts = value.split('-').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) return value
  const date = new Date(parts[0], parts[1] - 1, parts[2], 12)
  const now = new Date()
  const current = toDateString(now)
  const tomorrow = toDateString(addDays(now, 1))
  if (value === current) return `今天 ${parts[1]}月${parts[2]}日`
  if (value === tomorrow) return `明天 ${parts[1]}月${parts[2]}日`
  return `${parts[1]}月${parts[2]}日 ${WEEKDAYS[date.getDay()]}`
}

function isFutureSchedule(date, startTime, minimumMinutes = 10) {
  const value = new Date(`${date}T${startTime}:00+08:00`).getTime()
  return Number.isFinite(value) && value >= Date.now() + minimumMinutes * 60 * 1000
}

module.exports = { toDateString, today, dateTabs, dateTab, displayDate, isFutureSchedule }
