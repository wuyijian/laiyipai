const api = require('../../utils/api')
const clientState = require('../../utils/client-state')
const errors = require('../../utils/error')
const playerUpdates = require('../../utils/player-updates')

const PAGE_SIZE = 20
const DISTRICTS = ['全杭州', '滨江区', '萧山区', '上城区', '西湖区', '拱墅区', '余杭区', '临平区', '钱塘区', '富阳区', '临安区', '桐庐县', '淳安县', '建德市']
const RATING_PLATFORMS = ['未填写', '开球网', 'ChinaTT', '其他平台']
const RATING_LABELS = ['不展示积分', '开球网', 'ChinaTT', '其他平台']
const AVAILABILITY_OPTIONS = ['今晚有空', '本周工作日晚间', '周六下午', '本周末', '时间可商量', '自定义时间']

function presentFriend(raw = {}, avatarUrl = '') {
  const player = raw.player || {}
  const skills = Array.isArray(player.skills) ? player.skills.slice(0, 3) : []
  const locationText = [player.city || '杭州', player.district].filter(Boolean).join(' · ')
  const ballAge = player.ballAge && player.ballAge !== '未填写' ? player.ballAge : ''
  return {
    playerId: player.playerId || '',
    displayName: player.displayName || '球友',
    avatarFileId: player.avatarFileId || '',
    avatarUrl,
    metaText: [locationText, ballAge].filter(Boolean).join(' · '),
    skills,
    matchCount: Math.max(1, Number(raw.matchCount || 1)),
    relationshipText: Number(raw.matchCount || 1) > 1 ? `一起打过 ${Number(raw.matchCount)} 场` : '因共同球局成为球友'
  }
}

