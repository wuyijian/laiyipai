const api = require('../../utils/api')
const present = require('../../utils/present')
const errors = require('../../utils/error')
const clientState = require('../../utils/client-state')
const cloudConfig = require('../../utils/cloud-config')
const share = require('../../utils/share')
const matchShare = require('../../utils/match-share')
const arrangement = require('../../utils/match-arrangement')
const messageNotifier = require('../../utils/message-notifier')
const mapHelper = require('../../utils/map')
const { detailState } = require('../../utils/match-detail-state')

Page({
  data: {
    id: '',
    state: 'loading',
    notFound: false,
    errorMessage: '',
    match: null,
    membership: null,
    joinSheet: false,
    resultSheet: false,
    submitting: false,
    joinError: '',
    joinNeedsRefresh: false,
    resultTone: '已提交',
    resultToneClass: 'pending',
    resultTitle: '',
    resultCopy: '',
    resultActionText: '查看申请状态',
    resultCanChat: false,
    resultStatus: '',
    canChat: false,
    messageUnreadCount: '',
    favoriteSaving: false,
    favoriteStatus: 'unknown',
    loggedIn: false
  },

  onLoad(options) {
    share.disable()
    this.setData({ id: options && options.id || '' })
    this.unsubscribeMessages = messageNotifier.subscribe((state) => {
      const item = state.items.find((entry) => entry.matchId === this.data.id)
      this.setData({ messageUnreadCount: item ? (item.unreadCount > 99 ? '99+' : String(item.unreadCount || 1)) : '' })
    })
  },

  onUnload() { if (this.unsubscribeMessages) this.unsubscribeMessages() },

  onReady() { this.prepareShareCard() },

  prepareShareCard() {
    const match = this.data.match
    if (!match || !match.shareable) return Promise.resolve('')
    const key = JSON.stringify([match.id, matchShare.details(match)])
    if (this.shareCardKey === key && (this.shareCardImage || this.shareCardTask)) return this.shareCardTask || Promise.resolve(this.shareCardImage)
    this.shareCardKey = key
    this.shareCardImage = ''
    const previous = this.shareCardTask || Promise.resolve()
    const task = previous.then(() => matchShare.render(this, match)).then((image) => {
      if (this.shareCardKey === key) this.shareCardImage = image
      return image
    }).finally(() => { if (this.shareCardTask === task) this.shareCardTask = null })
    this.shareCardTask = task
    return task
  },

  async onShow() {
    const pending = this.pendingJoinIntent
    const loggedIn = this.hasActiveSession()
    if (pending && !loggedIn) this.clearPendingJoinIntent()
    const loaded = await this.loadMatch({
      keepContent: Boolean(this.data.match),
      force: Boolean(pending && loggedIn)
    })
    if (pending && loggedIn && this.pendingJoinIntent === pending) {
      this.restorePendingJoinIntent(pending, loaded)
    }
    return loaded
  },

  onPullDownRefresh() {
    this.loadMatch({ keepContent: Boolean(this.data.match) }).finally(() => wx.stopPullDownRefresh())
  },

  async loadMatch(options = {}) {
    const keepContent = Boolean(options.keepContent && this.data.match)
    const force = Boolean(options.force)
    if (!this.data.id) {
      share.disable()
      this.setData({ state: 'error', notFound: true, errorMessage: '缺少球局编号' })
      return
    }
    if (this.loading && !force) return this.loading
    const requestSequence = Number(this.loadRequestSequence || 0) + 1
    const membershipRevision = Number(this.membershipRevision || 0)
    const favoriteRevision = Number(this.favoriteRevision || 0)
    this.loadRequestSequence = requestSequence
    this.latestLoadRequestSequence = requestSequence
    const isStale = () => requestSequence !== this.latestLoadRequestSequence || membershipRevision !== Number(this.membershipRevision || 0)
    if (!keepContent) {
      share.disable()
      this.setData({ state: 'loading', errorMessage: '', notFound: false })
    }
    const task = (async () => {
      try {
        const app = getApp()
        const loggedIn = Boolean(app.globalData && app.globalData.session)
        const readOptions = { publicRead: !loggedIn }
        if (isStale()) return false
        const result = await api.matches.get({ matchId: this.data.id }, readOptions)
        if (isStale()) return false
        const previousMatch = this.data.match && this.data.match.venueId === result.match.venueId
          ? this.data.match
          : null
        const membership = loggedIn ? result.membership || null : null
        let match = present.match(result.match)
        match = Object.assign(match, detailState(match, membership), {
          confirmedCount: Number(result.confirmedCount || 0),
          venueFavorited: Boolean(previousMatch && previousMatch.venueFavorited)
        })
        this.setData({ state: 'ready', match, membership, canChat: match.canChat, favoriteStatus: loggedIn ? 'unknown' : 'login', loggedIn })
        this.prepareShareCard()
        if (match.shareable) share.enable()
        else share.disable()
        const [venueResult, favoriteResult] = await Promise.all([
          result.match.venueId ? api.venues.get({ venueId: result.match.venueId }, readOptions).catch(() => null) : Promise.resolve(null),
          loggedIn && result.match.venueId
            ? api.favorites.status({ venueIds: [result.match.venueId] }).catch(() => ({ markedIds: [], unavailable: true }))
            : Promise.resolve({ markedIds: [], skipped: true })
        ])
        const venue = venueResult ? present.venue(venueResult) : null
        const favoriteIds = new Set(favoriteResult.markedIds || [])
        const venueFavorited = !loggedIn
          ? false
          : favoriteResult.unavailable
          ? Boolean(previousMatch && previousMatch.venueFavorited)
          : favoriteIds.has(result.match.venueId)
        const fileIds = []
        const venueCoverFileId = venueResult && Array.isArray(venueResult.coverFileIds) ? venueResult.coverFileIds[0] : ''
        if (venueCoverFileId) fileIds.push(venueCoverFileId)
        if (result.match.host && result.match.host.avatarFileId) fileIds.push(result.match.host.avatarFileId)
        ;(result.match.participants || []).forEach((item) => { if (item.avatarFileId) fileIds.push(item.avatarFileId) })
        const urls = await this.resolveFiles(fileIds, readOptions)
        if (isStale()) return false
        const canChat = match.canChat
        const favoriteChanged = favoriteRevision !== Number(this.favoriteRevision || 0)
        const nameOnlyVenue = Boolean(venue && venue.nameOnly)
        const resolvedLocation = nameOnlyVenue
          ? null
          : venue && venue.location || match.location || previousMatch && previousMatch.location || null
        match = Object.assign(match, {
          venueName: venue && venue.name || match.venueName,
          district: venue && venue.district || match.district || '',
          address: nameOnlyVenue ? '' : venue && venue.address || match.address,
          venueLocationText: nameOnlyVenue ? '' : venue && venue.locationText || match.venueLocationText,
          venueActivityTags: venue && venue.activityTags && venue.activityTags.length ? venue.activityTags : match.venueActivityTags,
          hasLocation: Boolean(resolvedLocation),
          location: resolvedLocation,
          venueFavorited: favoriteChanged ? Boolean(this.data.match.venueFavorited) : venueFavorited,
          shareImageUrl: urls[venueCoverFileId] || '',
          confirmedCount: Number(result.confirmedCount || 0),
          host: Object.assign({}, match.host, {
            avatarUrl: urls[match.host.avatarFileId] || ''
          }),
          participants: match.participants.map((item) => Object.assign({}, item, { avatarUrl: urls[item.avatarFileId] || '' }))
        })
        Object.assign(match, detailState(match, membership))
        const patch = {
          state: 'ready',
          match,
          membership,
          canChat,
          loggedIn,
          favoriteStatus: !loggedIn ? 'login' : favoriteChanged ? this.data.favoriteStatus : favoriteResult.unavailable
            ? 'unknown'
            : venueFavorited ? 'marked' : 'unmarked'
        }
        if (this.data.resultSheet && this.data.resultStatus === 'joined') {
          patch.resultCanChat = canChat
          patch.resultActionText = canChat ? '沟通时间和球台' : '查看预约状态'
        }
        this.setData(patch)
        this.prepareShareCard()
        if (['recruiting', 'full', 'changed'].includes(match.status)) share.enable()
        return true
      } catch (error) {
        if (isStale()) return false
        if (keepContent) {
          this.setData({ state: 'ready' })
          wx.showToast({ title: '暂未刷新，仍显示上次安排', icon: 'none' })
          return false
        }
        share.disable()
        this.setData({
          state: 'error',
          notFound: error && error.code === 'NOT_FOUND',
          errorMessage: errors.message(error, '球局暂时无法载入')
        })
        return false
      }
    })()
    this.loading = task
    try {
      return await task
    } finally {
      if (this.loading === task) this.loading = null
    }
  },

  async resolveFiles(fileIds, options = { publicRead: !this.data.loggedIn }) {
    if (!fileIds.length || !api.files || !api.files.resolve) return {}
    try {
      const result = await api.files.resolve(Array.from(new Set(fileIds)), options)
      return result.urls || {}
    } catch (_) {
      return {}
    }
  },

  async primaryAction() {
    const match = this.data.match
    if (!match || this.data.submitting || match.actionDisabled) return
    if (match.actionKind === 'orders') return this.goOrders()
    if (match.actionKind === 'chat') return this.goChat()
    if (match.actionKind === 'home') return this.goHome()
    if (match.actionKind === 'confirm') {
      if (!(await this.ensureInteractiveSession())) return
      return this.confirmNewTime()
    }
    if (this.data.loggedIn && this.hasActiveSession()) {
      this.setData({ loggedIn: true, joinSheet: true, joinError: '' })
      return
    }
    const intent = { matchId: this.data.id }
    this.pendingJoinIntent = intent
    if (!(await this.ensureInteractiveSession())) {
      if (this.lastInteractiveSessionError !== 'LOGIN_REQUIRED') this.clearPendingJoinIntent()
      return
    }
    const loaded = await this.loadMatch({ keepContent: true, force: true })
    this.restorePendingJoinIntent(intent, loaded)
  },

  hasActiveSession() {
    const app = getApp()
    return Boolean(app.globalData && app.globalData.session)
  },

  clearPendingJoinIntent() {
    this.pendingJoinIntent = null
    if (this.data.joinSheet) this.setData({ joinSheet: false, joinError: '' })
  },

  restorePendingJoinIntent(intent, loaded) {
    if (!intent || this.pendingJoinIntent !== intent) return false
    this.pendingJoinIntent = null
    const match = this.data.match
    const joinable = loaded === true && this.data.state === 'ready' && match &&
      intent.matchId === this.data.id && match.actionKind === 'join' &&
      !match.actionDisabled && Number(match.capacity || 0) > 1
    if (!joinable) {
      this.setData({ joinSheet: false, joinError: '' })
      wx.showToast({ title: '球局状态已变化，请查看最新信息', icon: 'none' })
      return false
    }
    this.setData({ joinSheet: true, joinError: '' })
    return true
  },

  async ensureInteractiveSession() {
    if (this.data.loggedIn && getApp().globalData && getApp().globalData.session) return true
    this.lastInteractiveSessionError = ''
    try {
      await getApp().ensureSession({ interactive: true })
      this.setData({ loggedIn: true })
      return true
    } catch (error) {
      this.lastInteractiveSessionError = error && error.code || 'UNKNOWN'
      if (error && error.code !== 'LOGIN_REQUIRED') errors.toast(error, '暂时无法登录，请稍后重试')
      return false
    }
  },

  async confirmNewTime() {
    if (this.data.submitting || !this.data.match.needsConfirmation) return
    if (!(await this.ensureInteractiveSession())) return
    this.setData({ submitting: true })
    try {
      await api.matches.confirmSchedule({ matchId: this.data.id })
      wx.showToast({ title: '已确认新时间', icon: 'success' })
      await this.loadMatch({ keepContent: true, force: true })
    } catch (error) {
      errors.toast(error, '确认失败，请重试')
    } finally {
      this.setData({ submitting: false })
    }
  },

  closeJoin() {
    if (!this.data.submitting) {
      this.pendingJoinIntent = null
      this.setData({ joinSheet: false, joinError: '' })
    }
  },

  async confirmJoin() {
    if (this.data.submitting) return
    if (this.data.joinNeedsRefresh) return this.retryJoinArrangement()
    if (this.data.match && this.data.match.capacity === 1) {
      this.setData({ joinSheet: false, joinError: '' })
      return wx.showToast({ title: '单人练习不开放加入', icon: 'none' })
    }
    this.setData({ submitting: true, joinError: '' })
    if (!(await this.ensureInteractiveSession())) {
      this.setData({ submitting: false })
      return
    }
    this.joinRequestId = this.joinRequestId || api.createRequestId()
    try {
      const result = await api.matches.join({
        matchId: this.data.id,
        allowWaitlist: this.data.match.seats === 0,
        expectedScheduleVersion: Number(this.data.match.scheduleVersion || 1),
        expectedFeePerPerson: Number(this.data.match.feePerPerson || 0),
        termsAccepted: true,
        termsVersion: cloudConfig.termsVersion
      }, { requestId: this.joinRequestId })
      const status = result && result.membership && result.membership.status
      if (!['joined', 'pending', 'waitlisted'].includes(status)) throw new Error('加入状态暂时无法确认，请到预约页查看')
      this.joinRequestId = ''
      const canChat = status === 'joined' && Boolean(result.membership.canChat)
      const courtBookingNotice = this.data.match.courtBookingNotice || '加入球局不等于向球馆预订，球台请与发起人确认。'
      const outcome = status === 'joined'
        ? {
            tone: '名额已确认',
            toneClass: 'success',
            title: '加入成功',
            copy: `${canChat ? '已为你保留名额，不用再发加入申请。需要确认球台或临时有变化时，再进入球局沟通。' : '名额已经确认，可到预约页查看最新安排。'}${courtBookingNotice}`,
            actionText: canChat ? '沟通时间和球台' : '查看预约状态'
          }
        : status === 'waitlisted'
          ? {
              tone: '候补已提交',
              toneClass: 'pending',
              title: '已加入候补',
              copy: `你还没有获得名额，也不能进入球局对话；有空位时由发起人处理。${courtBookingNotice}`,
              actionText: '查看候补状态'
            }
          : {
              tone: '申请已提交',
              toneClass: 'pending',
              title: '申请已发送',
              copy: `你尚未加入球局，也不能进入球局对话；发起人同意后才会获得名额。${courtBookingNotice}`,
              actionText: '查看申请状态'
            }
      const updatedMatch = result.match ? Object.assign({}, this.data.match, present.match(result.match)) : Object.assign({}, this.data.match)
      Object.assign(updatedMatch, detailState(updatedMatch, result.membership))
      this.membershipRevision = Number(this.membershipRevision || 0) + 1
      this.setData({
        state: 'ready',
        submitting: false,
        joinSheet: false,
        resultSheet: true,
        resultTone: outcome.tone,
        resultToneClass: outcome.toneClass,
        resultTitle: outcome.title,
        resultCopy: outcome.copy,
        resultActionText: outcome.actionText,
        resultCanChat: canChat,
        resultStatus: status,
        membership: result.membership,
        canChat,
        match: updatedMatch
      })
      await this.loadMatch({ keepContent: true, force: true })
    } catch (error) {
      if (['MATCH_FULL', 'MATCH_CLOSED', 'ARRANGEMENT_CHANGED'].includes(error.code)) {
        // These are explicit rejections before any join write. Refresh the
        // arrangement, but never turn the same tap into a waitlist application.
        this.joinRequestId = ''
        const refreshed = await this.loadMatch({ keepContent: true, force: true })
        const joinSheet = !refreshed || this.data.match.actionKind === 'join'
        this.setData({ submitting: false, joinSheet, joinNeedsRefresh: !refreshed, joinError: errors.message(error) + (refreshed ? '，请核对最新信息后再决定。' : '，请先重新加载球局。') })
        if (!joinSheet) errors.toast(error)
        return
      }
      this.setData({ submitting: false, joinError: errors.message(error) })
    }
  },

  async retryJoinArrangement() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    const refreshed = await this.loadMatch({ keepContent: true, force: true })
    this.setData({
      submitting: false,
      joinNeedsRefresh: !refreshed,
      joinSheet: !refreshed || this.data.match.actionKind === 'join',
      joinError: refreshed ? '已更新安排，请核对后再确认。' : '仍未能核对最新安排，请稍后重试。'
    })
  },

  copyArrangement() {
    if (!this.data.match || this.data.state !== 'ready') return
    wx.setClipboardData({
      data: arrangement.text(this.data.match),
      success: () => wx.showToast({ title: '安排已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' })
    })
  },

  closeResult() {
    this.setData({ resultSheet: false })
  },

  openVenue() {
    if (this.data.match.venueId) wx.navigateTo({ url: `/pages/venue-detail/venue-detail?id=${this.data.match.venueId}` })
  },

  openPlayer(event) {
    const playerId = event.currentTarget.dataset.id
    if (!playerId || /^deleted_/.test(playerId)) return wx.showToast({ title: '该球友资料已不可见', icon: 'none' })
    wx.navigateTo({ url: `/pages/player-detail/player-detail?id=${playerId}` })
  },

  openTerms() {
    wx.navigateTo({ url: '/pages/settings/settings?section=terms' })
  },

  openMap() {
    const match = this.data.match
    if (!match) return wx.showToast({ title: '暂无可显示的位置', icon: 'none' })
    mapHelper.openLocation(match.venueName, match.address, match.location, match.hasLocation, {
      copyHint: true,
      noLocationMessage: '暂无地图位置，请加入后确认',
      failMessage: '地图暂时无法打开，请稍后重试'
    })
  },

  async toggleFavorite() {
    const match = this.data.match
    if (this.data.favoriteSaving || !match || !match.venueId) return
    if (!(await this.ensureInteractiveSession())) return
    if (this.data.favoriteStatus === 'unknown') return this.refreshFavoriteStatus()
    if (this.data.favoriteStatus === 'login') return this.refreshFavoriteStatus()
    const marked = !match.venueFavorited
    const previousStatus = this.data.favoriteStatus
    this.favoriteRevision = Number(this.favoriteRevision || 0) + 1
    this.setData({
      favoriteSaving: true,
      favoriteStatus: marked ? 'marked' : 'unmarked',
      'match.venueFavorited': marked
    })
    try {
      await api.favorites.set({ venueId: match.venueId, marked })
      wx.showToast({ title: marked ? '已标记球馆' : '已取消标记', icon: 'none' })
    } catch (error) {
      this.setData({ favoriteStatus: previousStatus, 'match.venueFavorited': !marked })
      errors.toast(error, '标记失败，请重试')
    } finally {
      this.setData({ favoriteSaving: false })
    }
  },

  async refreshFavoriteStatus() {
    const match = this.data.match
    if (this.data.favoriteSaving || !match || !match.venueId) return
    this.setData({ favoriteSaving: true })
    this.favoriteRevision = Number(this.favoriteRevision || 0) + 1
    try {
      const result = await api.favorites.status({ venueIds: [match.venueId] })
      const favorited = (result.markedIds || []).includes(match.venueId)
      this.setData({
        favoriteStatus: favorited ? 'marked' : 'unmarked',
        'match.venueFavorited': favorited
      })
    } catch (error) {
      errors.toast(error, '标记状态暂时无法确认，请重试')
    } finally {
      this.setData({ favoriteSaving: false })
    }
  },

  openMoreActions() {
    if (this.data.membership && this.data.membership.status === 'host') {
      return wx.showToast({ title: '不能举报或屏蔽自己', icon: 'none' })
    }
    wx.showActionSheet({
      itemList: ['举报球局信息', '屏蔽发起人'],
      success: (result) => {
        if (result.tapIndex === 0) this.reportMatch()
        if (result.tapIndex === 1) this.blockHost()
      }
    })
  },

  reportMatch() {
    if (this.data.membership && this.data.membership.status === 'host') return
    wx.showActionSheet({
      itemList: ['信息不实', '疑似诈骗或诱导转账', '不安全或不当内容', '其他问题'],
      success: async (result) => {
        const options = [
          { category: 'false_information', details: '用户反馈球局信息不实' },
          { category: 'fraud', details: '用户反馈疑似诈骗或诱导转账' },
          { category: 'unsafe_content', details: '用户反馈存在不安全或不当内容' },
          { category: 'other', details: '' }
        ]
        try {
          await api.safety.report(Object.assign({ targetType: 'match', targetId: this.data.id }, options[result.tapIndex]), { requestId: api.createRequestId() })
          wx.showToast({ title: '举报已提交', icon: 'success' })
        } catch (error) {
          errors.toast(error)
        }
      }
    })
  },

  blockHost() {
    if (this.data.membership && this.data.membership.status === 'host') return
    const playerId = this.data.match.host.playerId
    if (!playerId) return wx.showToast({ title: '暂时无法屏蔽该用户', icon: 'none' })
    wx.showModal({
      title: '屏蔽发起人',
      content: '屏蔽后，双方不会在推荐列表中互相出现，对方消息也会被隐藏。',
      confirmText: '确认屏蔽',
      success: async (result) => {
        if (!result.confirm) return
        try {
          await api.safety.block({ playerId, blocked: true })
          wx.showToast({ title: '已屏蔽', icon: 'success' })
          wx.navigateBack()
        } catch (error) {
          errors.toast(error)
        }
      }
    })
  },

  goChat() {
    if (!this.data.canChat) return wx.showToast({ title: '加入确认后可进入球局对话', icon: 'none' })
    this.setData({ resultSheet: false })
    wx.navigateTo({ url: `/pages/chat/chat?id=${this.data.id}` })
  },

  editMatch() {
    if (!this.data.match || !this.data.match.canEdit) return wx.showToast({ title: '当前球局不能修改', icon: 'none' })
    wx.navigateTo({ url: `/pages/match-edit/match-edit?id=${encodeURIComponent(this.data.id)}` })
  },

  goOrders() {
    if (this.data.match && this.data.match.isHost) clientState.requestJoinRequests()
    this.setData({ resultSheet: false })
    wx.switchTab({ url: '/pages/orders/orders' })
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' })
  },

  noop() {},

  onShareAppMessage() {
    const match = this.data.match
    const payload = share.appMessage({
      title: match ? matchShare.title(match) : '搭拍子乒乓球局',
      titleLimit: 128,
      path: `/pages/match-detail/match-detail?id=${encodeURIComponent(this.data.id)}`,
      imageUrl: this.shareCardImage
    })
    if (!this.shareCardImage && match && match.shareable) {
      payload.promise = this.prepareShareCard().then((imageUrl) => Object.assign({}, payload, imageUrl ? { imageUrl } : {}, { promise: undefined }))
    }
    return payload
  },

  onShareTimeline() {
    const match = this.data.match
    return share.timeline({
      title: match ? matchShare.title(match) : '搭拍子乒乓球局',
      titleLimit: 128,
      params: { id: this.data.id },
      imageUrl: match && match.shareImageUrl
    })
  }
})
