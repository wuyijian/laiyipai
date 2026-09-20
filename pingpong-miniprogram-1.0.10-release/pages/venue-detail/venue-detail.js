const api = require('../../utils/api')
const clientState = require('../../utils/client-state')
const present = require('../../utils/present')
const errors = require('../../utils/error')
const share = require('../../utils/share')
const mapHelper = require('../../utils/map')
const diagnostics = require('../../utils/diagnostics')

function updatedText(value) {
  const date = present.jsDate(value)
  if (!date) return '近期'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

Page({
  data: {
    id: '',
    state: 'loading',
    notFound: false,
    errorMessage: '',
    venue: null,
    matches: [],
    coaches: [],
    matchesUnavailable: false,
    coachesUnavailable: false,
    matchesLoading: false,
    coachesLoading: false,
    matchesLoaded: false,
    coachesLoaded: false,
    mediaLoading: false,
    mediaFailed: false,
    refreshing: false,
    refreshError: '',
    favoriteSaving: false,
    favoriteStatus: 'unknown',
    loggedIn: false,
    activeTab: 'matches',
    photosState: 'idle',
    photoItems: [],
    photoDeletingId: '',
    ownPhotosVisible: false
  },

  onLoad(options) {
    this.destroyed = false
    share.disable()
    this.setData({ id: options && options.id || '' })
  },

  onUnload() { this.destroyed = true; this.venueLoadVersion = Number(this.venueLoadVersion || 0) + 1 },

  onShow() {
    return this.loadVenue().then(() => this.resumeFavoriteIntent())
  },

  onPullDownRefresh() {
    this.loadVenue().finally(() => wx.stopPullDownRefresh())
  },

  async loadVenue(event) {
    if (!this.data.id) {
      share.disable()
      this.setData({ state: 'error', notFound: true, errorMessage: '缺少球馆编号' })
      return
    }
    if (this.loading) return this.loading
    const startedAt = Date.now()
    const version = this.venueLoadVersion = Number(this.venueLoadVersion || 0) + 1
    const previousVenue = this.data.venue && this.data.venue.id === this.data.id ? this.data.venue : null
    share.disable()
    this.setData({ state: previousVenue ? 'ready' : 'loading', refreshing: Boolean(previousVenue), refreshError: '', errorMessage: '', notFound: false })
    this.loading = (async () => {
      try {
        const app = getApp()
        const loggedIn = Boolean(app.globalData && app.globalData.session)
        const readOptions = { publicRead: !loggedIn }
        const rawVenue = await api.venues.get({ venueId: this.data.id }, readOptions)
        if (this.destroyed || version !== this.venueLoadVersion) return
        const venue = Object.assign(present.venue(rawVenue), {
          imageUrls: previousVenue && JSON.stringify(previousVenue.coverFileIds) === JSON.stringify(rawVenue.coverFileIds || []) ? previousVenue.imageUrls : [],
          favorited: Boolean(previousVenue && previousVenue.favorited),
          updatedText: updatedText(rawVenue.verificationDate || rawVenue.updatedAt)
        })
        this.setData({
          state: 'ready', refreshing: false, venue, favoriteStatus: 'unknown',
          loggedIn,
          matchesLoaded: false, coachesLoaded: false,
          matchesUnavailable: false, coachesUnavailable: false,
          mediaLoading: Boolean(venue.coverFileIds.length), mediaFailed: false
        })
        share.enable()
        diagnostics.record({ action: 'page.venue.ready', durationMs: Date.now() - startedAt })
        // Venue information and publishing are usable before optional reads.
        if (loggedIn && this.data.ownPhotosVisible) this.loadPhotos()
        await Promise.all([
          this.loadVenueTab(undefined, readOptions),
          loggedIn ? this.refreshFavoriteStatus({ silent: true, version }) : Promise.resolve(),
          this.enrichVenuePhotos(venue.coverFileIds, version, readOptions)
        ])
      } catch (error) {
        if (this.destroyed || version !== this.venueLoadVersion) return
        share.disable()
        const inaccessible = ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED', 'ACCOUNT_DELETED', 'ACCOUNT_SUSPENDED', 'CONSENT_REQUIRED'].includes(error && error.code)
        if (previousVenue && !inaccessible) {
          this.setData({ state: 'ready', refreshing: false, refreshError: '资料暂未更新，可下拉重试' })
        } else this.setData({
          state: 'error', refreshing: false, venue: null,
          notFound: error && error.code === 'NOT_FOUND',
          errorMessage: errors.message(error)
        })
      }
    })()
    try {
      await this.loading
    } finally {
      this.loading = null
    }
  },

  async enrichVenuePhotos(fileIds, version, options = { publicRead: !this.data.loggedIn }) {
    const urls = await this.resolveFiles(fileIds, options)
    if (this.destroyed || version !== this.venueLoadVersion) return
    const imageUrls = fileIds.map(id => urls[id]).filter(Boolean)
    this.setData({ 'venue.imageUrls': imageUrls, mediaLoading: false, mediaFailed: imageUrls.length < fileIds.length })
  },

  retryVenuePhotos() {
    if (!this.data.venue || this.data.mediaLoading) return
    this.setData({ mediaLoading: true, mediaFailed: false })
    return this.enrichVenuePhotos(this.data.venue.coverFileIds, this.venueLoadVersion)
  },

  async loadVenueTab(value = this.data.activeTab, options = { publicRead: !this.data.loggedIn }) {
    if (!['matches', 'coaches'].includes(value) || !this.data.venue) return
    const version = this.venueLoadVersion
    const key = `${version}:${value}`
    this.tabLoads = this.tabLoads || new Map()
    if (this.tabLoads.has(key)) return this.tabLoads.get(key)
    this.setData({ [`${value}Loading`]: true, [`${value}Unavailable`]: false })
    const task = (async () => {
      try {
        const payload = { city: '杭州', venueId: this.data.id, page: 1, pageSize: value === 'matches' ? 50 : 30 }
        const result = await api[value].list(payload, options)
        if (this.destroyed || version !== this.venueLoadVersion) return
        const venueMap = { [this.data.venue.id]: this.data.venue }
        const items = (result.items || []).map(item => value === 'matches' ? present.match(item) : Object.assign(present.coach(item, venueMap), { avatarUrl: '' }))
        this.setData({ [value]: items, [`${value}Loading`]: false, [`${value}Loaded`]: true })
        if (value === 'coaches') {
          const urls = await this.resolveFiles((result.items || []).map(item => item.avatarFileId).filter(Boolean), options)
          if (!this.destroyed && version === this.venueLoadVersion) this.setData({ coaches: items.map(item => Object.assign({}, item, { avatarUrl: urls[item.avatarFileId] || '' })) })
        }
      } catch (_) {
        if (!this.destroyed && version === this.venueLoadVersion) this.setData({ [`${value}Unavailable`]: true, [`${value}Loading`]: false, [`${value}Loaded`]: true })
      }
    })()
    this.tabLoads.set(key, task)
    try { await task } finally { this.tabLoads.delete(key) }
  },

  retryVenueTab() { return this.loadVenueTab() },

  async resolveFiles(fileIds, options = { publicRead: !this.data.loggedIn }) {
    if (!fileIds.length || !api.files || !api.files.resolve) return {}
    try {
      const result = await api.files.resolve(Array.from(new Set(fileIds)), options)
      return result.urls || {}
    } catch (_) {
      return {}
    }
  },

  async loadPhotos() {
    if (this.photosLoading) return this.photosLoading
    const version = this.venueLoadVersion
    const venueId = this.data.id
    this.setData({ photosState: 'loading' })
    this.photosLoading = (async () => {
      try {
        const result = await api.venuePhotos.list({ venueId: this.data.id })
        const urls = await this.resolveFiles((result.items || []).map(item => item.fileId).filter(Boolean))
        if (this.destroyed || version !== this.venueLoadVersion || venueId !== this.data.id) return
        const photoItems = (result.items || []).map(item => Object.assign({}, item, {
          url: urls[item.fileId] || '',
          statusText: { reviewing: '待审核', passed: '已展示', rejected: '未通过' }[item.status] || '处理中'
        }))
        this.setData({ photoItems, photosState: 'ready' })
      } catch (_) {
        if (!this.destroyed && version === this.venueLoadVersion) this.setData({ photosState: 'error' })
      }
    })()
    try { await this.photosLoading } finally { this.photosLoading = null }
  },

  async toggleOwnPhotos() {
    if (!this.data.loggedIn) {
      try {
        await getApp().ensureSession({ interactive: true })
        this.setData({ loggedIn: true })
      } catch (error) {
        if (error && error.code !== 'LOGIN_REQUIRED') errors.toast(error, '暂时无法登录，请稍后重试')
        return
      }
    }
    const visible = !this.data.ownPhotosVisible
    this.setData({ ownPhotosVisible: visible })
    if (visible && ['idle', 'error'].includes(this.data.photosState)) return this.loadPhotos()
  },

  previewPhoto(event) {
    const url = event.currentTarget.dataset.url
    if (!url) return
    const urls = Array.from(new Set([].concat(this.data.venue && this.data.venue.imageUrls || [], this.data.photoItems.map(item => item.url)).filter(Boolean)))
    wx.previewImage({ current: url, urls })
  },

  async removePhoto(event) {
    if (this.data.photoDeletingId) return
    const id = event.currentTarget.dataset.id
    const photo = this.data.photoItems.find(item => item.id === id)
    if (!photo) return
    this.setData({ photoDeletingId: id })
    let removed = false
    try {
      const confirmed = await new Promise((resolve, reject) => wx.showModal({
        title: '删除这张照片？', content: '删除后将从球馆展示中移除，无法恢复。', confirmText: '删除', confirmColor: '#b42318',
        success: result => resolve(result.confirm), fail: reject
      }))
      if (!confirmed) return
      await api.venuePhotos.remove({ photoId: id }, { requestId: api.createRequestId() })
      removed = true
      const patch = { photoItems: this.data.photoItems.filter(item => item.id !== id) }
      if (this.data.venue) patch['venue.imageUrls'] = this.data.venue.imageUrls.filter(url => url !== photo.url)
      this.setData(patch)
      // Refresh approved covers because independently signed URLs can differ.
      const raw = await api.venues.get({ venueId: this.data.id })
      const urls = await this.resolveFiles(raw.coverFileIds || [])
      this.setData({ 'venue.imageUrls': (raw.coverFileIds || []).map(fileId => urls[fileId]).filter(Boolean) })
      wx.showToast({ title: '照片已删除', icon: 'success' })
    } catch (error) {
      if (removed) wx.showToast({ title: '照片已删除，展示信息请下拉刷新', icon: 'none' })
      else errors.toast(error, '删除失败，请重试')
    }
    finally { this.setData({ photoDeletingId: '' }) }
  },

  switchTab(event) {
    const value = event.currentTarget.dataset.value
    if (!['matches', 'coaches'].includes(value)) return
    this.setData({ activeTab: value })
    if (!this.data[`${value}Loaded`]) return this.loadVenueTab(value)
  },

  openMatch(event) {
    wx.navigateTo({ url: `/pages/match-detail/match-detail?id=${event.currentTarget.dataset.id}` })
  },

  openCoach(event) {
    wx.navigateTo({ url: `/pages/coach-detail/coach-detail?id=${event.currentTarget.dataset.id}` })
  },

  startMatch() {
    clientState.setPublishPrefill({ venueId: this.data.id })
    wx.switchTab({ url: '/pages/publish/publish' })
  },

  openMap() {
    const venue = this.data.venue
    if (!venue) return wx.showToast({ title: '暂无可显示的位置', icon: 'none' })
    mapHelper.openLocation(venue.name, venue.address, venue.location, venue.hasLocation, {
      copyHint: true,
      noLocationMessage: '暂无地图位置，请在球局中确认',
      failMessage: '地图暂时无法打开，请稍后重试'
    })
  },

  callVenue() {
    if (!this.data.venue.phone) return
    wx.makePhoneCall({ phoneNumber: this.data.venue.phone })
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' })
  },

  async toggleFavorite() {
    if (this.data.favoriteSaving || !this.data.venue) return
    if (!this.data.loggedIn) {
      // Remember only this explicit tap while the login page is on top. If the
      // user chooses "先逛逛", onShow clears it instead of applying it later.
      this.pendingFavoriteIntent = true
      try {
        await getApp().ensureSession({ interactive: true })
        this.setData({ loggedIn: true })
        return this.resumeFavoriteIntent()
      } catch (error) {
        if (error && error.code !== 'LOGIN_REQUIRED') {
          this.pendingFavoriteIntent = false
          errors.toast(error, '暂时无法登录，请稍后重试')
        }
        return
      }
    }
    if (this.data.favoriteStatus === 'unknown') return this.refreshFavoriteStatus()
    const marked = !this.data.venue.favorited
    const previousStatus = this.data.favoriteStatus
    this.setData({
      favoriteSaving: true,
      favoriteStatus: marked ? 'marked' : 'unmarked',
      'venue.favorited': marked
    })
    try {
      await api.favorites.set({ venueId: this.data.id, marked })
      wx.showToast({ title: marked ? '已标记球馆' : '已取消标记', icon: 'none' })
    } catch (error) {
      this.setData({ favoriteStatus: previousStatus, 'venue.favorited': !marked })
      errors.toast(error, '标记失败，请重试')
    } finally {
      this.setData({ favoriteSaving: false })
    }
  },

  async resumeFavoriteIntent() {
    if (!this.pendingFavoriteIntent) return false
    const app = getApp()
    if (!(app.globalData && app.globalData.session)) {
      this.pendingFavoriteIntent = false
      return false
    }
    this.pendingFavoriteIntent = false
    this.setData({ loggedIn: true })
    if (this.data.state !== 'ready' || !this.data.venue) return false
    if (this.data.favoriteStatus === 'unknown') await this.refreshFavoriteStatus()
    if (this.data.favoriteStatus === 'unmarked') {
      await this.toggleFavorite()
      return this.data.favoriteStatus === 'marked'
    }
    return this.data.favoriteStatus === 'marked'
  },

  async refreshFavoriteStatus(options = {}) {
    if (this.data.favoriteSaving || !this.data.id) return
    this.setData({ favoriteSaving: true })
    const version = options.version === undefined ? this.venueLoadVersion : options.version
    try {
      const result = await api.favorites.status({ venueIds: [this.data.id] })
      if (this.destroyed || version !== this.venueLoadVersion) return
      const favorited = (result.markedIds || []).includes(this.data.id)
      this.setData({
        favoriteStatus: favorited ? 'marked' : 'unmarked',
        'venue.favorited': favorited
      })
    } catch (error) {
      if (!options.silent && !this.destroyed) errors.toast(error, '标记状态暂时无法确认，请重试')
    } finally {
      if (!this.destroyed && version === this.venueLoadVersion) this.setData({ favoriteSaving: false })
    }
  },

  onShareAppMessage() {
    const venue = this.data.venue
    return share.appMessage({
      title: venue ? `${venue.name}｜查看近期球局` : '杭州乒乓球馆｜来一拍',
      path: `/pages/venue-detail/venue-detail?id=${encodeURIComponent(this.data.id)}`,
      imageUrl: venue && venue.imageUrls && venue.imageUrls[0]
    })
  },

  onShareTimeline() {
    const venue = this.data.venue
    return share.timeline({
      title: venue ? `${venue.name}｜查看近期球局` : '杭州乒乓球馆｜来一拍',
      params: { id: this.data.id },
      imageUrl: venue && venue.imageUrls && venue.imageUrls[0]
    })
  }
})
