const api = require('../../utils/api')
const location = require('../../utils/location')
const present = require('../../utils/present')
const map = require('../../utils/map')
const errors = require('../../utils/error')
const { fuzzyDistanceText } = require('../../utils/location')

const RADII = [3000, 5000, 10000, 20000, 50000]

Page({
  data: {
    state: 'idle', venues: [], radiusIndex: 2,
    radiusLabels: ['3 公里', '5 公里', '10 公里', '20 公里', '50 公里'],
    errorMessage: '', permissionDenied: false, locating: false, limitReached: false
  },

  onLoad() {
    this.destroyed = false
    this.sequence = 0
    this.position = null
  },

  onUnload() {
    this.destroyed = true
    this.sequence += 1
    this.position = null
  },

  async locateNearby() {
    if (this.data.locating) return
    const sequence = ++this.sequence
    this.position = null
    this.setData({ locating: true, state: 'locating', venues: [], errorMessage: '', permissionDenied: false, limitReached: false })
    try {
      const point = await location.locate(() => !this.destroyed && sequence === this.sequence)
      if (this.destroyed || sequence !== this.sequence) return
      this.position = point
      this.setData({ locating: false })
      return this.loadVenues()
    } catch (error) {
      if (this.destroyed || sequence !== this.sequence) return
      this.setData({ state: 'error', locating: false, errorMessage: errors.message(error), permissionDenied: error.code === 'LOCATION_DENIED' })
    }
  },

  async loadVenues() {
    if (!this.position || this.destroyed) return
    const sequence = ++this.sequence
    const radiusMeters = RADII[this.data.radiusIndex]
    this.setData({ state: 'loading', venues: [], errorMessage: '', limitReached: false })
    try {
      const result = await api.venues.nearby(Object.assign({}, this.position, { radiusMeters, pageSize: 50 }), { publicRead: true })
      if (this.destroyed || sequence !== this.sequence) return
      const venues = (result.items || []).map(present.venue)
        .filter(item => item.hasLocation && Number.isFinite(item.distanceMeters) && item.distanceMeters >= 0)
        .sort((a, b) => a.distanceMeters - b.distanceMeters)
        .map(item => Object.assign({}, item, { distanceText: fuzzyDistanceText(item.distanceMeters) }))
      this.setData({ state: 'ready', venues, limitReached: (result.items || []).length >= 50 })
    } catch (error) {
      if (this.destroyed || sequence !== this.sequence) return
      this.setData({ state: 'error', errorMessage: errors.message(error, '附近球馆加载失败，请重试') })
    }
  },

  changeRadius(event) {
    const radiusIndex = Number(event.detail.value)
    if (!Number.isInteger(radiusIndex) || !RADII[radiusIndex] || radiusIndex === this.data.radiusIndex) return
    this.setData({ radiusIndex })
    return this.loadVenues()
  },

  expandRadius() {
    if (this.data.radiusIndex < RADII.length - 1) {
      return this.changeRadius({ detail: { value: this.data.radiusIndex + 1 } })
    }
  },

  retry() {
    return this.position ? this.loadVenues() : this.locateNearby()
  },

  openSettings() {
    wx.openSetting({ fail: () => wx.showToast({ title: '无法打开设置，请稍后重试', icon: 'none' }) })
  },

  browseVenues() {
    require('../../utils/client-state').requestVenueDiscovery()
    wx.switchTab({ url: '/pages/home/home' })
  },

  openVenue(event) {
    wx.navigateTo({ url: `/pages/venue-detail/venue-detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` })
  },

  openMap(event) {
    const venue = this.data.venues.find(item => item.id === event.currentTarget.dataset.id)
    if (venue) map.openLocation(venue.name, venue.address, venue.location, venue.hasLocation)
  }
})