Page({
  data: {
    activeSection: 'updates',
    updatesState: 'loading', updatesError: '', updates: [],
    updatesPage: 0, updatesHasMore: false, updatesLoadingMore: false,
    state: 'idle', errorMessage: '', items: [], page: 0, hasMore: false, loadingMore: false,
    composerVisible: false, submitting: false, removingId: '', formError: '',
    kind: 'availability', districts: DISTRICTS, districtIndex: 1,
    availabilityOptions: AVAILABILITY_OPTIONS, availabilityIndex: 1, customAvailability: '',
    timeNote: '', venueName: '', content: '',
    ratingLabels: RATING_LABELS, ratingPlatformIndex: 0, ratingValue: ''
  },

  onLoad(options = {}) {
    this.active = true
    this.openComposerOnShow = options.composer === '1'
    this.composerKindOnShow = ['availability', 'tip'].includes(options.kind) ? options.kind : 'availability'
    this.returnAfterComposer = options.from === 'home'
  },

  onShow() {
    this.active = true
    if (this.openComposerOnShow) {
      this.openComposerOnShow = false
      const kind = this.composerKindOnShow
      this.composerKindOnShow = 'availability'
      this.openComposer(kind)
    }
    const loading = this.data.activeSection === 'friends'
      ? this.loadFriends({ reset: true, keepContent: this.data.state === 'ready' })
      : this.loadUpdates({ reset: true, keepContent: this.data.updatesState === 'ready' })
    return loading
  },

  onHide() {
    this.active = false
    this.loadSequence = Number(this.loadSequence || 0) + 1
    this.updateLoadSequence = Number(this.updateLoadSequence || 0) + 1
  },
  onUnload() { this.onHide() },

  onPullDownRefresh() {
    const work = this.data.activeSection === 'friends'
      ? this.loadFriends({ reset: true, keepContent: true, fresh: true, interactive: true })
      : this.loadUpdates({ reset: true, keepContent: true, fresh: true, interactive: true })
    return Promise.resolve(work).finally(() => wx.stopPullDownRefresh())
  },

  switchSection(event) {
    const section = event.currentTarget.dataset.section
    if (!['updates', 'friends'].includes(section) || section === this.data.activeSection) return
    this.setData({ activeSection: section })
    if (section === 'updates' && this.data.updatesState === 'idle') this.loadUpdates({ reset: true })
    if (section === 'friends' && this.data.state === 'idle') this.loadFriends({ reset: true })
  },

  async resolveAvatars(records) {
    const fileIds = Array.from(new Set(records.map(item => item && item.avatarFileId).filter(Boolean)))
    if (!fileIds.length) return {}
    try { return (await api.files.resolve(fileIds)).urls || {} } catch (_) { return {} }
  },

  async loadUpdates(options = {}) {
    const reset = options.reset !== false
    if (this.updatesLoading && !options.fresh) return this.updatesLoading
    const page = reset ? 1 : this.data.updatesPage + 1
    const sequence = this.updateLoadSequence = Number(this.updateLoadSequence || 0) + 1
    if (options.fresh && api.invalidateReads) api.invalidateReads()
    this.setData(reset
      ? options.keepContent ? { updatesError: '', updatesLoadingMore: false } : { updatesState: 'loading', updatesError: '', updates: [], updatesLoadingMore: false }
      : { updatesLoadingMore: true, updatesError: '' })
    const task = (async () => {
      try {
        await getApp().ensureSession({ interactive: options.interactive === true })
        const result = await api.friendUpdates.list({ page, pageSize: PAGE_SIZE })
        const rawItems = result.items || []
        const urls = await this.resolveAvatars(rawItems.map(item => item.author || {}))
        if (!this.active || sequence !== this.updateLoadSequence) return false
        const incoming = rawItems.map(item => playerUpdates.presentUpdate(item, urls[item.author && item.author.avatarFileId] || ''))
        this.setData({ updatesState: 'ready', updates: reset ? incoming : this.data.updates.concat(incoming),
          updatesPage: Number(result.page || page), updatesHasMore: result.hasMore === true, updatesLoadingMore: false, updatesError: '' })
        return true
      } catch (error) {
        if (!this.active || sequence !== this.updateLoadSequence) return false
        const message = errors.message(error, '动态暂未更新')
        if ((!reset || options.keepContent) && this.data.updates.length) this.setData({ updatesState: 'ready', updatesLoadingMore: false, updatesError: message })
        else this.setData({ updatesState: 'error', updatesLoadingMore: false, updatesError: message })
        return false
      }
    })()
    this.updatesLoading = task
    try { return await task } finally { if (this.updatesLoading === task) this.updatesLoading = null }
  },

  async loadFriends(options = {}) {
    const reset = options.reset !== false
    if (this.loading && !options.fresh) return this.loading
    const page = reset ? 1 : this.data.page + 1
    const sequence = this.loadSequence = Number(this.loadSequence || 0) + 1
    if (options.fresh && api.invalidateReads) api.invalidateReads()
    this.setData(reset
      ? options.keepContent ? { errorMessage: '', loadingMore: false } : { state: 'loading', errorMessage: '', items: [], loadingMore: false }
      : { loadingMore: true, errorMessage: '' })
    const task = (async () => {
      try {
        await getApp().ensureSession({ interactive: options.interactive === true })
        const result = await api.friends.list({ page, pageSize: PAGE_SIZE })
        const rawItems = result.items || []
        const urls = await this.resolveAvatars(rawItems.map(item => item.player || {}))
        if (!this.active || sequence !== this.loadSequence) return false
        const incoming = rawItems.map(item => presentFriend(item, urls[item.player && item.player.avatarFileId] || ''))
        this.setData({ state: 'ready', items: reset ? incoming : this.data.items.concat(incoming), page: Number(result.page || page), hasMore: result.hasMore === true, loadingMore: false, errorMessage: '' })
        return true
      } catch (error) {
        if (!this.active || sequence !== this.loadSequence) return false
        if ((!reset || options.keepContent) && this.data.items.length) this.setData({ state: 'ready', loadingMore: false, errorMessage: errors.message(error, '球友列表暂未更新') })
        else this.setData({ state: 'error', loadingMore: false, errorMessage: errors.message(error) })
        return false
      }
    })()
    this.loading = task
    try { return await task } finally { if (this.loading === task) this.loading = null }
  },

  loadMoreUpdates() { if (!this.data.updatesLoadingMore && this.data.updatesHasMore) return this.loadUpdates({ reset: false }); return false },
  loadMore() { if (!this.data.loadingMore && this.data.hasMore) return this.loadFriends({ reset: false }); return false },
  retryUpdates() { return this.loadUpdates({ reset: true, interactive: true }) },
  retry() { return this.loadFriends({ reset: true, interactive: true }) },

  async openComposer(source = {}) {
    if (this.data.submitting || this.data.removingId) return
    try {
      const session = await getApp().ensureSession({ interactive: true })
      const profile = session && session.profile || {}
      const district = DISTRICTS.includes(profile.district) ? profile.district : '滨江区'
      const requestedKind = typeof source === 'string' ? source : source.currentTarget && source.currentTarget.dataset && source.currentTarget.dataset.kind
      const kind = ['availability', 'tip'].includes(requestedKind) ? requestedKind : 'availability'
      this.setData({ composerVisible: true, formError: '', kind,
        districtIndex: Math.max(0, DISTRICTS.indexOf(district)), availabilityIndex: 1,
        customAvailability: '', timeNote: '', venueName: '', content: '',
        ratingPlatformIndex: 0, ratingValue: '' })
    } catch (error) { if (error.code !== 'LOGIN_REQUIRED') errors.toast(error) }
  },

  closeComposer() {
    if (this.data.submitting) return
    if (this.returnAfterComposer) {
      this.returnAfterComposer = false
      wx.navigateBack({ delta: 1 })
      return
    }
    this.setData({ composerVisible: false, formError: '' })
  },
  noop() {},
  changeKind(event) { if (!this.data.submitting) this.setData({ kind: event.currentTarget.dataset.kind, formError: '' }) },
  changeDistrict(event) { if (!this.data.submitting) this.setData({ districtIndex: Number(event.detail.value), formError: '' }) },
  changeAvailability(event) { if (!this.data.submitting) this.setData({ availabilityIndex: Number(event.detail.value), formError: '' }) },
  changeCustomAvailability(event) { if (!this.data.submitting) this.setData({ customAvailability: String(event.detail.value || '').slice(0, 40), formError: '' }) },
  changeTimeNote(event) { if (!this.data.submitting) this.setData({ timeNote: String(event.detail.value || '').slice(0, 60), formError: '' }) },
  changeVenueName(event) { if (!this.data.submitting) this.setData({ venueName: String(event.detail.value || '').slice(0, 50), formError: '' }) },
  changeContent(event) { if (!this.data.submitting) this.setData({ content: String(event.detail.value || '').slice(0, 500), formError: '' }) },
  changeRatingPlatform(event) {
    const ratingPlatformIndex = Number(event.detail.value)
    this.setData({ ratingPlatformIndex, ratingValue: ratingPlatformIndex === 0 ? '' : this.data.ratingValue, formError: '' })
  },
  changeRatingValue(event) { this.setData({ ratingValue: String(event.detail.value || '').replace(/\D/g, '').slice(0, 4), formError: '' }) },

  availabilityValue() {
    return this.data.availabilityIndex === AVAILABILITY_OPTIONS.length - 1
      ? this.data.customAvailability.trim() : AVAILABILITY_OPTIONS[this.data.availabilityIndex]
  },

  validateForm() {
    if (this.data.kind === 'availability' && !DISTRICTS[this.data.districtIndex]) return '请选择地区'
    if (this.data.kind === 'availability' && this.availabilityValue().length < 2) return '请填写大致可约时间'
    if (this.data.kind === 'tip' && this.data.content.trim().length < 2) return '写下想分享的心得或技巧'
    if (this.data.ratingPlatformIndex > 0 && !this.data.ratingValue) return '选择积分平台后请填写积分'
    return ''
  },

  updatePayload() {
    const payload = {
      kind: this.data.kind,
      content: this.data.content,
      ratingPlatform: RATING_PLATFORMS[this.data.ratingPlatformIndex],
      ratingValue: this.data.ratingValue
    }
    if (this.data.kind === 'availability') Object.assign(payload, {
      district: DISTRICTS[this.data.districtIndex],
      availabilityText: this.availabilityValue(),
      timeNote: this.data.timeNote,
      venueName: this.data.venueName
    })
    return payload
  },

  async submitUpdate() {
    if (this.data.submitting) return
    const formError = this.validateForm()
    if (formError) return this.setData({ formError })
    this.setData({ submitting: true, formError: '' })
    try {
      await api.friendUpdates.publish(this.updatePayload())
      this.setData({ composerVisible: false, submitting: false })
      wx.showToast({ title: '动态已发布', icon: 'success' })
      if (this.returnAfterComposer) {
        this.returnAfterComposer = false
        wx.navigateBack({ delta: 1 })
        return true
      }
      await this.loadUpdates({ reset: true, keepContent: true, fresh: true })
    } catch (error) { this.setData({ submitting: false, formError: errors.message(error) }) }
  },

  withdrawUpdate(event) {
    const updateId = event.currentTarget.dataset.id
    if (this.data.removingId || !updateId) return
    wx.showModal({ title: '撤下这条动态？', content: '撤下后，这条动态和其中的交流将不再公开显示。', confirmText: '撤下', confirmColor: '#a9483d',
      success: async result => {
        if (!result.confirm) return
        this.setData({ removingId: updateId })
        try {
          await api.friendUpdates.remove({ updateId })
          this.setData({ updates: this.data.updates.filter(item => item.id !== updateId), removingId: '' })
          wx.showToast({ title: '已撤下', icon: 'none' })
        } catch (error) { this.setData({ removingId: '' }); errors.toast(error, '撤下失败，请重试') }
      } })
  },

  useUpdate(event) {
    const update = this.data.updates.find(item => item.id === event.currentTarget.dataset.id)
    if (!update || update.kind !== 'availability') return
    const prepared = clientState.setPublishPrefill({ source: 'player-update', district: update.district,
      availabilityText: update.availabilityText, timeNote: update.timeNote, venueName: update.venueName })
    if (!prepared) {
      wx.showToast({ title: '暂时无法准备发布内容，请稍后重试', icon: 'none' })
      return
    }
    wx.switchTab({ url: '/pages/publish/publish' })
  },
  openUpdate(event) {
    const updateId = event.currentTarget.dataset.id
    if (updateId) wx.navigateTo({ url: `/pages/update-detail/update-detail?id=${encodeURIComponent(updateId)}&reply=1` })
  },
  openUpdateDetail(event) {
    const updateId = event.currentTarget.dataset.id
    if (updateId) wx.navigateTo({ url: `/pages/update-detail/update-detail?id=${encodeURIComponent(updateId)}` })
  },
  openUpdatePlayer(event) {
    const playerId = event.currentTarget.dataset.id
    if (playerId) wx.navigateTo({ url: `/pages/player-detail/player-detail?id=${encodeURIComponent(playerId)}` })
  },
  openPlayer(event) {
    const playerId = event.currentTarget.dataset.id
    if (playerId) wx.navigateTo({ url: `/pages/player-detail/player-detail?id=${encodeURIComponent(playerId)}` })
  },
  goHome() { wx.switchTab({ url: '/pages/home/home' }) }
})

module.exports = { presentFriend, presentUpdate: playerUpdates.presentUpdate, DISTRICTS, RATING_PLATFORMS, AVAILABILITY_OPTIONS }
