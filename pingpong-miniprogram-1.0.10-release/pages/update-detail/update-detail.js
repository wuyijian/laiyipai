const api = require('../../utils/api')
const errors = require('../../utils/error')
const playerUpdates = require('../../utils/player-updates')
const clientState = require('../../utils/client-state')
const share = require('../../utils/share')

Page({
  data: {
    updateId: '', state: 'loading', errorMessage: '', update: null,
    comments: [], commentsLoading: false, commentsError: '', hasMore: false, page: 1,
    replyText: '', canSend: false, sending: false, sendError: '', inputFocused: false
  },

  onLoad(options = {}) {
    this.active = true
    this.focusReplyOnReady = options.reply === '1'
    this.setData({ updateId: String(options.id || '') })
    share.enable()
  },
  onShow() { this.active = true; return this.load() },
  onHide() { this.active = false; this.sequence = Number(this.sequence || 0) + 1 },
  onUnload() { this.onHide() },
  onPullDownRefresh() { return this.load({ fresh: true }).finally(() => wx.stopPullDownRefresh()) },

  async resolveAvatars(records) {
    const ids = Array.from(new Set(records.map(item => item && item.avatarFileId).filter(Boolean)))
    if (!ids.length) return {}
    try { return (await api.files.resolve(ids)).urls || {} } catch (_) { return {} }
  },

  async load(options = {}) {
    if (!this.data.updateId) return this.setData({ state: 'error', errorMessage: '动态地址不正确' })
    const append = options.append === true
    if (append && (this.data.commentsLoading || !this.data.hasMore)) return false
    const page = append ? this.data.page + 1 : 1
    const sequence = this.sequence = Number(this.sequence || 0) + 1
    if (options.fresh && api.invalidateReads) api.invalidateReads()
    if (!this.data.update) this.setData({ state: 'loading', errorMessage: '' })
    else this.setData({ commentsLoading: true, commentsError: '' })
    try {
      await getApp().ensureSession({ interactive: options.interactive === true })
      const result = await api.updateComments.list({ updateId: this.data.updateId, page, pageSize: 50 })
      const rawUpdate = result.update || (!this.data.update ? await api.friendUpdates.get({ updateId: this.data.updateId }) : null)
      const rawComments = result.items || []
      const urls = await this.resolveAvatars((rawUpdate ? [rawUpdate.author || {}] : []).concat(rawComments.map(item => item.author || {})))
      if (!this.active || sequence !== this.sequence) return false
      const update = rawUpdate
        ? playerUpdates.presentUpdate(rawUpdate, urls[rawUpdate.author && rawUpdate.author.avatarFileId] || '')
        : this.data.update
      const incoming = rawComments.map(item => playerUpdates.presentComment(item, urls[item.author && item.author.avatarFileId] || ''))
      const comments = append
        ? this.data.comments.concat(incoming.filter(item => !this.data.comments.some(existing => existing.id === item.id)))
        : incoming
      this.setData({ state: 'ready', errorMessage: '', update, comments, commentsLoading: false,
        commentsError: '', hasMore: result.hasMore === true, page: Number(result.page || page) }, () => {
        if (!this.focusReplyOnReady) return
        this.focusReplyOnReady = false
        this.setData({ inputFocused: true })
      })
      return true
    } catch (error) {
      if (!this.active || sequence !== this.sequence) return false
      const message = errors.message(error, '动态暂时无法加载')
      if (this.data.update) this.setData({ commentsLoading: false, commentsError: message })
      else this.setData({ state: 'error', errorMessage: message, commentsLoading: false })
      return false
    }
  },

  retry() { return this.load({ fresh: true, interactive: true }) },
  loadMoreComments() { return this.load({ append: true }) },
  changeReply(event) {
    const replyText = String(event.detail.value || '').slice(0, 300)
    this.setData({ replyText, canSend: Boolean(replyText.trim()), sendError: '' })
  },
  focusReply() { this.setData({ inputFocused: true }) },

  async sendReply() {
    if (this.data.sending) return false
    const content = this.data.replyText.trim()
    if (!content) return this.setData({ sendError: '写下回复内容' })
    this.setData({ sending: true, sendError: '' })
    try {
      await getApp().ensureSession({ interactive: true })
      const rawComment = await api.updateComments.send({ updateId: this.data.updateId, content }, { retry: false })
      const urls = await this.resolveAvatars([rawComment && rawComment.author || {}])
      const comment = playerUpdates.presentComment(rawComment || {}, urls[rawComment && rawComment.author && rawComment.author.avatarFileId] || '')
      const exists = this.data.comments.some(item => item.id === comment.id)
      const comments = exists ? this.data.comments : this.data.comments.concat(comment)
      const update = Object.assign({}, this.data.update, {
        commentCount: Number(this.data.update && this.data.update.commentCount || 0) + (exists ? 0 : 1),
        commentText: `${Number(this.data.update && this.data.update.commentCount || 0) + (exists ? 0 : 1)} 条回复`
      })
      this.setData({ replyText: '', canSend: false, sending: false, inputFocused: false, comments, update })
      wx.pageScrollTo({ scrollTop: 100000, duration: 220 })
      return true
    } catch (error) {
      const unknown = error && error.details && error.details.outcomeUnknown
      this.setData({ sending: false, sendError: unknown ? '发送结果待确认，请刷新查看' : errors.message(error, '回复失败，请重试') })
      if (unknown) this.load({ fresh: true })
      return false
    }
  },

  useUpdate() {
    if (!this.data.update || this.data.update.kind !== 'availability') return
    const prepared = clientState.setPublishPrefill({ source: 'player-update', district: this.data.update.district,
      availabilityText: this.data.update.availabilityText, timeNote: this.data.update.timeNote,
      venueName: this.data.update.venueName })
    if (!prepared) {
      wx.showToast({ title: '暂时无法准备发布内容，请稍后重试', icon: 'none' })
      return
    }
    wx.switchTab({ url: '/pages/publish/publish' })
  },
  openPlayer(event) {
    const id = event.currentTarget.dataset.id
    if (id) wx.navigateTo({ url: `/pages/player-detail/player-detail?id=${encodeURIComponent(id)}` })
  },
  onShareAppMessage() {
    const update = this.data.update
    return share.appMessage({
      title: update ? `${update.displayName}的${update.kindText}｜来一拍` : '来一拍球友动态',
      path: `/pages/update-detail/update-detail?id=${encodeURIComponent(this.data.updateId)}`
    })
  },
  onShareTimeline() {
    const update = this.data.update
    return share.timeline({
      title: update ? `${update.displayName}的${update.kindText}｜来一拍` : '来一拍球友动态',
      params: { id: this.data.updateId }
    })
  }
})


