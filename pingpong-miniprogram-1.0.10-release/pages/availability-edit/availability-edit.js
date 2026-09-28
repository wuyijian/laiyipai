const api = require('../../utils/api')
const errors = require('../../utils/error')
const location = require('../../utils/location')
function chinaDate(now = Date.now()) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10) }
Page({
  data: { state: 'loading', errorMessage: '', saving: false, available: false, note: '',
    date: '', minimumDate: '', maximumDate: '', startTime: '19:00', endTime: '21:00',
    venueId: '', venueName: '', venues: [], venuePage: 0, venueHasMore: false, venueLoading: false,
    keyword: '', searchedKeyword: '', venueError: '', nearbyEnabled: false, sharingLocation: false, nearbyError: '' },
  onLoad() {
    this.active = true
    this.setData({ minimumDate: chinaDate(), maximumDate: chinaDate(Date.now() + 30 * 86400000), date: chinaDate(Date.now() + 86400000) })
  },
  onShow() {
    this.active = true
    this.setData({ sharingLocation: Boolean(this.nearbyWritePending),
      saving: Boolean(this.saveAttempt && this.saveAttempt.pending), venueLoading: false })
    this.showSaveFeedback()
    if (this.data.state !== 'ready') return this.load(false)
    if (this.refreshNearbyOnShow && !this.nearbyWritePending) return this.refreshNearbyState()
  },
  onHide() {
    this.active = false
    this.refreshNearbyOnShow = true
    this.run = (this.run || 0) + 1
    this.venueRun = (this.venueRun || 0) + 1
    this.locationRun = (this.locationRun || 0) + 1
    if (this.saveAttempt) this.saveAttempt.abandoned = true
  },
  onUnload() { this.onHide() },
  async refreshNearbyState() {
    const run = this.locationRun = (this.locationRun || 0) + 1
    try {
      const profile = await api.profile.get()
      if (!this.active || run !== this.locationRun) return
      this.refreshNearbyOnShow = false
      this.setData({ nearbyEnabled: Boolean(profile.nearbyDiscovery && profile.nearbyDiscovery.enabled), nearbyError: '' })
    } catch (error) {
      if (this.active && run === this.locationRun) this.setData({ nearbyError: errors.message(error) })
    }
  },
  async load(interactive = false) {
    if (!this.active) return false
    const run = this.run = (this.run || 0) + 1
    this.setData({ state: 'loading', errorMessage: '' })
    try {
      await getApp().ensureSession({ interactive })
      if (!this.active || run !== this.run) return false
      const profile = await api.profile.get()
      if (!this.active || run !== this.run) return
      const status = profile.availability || { available: false }
      this.setData({ state: 'ready', nearbyEnabled: Boolean(profile.nearbyDiscovery && profile.nearbyDiscovery.enabled), available: status.available === true, note: status.note || '',
        date: status.date || this.data.date, startTime: status.startTime || '19:00', endTime: status.endTime || '21:00',
        venueId: status.venueId || '', venueName: status.venueName || '' })
      if (status.available) this.searchVenues(false)
    } catch (error) {
      if (this.active && run === this.run) this.setData({ state: 'error', errorMessage: errors.message(error) })
    }
  },
  retry() { return this.load(true) },
  async setNearbyDiscovery(event) {
    if (!this.active || this.data.sharingLocation || this.data.saving) return
    const run = this.locationRun = (this.locationRun || 0) + 1
    const isCurrent = () => this.active && run === this.locationRun
    const enabled = event.currentTarget.dataset.enabled === true || event.currentTarget.dataset.enabled === 'true'
    this.setData({ sharingLocation: true, nearbyError: '' })
    try {
      await getApp().ensureSession({ interactive: true })
      if (!isCurrent()) return false
      const point = enabled ? await location.locate(isCurrent) : {}
      if (!isCurrent()) return false
      this.nearbyWritePending = true
      this.nearbyWriteRun = run
      const result = await api.profile.update({ nearbyDiscovery: Object.assign({ enabled }, point) })
      if (!isCurrent()) return false
      if (!result.nearbyDiscovery || result.nearbyDiscovery.enabled !== enabled) throw new Error('附近展示设置尚未保存，请稍后重试')
      this.setData({ nearbyEnabled: enabled })
      wx.showToast({ title: enabled ? '已开启 24 小时' : '已关闭附近展示', icon: 'none' })
      return true
    } catch (error) {
      if (isCurrent()) this.setData({ nearbyError: errors.message(error) })
      return false
    } finally {
      const sentWrite = this.nearbyWriteRun === run
      if (sentWrite) this.nearbyWritePending = false
      if (isCurrent()) this.setData({ sharingLocation: false })
      else if (sentWrite && this.active && this.refreshNearbyOnShow) {
        // A sent write cannot be cancelled. On return, reconcile only nearby
        // settings without replacing the user's unsaved availability draft.
        this.setData({ sharingLocation: false })
        await this.refreshNearbyState()
      }
    }
  },
  toggleAvailable(event) {
    if (this.data.saving) return
    this.setData({ available: event.detail.value === true, errorMessage: '' })
    if (this.data.available && !this.data.venuePage) this.searchVenues(false)
  },
  changeField(event) {
    const key = event.currentTarget.dataset.key
    if (this.data.saving || !['date', 'startTime', 'endTime', 'note', 'keyword'].includes(key)) return
    this.setData({ [key]: event.detail.value, errorMessage: '' })
  },
  async searchVenues(append = false) {
    if (append && (!this.data.venueHasMore || this.data.venueLoading)) return
    const run = this.venueRun = (this.venueRun || 0) + 1
    const page = append ? this.data.venuePage + 1 : 1
    const keyword = append ? this.data.searchedKeyword : this.data.keyword.trim()
    this.setData({ venueLoading: true, venueError: '', ...(append ? {} : { venues: [], venueHasMore: false, venuePage: 0 }) })
    try {
      const result = await api.venues.list({ keyword, page, pageSize: 20 })
      if (!this.active || run !== this.venueRun) return
      this.setData({ venues: append ? this.data.venues.concat(result.items || []) : result.items || [],
        searchedKeyword: keyword, venuePage: page, venueHasMore: result.hasMore === true && page < 50, venueLoading: false })
    } catch (error) {
      if (this.active && run === this.venueRun) this.setData({ venueLoading: false, venueError: errors.message(error) })
    }
  },
  search() { return this.searchVenues(false) },
  moreVenues() { return this.searchVenues(true) },
  chooseVenue(event) {
    if (this.data.saving) return
    const venue = this.data.venues.find(item => item.id === event.currentTarget.dataset.id)
    if (venue) this.setData({ venueId: venue.id, venueName: venue.name, errorMessage: '' })
  },
  async save() {
    if (!this.active || this.data.saving || this.data.sharingLocation ||
        (this.saveAttempt && this.saveAttempt.pending) || this.data.state !== 'ready') return false
    const { available, note, date, startTime, endTime, venueId } = this.data
    if (available) {
      const start = Date.parse(date + 'T' + startTime + ':00+08:00')
      const end = Date.parse(date + 'T' + endTime + ':00+08:00')
      if (!venueId) { this.setData({ errorMessage: '请选择约球球馆' }); return false }
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= Date.now()) {
        this.setData({ errorMessage: '请选择尚未结束的有效时段，结束时间须晚于开始时间' }); return false
      }
    }
    const availability = available ? { available, note, date, startTime, endTime, venueId } : { available: false, note }
    const attempt = { pending: false, sent: false, abandoned: false }
    this.saveAttempt = attempt
    const isCurrent = () => this.active && this.saveAttempt === attempt && !attempt.abandoned
    this.setData({ saving: true, errorMessage: '' })
    try {
      await getApp().ensureSession({ interactive: true })
      if (!isCurrent()) return false
      attempt.pending = attempt.sent = true
      const result = await api.profile.update({ availability })
      if (!result.availability || result.availability.available !== available ||
          (available && (result.availability.venueId !== venueId || result.availability.date !== date ||
          result.availability.startTime !== startTime || result.availability.endTime !== endTime)) ||
          (result.availability.note || '') !== note.trim()) throw new Error('约球状态尚未保存，请确认服务已更新后重试')
      if (!isCurrent()) {
        if (this.saveAttempt === attempt) this.saveFeedback = { saved: true }
        return false
      }
      wx.showToast({ title: '状态已更新', icon: 'success' })
      wx.navigateBack()
      return true
    } catch (error) {
      const message = errors.message(error, '保存失败，请重试')
      if (isCurrent()) this.setData({ errorMessage: message })
      else if (this.saveAttempt === attempt && attempt.sent) this.saveFeedback = { error: message }
      return false
    } finally {
      attempt.pending = false
      if (this.saveAttempt === attempt) {
        this.saveAttempt = null
        if (this.active) {
          this.setData({ saving: false })
          this.showSaveFeedback()
        }
      }
    }
  },
  showSaveFeedback() {
    if (!this.active || !this.saveFeedback) return
    const feedback = this.saveFeedback
    this.saveFeedback = null
    if (feedback.error) this.setData({ errorMessage: feedback.error })
    else if (feedback.saved) wx.showToast({ title: '状态已更新', icon: 'success' })
  }
})
module.exports = { chinaDate }
