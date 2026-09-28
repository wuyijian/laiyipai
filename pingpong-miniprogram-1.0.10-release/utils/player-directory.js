const api = require('./api')
const errors = require('./error')
const levels = require('./player-levels')
const location = require('./location')
const RADII = [5000, 10000, 20000, 50000]
const DISTRICTS = ['行政区', '滨江区', '萧山区', '上城区', '西湖区', '拱墅区', '余杭区', '临平区', '钱塘区', '富阳区', '临安区', '桐庐县', '淳安县', '建德市']
const GRADES = [{ value: '', label: '等级' }, { value: 'pending', label: '待定级' }].concat(levels.LEVEL_BANDS.map(item => ({ value: item.code, label: item.label })))
function expire(items, now = Date.now()) {
  return items.map(item => item.availability && item.availability.available && item.availability.endAt <= now
    ? Object.assign({}, item, { availability: { available: false } }) : item)
}
const definition = {
  data: { state: 'loading', items: [], cursor: '', hasMore: false, loadingMore: false, errorMessage: '',
    districts: DISTRICTS, grades: GRADES, districtIndex: 0, gradeIndex: 0, availableOnly: false,
    nearbyActive: false, locating: false, locationError: '', radiusIndex: 2, radiusLabels: ['5 公里内', '10 公里内', '20 公里内', '50 公里内'] },
  onShow() {
    this.active = true
    if (!this.position) this.setData({ nearbyActive: false, locating: false })
    clearInterval(this.expiryTimer)
    this.expiryTimer = setInterval(() => {
      let items = expire(this.data.items)
      if (this.data.availableOnly) items = items.filter(item => item.availability.available)
      this.setData({ items })
    }, 30000)
    return this.load(false)
  },
  onHide() {
    this.active = false; this.run = (this.run || 0) + 1; clearInterval(this.expiryTimer)
    this.locationRun = (this.locationRun || 0) + 1
    this.position = null
  },
  onUnload() { this.onHide() },
  onPullDownRefresh() { return this.load(false).finally(() => wx.stopPullDownRefresh()) },
  changeFilter(event) {
    const key = event.currentTarget.dataset.key
    const choices = { districtIndex: DISTRICTS, gradeIndex: GRADES }
    const index = Number(event.detail.value)
    if (!choices[key] || !choices[key][index]) return
    this.setData({ [key]: index })
    return this.load(false)
  },
  toggleAvailableOnly() {
    this.setData({ availableOnly: !this.data.availableOnly })
    return this.load(false)
  },
  toggleNearby() {
    if (this.data.locating) return
    if (!this.data.nearbyActive) return this.locateNearby()
    this.position = null
    this.locationRun = (this.locationRun || 0) + 1
    this.setData({ nearbyActive: false, locationError: '' })
    return this.load(false)
  },
  async locateNearby() {
    if (this.data.locating) return
    const run = this.locationRun = (this.locationRun || 0) + 1
    this.position = null
    this.run = (this.run || 0) + 1
    this.setData({ locating: true, locationError: '', state: 'loading', items: [], hasMore: false })
    try {
      const point = await location.locate(() => this.active && run === this.locationRun)
      if (!this.active || run !== this.locationRun) return false
      this.position = point
      this.setData({ nearbyActive: true, locating: false })
      return this.load(false)
    } catch (error) {
      if (!this.active || run !== this.locationRun) return false
      this.setData({ nearbyActive: false, locating: false, locationError: errors.message(error) })
      return this.load(false)
    }
  },
  changeRadius(event) {
    const index = Number(event.detail.value)
    if (!Number.isInteger(index) || !RADII[index] || !this.position) return
    this.setData({ radiusIndex: index })
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
        grade: GRADES[this.data.gradeIndex].value, availability: this.data.availableOnly ? 'available' : '',
        ...(this.data.nearbyActive && this.position ? { nearby: Object.assign({}, this.position, { radiusMeters: RADII[this.data.radiusIndex] }) } : {}) }, options)
      if (!this.active || run !== this.run) return
      const incoming = expire(result.items || []).map(item => Object.assign({}, item, {
        level: Object.assign({}, item.level, { text: levels.display(item.level && item.level.code) })
      }))
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
      return true
    } catch (error) {
      if (!this.active || run !== this.run) return
      this.setData({ state: append ? 'ready' : 'error', loadingMore: false, errorMessage: errors.message(error) })
      return false
    }
  },
  retry() { return this.load(false) },
  loadMore() { return this.load(true) },
  openPlayer(event) { wx.navigateTo({ url: '/pages/player-detail/player-detail?id=' + encodeURIComponent(event.currentTarget.dataset.id) }) }
}
module.exports = { expire, definition }
