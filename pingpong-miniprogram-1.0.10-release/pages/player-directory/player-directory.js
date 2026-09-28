const api = require('../../utils/api')
const errors = require('../../utils/error')
const levels = require('../../utils/player-levels')
const DISTRICTS = ['全部行政区', '滨江区', '萧山区', '上城区', '西湖区', '拱墅区', '余杭区', '临平区', '钱塘区', '富阳区', '临安区', '桐庐县', '淳安县', '建德市']
const GRADES = [{ value: '', label: '全部等级' }, { value: 'pending', label: '待定级' }].concat(levels.LEVEL_BANDS.map(item => ({ value: item.code, label: item.code + ' · ' + item.label })))
const STATUS = [{ value: '', label: '全部状态' }, { value: 'available', label: '可约球' }, { value: 'unavailable', label: '暂不约球' }]
function expire(items, now = Date.now()) {
  return items.map(item => item.availability && item.availability.available && item.availability.endAt <= now
    ? Object.assign({}, item, { availability: { available: false } }) : item)
}
Page({
  data: { state: 'loading', items: [], cursor: '', hasMore: false, loadingMore: false, errorMessage: '',
    districts: DISTRICTS, grades: GRADES, statuses: STATUS, districtIndex: 0, gradeIndex: 0, statusIndex: 0 },
  onShow() {
    this.active = true
    this.expiryTimer = setInterval(() => {
      let items = expire(this.data.items)
      if (this.data.statusIndex === 1) items = items.filter(item => item.availability.available)
      this.setData({ items })
    }, 30000)
    return this.load(false)
  },
  onHide() { this.active = false; this.run = (this.run || 0) + 1; clearInterval(this.expiryTimer) },
  onUnload() { this.onHide() },
  onPullDownRefresh() { return this.load(false).finally(() => wx.stopPullDownRefresh()) },
  changeFilter(event) {
    const key = event.currentTarget.dataset.key
    const choices = { districtIndex: DISTRICTS, gradeIndex: GRADES, statusIndex: STATUS }
    const index = Number(event.detail.value)
    if (!choices[key] || !choices[key][index]) return
    this.setData({ [key]: index })
    return this.load(false)
  },
  async load(append = false) {
    if (append && (this.data.loadingMore || !this.data.hasMore)) return
    const run = this.run = (this.run || 0) + 1
    const options = { publicRead: !(getApp().globalData && getApp().globalData.session) }
    this.setData(append ? { loadingMore: true, errorMessage: '' } : { state: 'loading', items: [], cursor: '', hasMore: false, loadingMore: false, errorMessage: '' })
    try {
      const result = await api.players.list({ cursor: append ? this.data.cursor : '', pageSize: 20,
        district: this.data.districtIndex ? DISTRICTS[this.data.districtIndex] : '',
        grade: GRADES[this.data.gradeIndex].value, availability: STATUS[this.data.statusIndex].value }, options)
      if (!this.active || run !== this.run) return
      const incoming = expire(result.items || [])
      const items = append ? this.data.items.concat(incoming) : incoming
      this.setData({ state: 'ready', items: Array.from(new Map(items.map(item => [item.playerId, item])).values()),
        cursor: result.cursor || '', hasMore: result.hasMore === true, loadingMore: false })
      // Text is usable before media resolves. At most 20 cards per request.
      const ids = Array.from(new Set(incoming.map(item => item.avatarFileId).filter(Boolean)))
      if (ids.length) {
        try {
          const media = await api.files.resolve(ids, options)
          if (!this.active || run !== this.run) return
          const patch = {}
          this.data.items.forEach((item, index) => { if (media.urls && media.urls[item.avatarFileId]) patch['items[' + index + '].avatarUrl'] = media.urls[item.avatarFileId] })
          this.setData(patch)
        } catch (_) {}
      }
    } catch (error) {
      if (!this.active || run !== this.run) return
      this.setData({ state: append ? 'ready' : 'error', loadingMore: false, errorMessage: errors.message(error) })
    }
  },
  retry() { return this.load(false) },
  loadMore() { return this.load(true) },
  openPlayer(event) { wx.navigateTo({ url: '/pages/player-detail/player-detail?id=' + encodeURIComponent(event.currentTarget.dataset.id) }) }
})
module.exports = { expire }
