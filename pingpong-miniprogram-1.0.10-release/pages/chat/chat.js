const api = require('../../utils/api')
const dateUtil = require('../../utils/date')
const present = require('../../utils/present')
const errors = require('../../utils/error')
const chatState = require('../../utils/chat-state')
const mapHelper = require('../../utils/map')
const messageNotifier = require('../../utils/message-notifier')

Page({
  data: {
    id: '', state: 'loading', forbidden: false, errorMessage: '',
    match: null, membership: null, messages: [], nextCursor: null,
    loadingOlder: false, inputValue: '', canSend: false, sending: false,
    scrollIntoView: '', newMessageCount: 0, syncError: '', sendError: '',
    keyboardHeight: 0, inputFocus: false,
    quickReplies: ['球台订好了吗？', '在哪个位置集合？', '我会晚到 10 分钟'],
    sheet: '', minimumDate: '', rescheduleDate: '', rescheduleStartTime: '', rescheduleEndTime: '',
    cancelReasons: ['临时有事', '时间不合适', '身体不适', '行程有变', '其他原因'],
    cancelReasonIndex: 0, actionBusy: false, sheetError: ''
  },

  onLoad(options) {
    this.avatarUrls = {}
    this.localSends = new Map()
    this.messageRevision = 0
    this.syncVersion = 0
    this._polling = false
    this._pollBoost = false
    this._lastSendAt = 0
    this.atBottom = true
    this.unsubscribeInbox = messageNotifier.subscribe((state) => {
      if (!this.visible || this.destroyed || this.data.state !== 'ready') return
      const item = state.items.find((entry) => entry.matchId === this.data.id)
      if (item && !this.data.messages.some((entry) => entry.id === item.messageId)) this.refreshMessages()
    })
    this.setData({ id: options && options.id || '', minimumDate: dateUtil.today() })
    if (!this.data.id) this.setData({ state: 'error', forbidden: true, errorMessage: '对话不存在或链接不完整' })
  },

  onShow() {
    this.visible = true
    messageNotifier.setActiveMatch(this.data.id)
    Promise.resolve(this.loadChat(this.data.state === 'ready')).then(() => {
      if (this.visible && !this.destroyed) this.startPolling()
    })
  },

  onHide() {
    this.visible = false
    messageNotifier.setActiveMatch('')
    this.stopPolling()
    this.setData({ keyboardHeight: 0, inputFocus: false })
  },

  onUnload() {
    this.destroyed = true
    this.visible = false
    messageNotifier.setActiveMatch('')
    this.stopPolling()
    if (this.unsubscribeInbox) this.unsubscribeInbox()
  },

  applyArrangement(result) {
    const membership = result.membership
    if (!membership || !membership.canChat) {
      const error = new Error(result.match && result.match.status === 'cancelled'
        ? '球局已取消，对话已关闭，可在预约中查看记录'
        : '只有已加入的球局成员可以进入对话')
      error.code = 'FORBIDDEN'
      throw error
    }
    const sameVenue = this.data.match && this.data.match.venueId === result.match.venueId
    const match = chatState.arrangement(result.match, membership, result.confirmedCount, sameVenue ? this.venue : null)
    const quickReplies = match.courtStatus === 'booked'
      ? ['在哪张球台见？', '我已经到球馆了', '我会晚到 10 分钟']
      : ['球台订好了吗？', '在哪个位置集合？', '我会晚到 10 分钟']
    this.setData({ match, membership, quickReplies })
  },

  decorate(messages) {
    return chatState.decorateMessages(messages, this.avatarUrls, this.data.match && this.data.match.host.playerId)
  },

  async loadChat(silent = false) {
    if (!this.data.id || this.loading || this.destroyed) return this.loading
    const hadReadyState = this.data.state === 'ready'
    if (!hadReadyState) this.setData({ state: 'loading', errorMessage: '', forbidden: false })
    const syncVersion = ++this.syncVersion
    this.loading = (async () => {
      try {
        await getApp().ensureSession({ interactive: Boolean(silent && silent.currentTarget) })
        const revision = this.messageRevision
        const [matchResult, messageResult] = await Promise.all([
          api.matches.get({ matchId: this.data.id }),
          api.messages.list({ matchId: this.data.id, pageSize: 50 })
        ])
        if (this.destroyed || syncVersion !== this.syncVersion) return
        this.applyArrangement(matchResult)
        this.applyMessageResult(messageResult, revision, !hadReadyState)
        this.setData({ state: 'ready', syncError: '' })
        // Venue details and avatar URLs never block conversation or sending.
        this.enrichConversation()
      } catch (error) {
        if (this.destroyed || syncVersion !== this.syncVersion) return
        if (!this.handleAccessError(error)) {
          if (hadReadyState) this.setData({ syncError: '消息同步暂停，正在保留当前内容' })
          else this.setData({ state: 'error', forbidden: false, errorMessage: errors.message(error) })
        }
      }
    })()
    try { await this.loading } finally { this.loading = null }
  },

  applyMessageResult(result, revision, initial = false) {
    const incoming = (result.items || []).map(present.message)
    const previous = this.data.messages
    const sentSinceFetch = Array.from(this.localSends || []).filter((entry) => entry[1] > revision).map((entry) => entry[0])
    const merged = initial ? chatState.mergeMessages(previous.filter((item) => item.deliveryState || sentSinceFetch.includes(item.id)), incoming)
      : chatState.reconcileMessages(previous, incoming, result.nextCursor, sentSinceFetch)
    const ids = new Set(previous.map((item) => item.id))
    const added = incoming.filter((item) => !ids.has(item.id) && !item.mine && item.type !== 'system').length
    const addedCount = added
    const patch = { messages: this.decorate(merged), syncError: '' }
    // Keep the history cursor once older pages have been loaded.
    if (initial || !this.hasLoadedHistory) patch.nextCursor = result.nextCursor || null
    if (!result.nextCursor) patch.nextCursor = null
    if (!this.atBottom && !initial) patch.newMessageCount = this.data.newMessageCount + added
    this.setData(patch)
    if (this.visible !== false && (initial || this.atBottom)) this.markLatestIncomingRead(merged)
    if (initial || (this.atBottom && incoming.some((item) => !ids.has(item.id)))) this.scrollToLatest()
    ;(this.localSends || new Map()).forEach((value, id) => { if (value <= revision) this.localSends.delete(id) })
    return { addedCount }
  },

  markLatestIncomingRead(messages = this.data.messages) {
    if (this.visible === false || this.destroyed) return
    const latest = messages.slice().reverse().find((item) => item && !item.mine && item.type !== 'system')
    if (latest) messageNotifier.markRead(this.data.id, latest.id)
  },

  async enrichConversation() {
    const match = this.data.match
    if (!match) return
    const venueId = match.venueId
    if (venueId && this.enrichedVenueId !== venueId && !this.venueLoading) {
      this.venueLoading = true
      api.venues.get({ venueId }).then((raw) => {
        if (this.destroyed || !this.data.match || this.data.match.venueId !== venueId) return
        this.venue = present.venue(raw)
        this.enrichedVenueId = venueId
        this.setData({
          'match.address': this.venue.address,
          'match.hasLocation': this.venue.hasLocation,
          'match.location': this.venue.location,
          'match.venueLocationText': this.venue.locationText
        })
      }).catch(() => {}).finally(() => { this.venueLoading = false })
    }
    if (!api.files || !api.files.resolve || this.resolvingAvatars) return
    const senders = this.data.messages.map((item) => item.sender).concat(match.participants || [])
    const ids = Array.from(new Set(senders.filter(Boolean).map((item) => item.avatarFileId).filter((id) => id && !this.avatarUrls[id])))
    if (!ids.length) return
    this.resolvingAvatars = true
    try {
      const result = await api.files.resolve(ids)
      if (this.destroyed) return
      Object.assign(this.avatarUrls, result.urls || {})
      this.setData({ messages: this.decorate(this.data.messages) })
    } catch (_) {
      // The local racket avatar remains available on weak connections.
    } finally { this.resolvingAvatars = false }
  },

  handleAccessError(error) {
    if (!error || !['FORBIDDEN', 'NOT_FOUND', 'CHAT_CLOSED', 'MATCH_CLOSED'].includes(error.code)) return false
    this.stopPolling()
    this.syncVersion += 1
    this.setData({ state: 'error', forbidden: true, sheet: '', keyboardHeight: 0, inputFocus: false, errorMessage: errors.message(error) })
    return true
  },

  startPolling() {
    this.stopPolling()
    if (this.data.state !== 'ready' || this.visible === false || this.destroyed) return
    this._polling = true
    this._schedulePoll()
  },

  stopPolling() {
    this._polling = false
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
  },

  _quickPoll() {
    this._pollBoost = true
  },

  _getPollInterval() {
    const fast = this._pollBoost || this.data.newMessageCount > 0 || Date.now() - this._lastSendAt < 90000
    this._pollBoost = false
    return fast ? 3000 : 6000
  },

  _schedulePoll() {
    if (!this._polling || this.visible === false || this.destroyed || this.data.state !== 'ready') return
    const interval = this._getPollInterval()
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      this.refreshMessages().finally(() => this._schedulePoll())
    }, interval)
  },

  async refreshMessages() {
    if (this.refreshing || this.loading || this.data.actionBusy || this.data.state !== 'ready' || this.destroyed) return
    this.refreshing = true
    const revision = this.messageRevision
    const syncVersion = ++this.syncVersion
    try {
      await Promise.all([
        api.messages.list({ matchId: this.data.id, pageSize: 50 }).then((result) => {
          if (this.destroyed || syncVersion !== this.syncVersion) return
          const merged = this.applyMessageResult(result, revision)
          if (merged.addedCount > 0) this._quickPoll()
          this.enrichConversation()
        }),
        api.matches.get({ matchId: this.data.id }).then((result) => {
          if (!this.destroyed && syncVersion === this.syncVersion) this.applyArrangement(result)
        })
      ])
    } catch (error) {
      if (!this.destroyed && syncVersion === this.syncVersion && !this.handleAccessError(error)) this.setData({ syncError: '网络不稳定，消息暂未同步' })
    } finally { this.refreshing = false }
  },

  async loadOlderMessages() {
    if (!this.data.nextCursor || this.data.loadingOlder || this.destroyed) return
    const first = this.data.messages[0]
    this.atBottom = false
    this.setData({ loadingOlder: true })
    try {
      const result = await api.messages.list({ matchId: this.data.id, pageSize: 50, before: this.data.nextCursor })
      if (this.destroyed) return
      this.hasLoadedHistory = true
      this.setData({
        messages: this.decorate(chatState.mergeMessages((result.items || []).map(present.message), this.data.messages)),
        nextCursor: result.nextCursor || null,
        scrollIntoView: first ? first.domId : ''
      })
      this.enrichConversation()
    } catch (error) {
      if (!this.destroyed && !this.handleAccessError(error)) errors.toast(error)
    } finally { if (!this.destroyed) this.setData({ loadingOlder: false }) }
  },

  onMessageScroll(event) {
    const top = Number(event.detail.scrollTop || 0)
    if (this.lastScrollTop !== undefined && top < this.lastScrollTop - 8) this.atBottom = false
    this.lastScrollTop = top
  },

  onReachBottom() {
    this.atBottom = true
    this.setData({ newMessageCount: 0 })
    this.markLatestIncomingRead()
  },

  scrollToLatest() {
    const last = this.data.messages[this.data.messages.length - 1]
    this.atBottom = true
    this.setData({ scrollIntoView: '', newMessageCount: 0 }, () => {
      if (!this.destroyed) {
        this.setData({ scrollIntoView: last ? last.domId : '' })
        this.markLatestIncomingRead()
      }
    })
  },

  changeInput(event) {
    const inputValue = event.detail.value
    if (inputValue !== this.data.inputValue) this.messageRequestId = ''
    this.setData({ inputValue, canSend: Boolean(inputValue.trim()), sendError: '' })
  },

  useQuickReply(event) {
    if (this.data.sending || this.data.state !== 'ready') return
    const text = this.data.quickReplies[Number(event.currentTarget.dataset.index)]
    if (!text) return
    if (this.data.inputValue.trim()) return wx.showToast({ title: '先发送或清空已写的内容', icon: 'none' })
    this.messageRequestId = ''
    this.setData({ inputValue: text, canSend: true, inputFocus: true, sendError: '' })
  },

  onKeyboardHeightChange(event) {
    this.setData({ keyboardHeight: Math.max(0, Number(event.detail.height || 0)) })
    if (this.atBottom) this.scrollToLatest()
  },

  blurInput() { this.setData({ inputFocus: false }) },

  async sendMessage(event) {
    const retryId = event && event.currentTarget && event.currentTarget.dataset.requestId
    const retryMessage = retryId && this.data.messages.find((item) => item.clientRequestId === retryId && item.deliveryState === 'failed')
    if (retryId && !retryMessage) return
    const draft = this.data.inputValue
    const text = retryMessage ? retryMessage.text : draft.trim()
    if (!text || this.data.sending || this.data.state !== 'ready' || !this.data.membership || !this.data.membership.canChat) return
    const requestId = retryId || this.messageRequestId || api.createRequestId()
    if (!retryId) this.messageRequestId = requestId
    const localId = 'local_' + requestId
    const app = getApp()
    const profile = app.globalData && app.globalData.session && app.globalData.session.profile || {}
    const pending = {
      id: localId, clientRequestId: requestId, text, mine: true, type: 'text',
      sender: { playerId: profile.playerId || '', displayName: profile.nickname || '我' },
      createdAt: new Date().toISOString(), deliveryState: 'sending'
    }
    this.setData({ sending: true, sendError: '', messages: this.decorate(chatState.mergeMessages(this.data.messages, [pending])) })
    this.scrollToLatest()
    try {
      const result = await api.messages.send({ matchId: this.data.id, text }, { requestId })
      if (this.destroyed) return
      const message = present.message(Object.assign({}, result.message, { clientRequestId: requestId }))
      this._lastSendAt = Date.now()
      this._quickPoll()
      this.messageRevision += 1
      this.localSends.set(message.id, this.messageRevision)
      const patch = { sending: false, messages: this.decorate(chatState.mergeMessages(this.data.messages.filter((item) => item.id !== localId), [message])) }
      // A response to the previous message must never erase the next draft.
      if (this.data.inputValue === draft && draft.trim() === text) Object.assign(patch, { inputValue: '', canSend: false })
      if (this.messageRequestId === requestId) this.messageRequestId = ''
      this.setData(patch)
      this.scrollToLatest()
      this.enrichConversation()
    } catch (error) {
      if (this.destroyed) return
      const confirmed = this.data.messages.some((item) => item.clientRequestId === requestId && !item.deliveryState)
      this.setData({ sending: false, messages: this.decorate(this.data.messages.map((item) =>
        item.id === localId ? Object.assign({}, item, { deliveryState: 'failed' }) : item)) })
      if (confirmed) {
        if (this.messageRequestId === requestId) this.messageRequestId = ''
        if (this.data.inputValue.trim() === text) this.setData({ inputValue: '', canSend: false })
        return
      }
      if (!this.handleAccessError(error)) this.setData({ sendError: errors.message(error) + '。内容已保留，可修改或重试。' })
    }
  },

  openArrangement() {
    this.setData({ sheet: 'arrangement', sheetError: '', inputFocus: false, keyboardHeight: 0 })
    if (wx.hideKeyboard) wx.hideKeyboard()
  },

  async confirmSchedule() {
    if (this.data.actionBusy || !this.data.match || !this.data.match.canArrange) return
    this.syncVersion += 1
    this.setData({ actionBusy: true })
    try {
      await api.matches.confirmSchedule({ matchId: this.data.id })
      this.setData({ 'match.myScheduleConfirmed': true, 'match.needsConfirmation': false, actionBusy: false })
      wx.showToast({ title: '时间已确认', icon: 'success' })
      await this.loadChat(true)
    } catch (error) {
      this.setData({ actionBusy: false })
      errors.toast(error)
    }
  },

  openMap() {
    const match = this.data.match
    if (!match || (!match.hasLocation && !match.address)) {
      return wx.showToast({ title: '具体位置请在对话中确认', icon: 'none' })
    }
    mapHelper.openLocation(match.venueName, match.address, match.location, match.hasLocation, {
      copyHint: true,
      noLocationMessage: '具体位置请在对话中确认',
      failMessage: '地图暂时无法打开，请稍后重试'
    })
  },

  openMatch() {
    this.setData({ sheet: '' })
    wx.navigateTo({ url: `/pages/match-detail/match-detail?id=${this.data.id}` })
  },

  openReschedule() {
    if (!this.data.match || !this.data.match.canArrange) return
    this.setData({ sheet: 'reschedule', sheetError: '', rescheduleDate: this.data.match.date, rescheduleStartTime: this.data.match.startTime, rescheduleEndTime: this.data.match.endTime })
  },

  changeRescheduleDate(event) { this.setData({ rescheduleDate: event.detail.value, sheetError: '' }) },
  changeRescheduleStartTime(event) { this.setData({ rescheduleStartTime: event.detail.value, sheetError: '' }) },
  changeRescheduleEndTime(event) { this.setData({ rescheduleEndTime: event.detail.value, sheetError: '' }) },

  async submitReschedule() {
    if (this.data.actionBusy || !this.data.match || !this.data.match.canArrange) return
    if (!dateUtil.isFutureSchedule(this.data.rescheduleDate, this.data.rescheduleStartTime, 10)) return this.setData({ sheetError: '开始时间至少应晚于当前时间 10 分钟' })
    if (this.data.rescheduleEndTime <= this.data.rescheduleStartTime) return this.setData({ sheetError: '结束时间必须晚于开始时间' })
    this.syncVersion += 1
    this.setData({ actionBusy: true, sheetError: '' })
    try {
      if (this.data.match.isHost) {
        await api.matches.reschedule({
          matchId: this.data.id,
          expectedVersion: this.data.match.version,
          date: this.data.rescheduleDate,
          startTime: this.data.rescheduleStartTime,
          endTime: this.data.rescheduleEndTime
        }, { requestId: api.createRequestId() })
      } else {
        await api.messages.send({
          matchId: this.data.id,
          text: `能否改到 ${this.data.rescheduleDate} ${this.data.rescheduleStartTime}—${this.data.rescheduleEndTime}？等发起人确认，目前仍以原安排为准。`
        }, { requestId: api.createRequestId() })
      }
      this.setData({ actionBusy: false, sheet: '' })
      wx.showToast({ title: this.data.match.isHost ? '球局时间已更新' : '改期提议已发送', icon: 'none' })
      await this.loadChat(true)
    } catch (error) {
      this.setData({ actionBusy: false, sheetError: errors.message(error) })
    }
  },

  openCancel() {
    if (!this.data.match || !this.data.match.canArrange) return
    this.cancelRequestId = ''
    this.setData({ sheet: 'cancel', sheetError: '', cancelReasonIndex: 0 })
  },

  changeCancelReason(event) {
    this.cancelRequestId = ''
    this.setData({ cancelReasonIndex: Number(event.detail.value), sheetError: '' })
  },

  async confirmCancel() {
    if (this.data.actionBusy || !this.data.match || !this.data.match.canArrange) return
    this.syncVersion += 1
    this.setData({ actionBusy: true, sheetError: '' })
    this.cancelRequestId = this.cancelRequestId || api.createRequestId()
    try {
      await api.matches.cancel({
        matchId: this.data.id,
        expectedVersion: this.data.match.version,
        reason: this.data.cancelReasons[this.data.cancelReasonIndex]
      }, { requestId: this.cancelRequestId })
      this.cancelRequestId = ''
      this.setData({ actionBusy: false, sheet: '' })
      wx.showModal({
        title: this.data.match.isHost ? '球局已取消' : '已取消加入',
        content: '预约状态已经更新。',
        showCancel: false,
        success: () => wx.switchTab({ url: '/pages/orders/orders' })
      })
    } catch (error) {
      this.setData({ actionBusy: false, sheetError: errors.message(error) })
    }
  },

  closeSheet() {
    if (!this.data.actionBusy) this.setData({ sheet: '', sheetError: '' })
  },

  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' })
  },

  noop() {}
})
