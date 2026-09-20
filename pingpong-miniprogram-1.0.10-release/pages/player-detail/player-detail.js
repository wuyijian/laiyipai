const api = require('../../utils/api')
const errors = require('../../utils/error')

Page({
  data: {
    id: '',
    state: 'loading',
    notFound: false,
    errorMessage: '',
    player: null,
    isSelf: false,
    loggedIn: false
  },

  onLoad(options) {
    this.setData({ id: options && options.id || '' })
  },

  onShow() {
    this.loadPlayer()
  },

  onPullDownRefresh() {
    this.loadPlayer().finally(() => wx.stopPullDownRefresh())
  },

  onUnload() {
    this.playerLoadRun = Number(this.playerLoadRun || 0) + 1
  },

  async loadPlayer(event) {
    if (!this.data.id) {
      this.setData({ state: 'error', notFound: true, errorMessage: '缺少球友编号' })
      return
    }
    if (this.loading) return this.loading
    const hadReadyState = this.data.state === 'ready' && Boolean(this.data.player)
    const run = Number(this.playerLoadRun || 0) + 1
    this.playerLoadRun = run
    this.setData(hadReadyState
      ? { notFound: false, errorMessage: '' }
      : { state: 'loading', notFound: false, errorMessage: '' })
    this.loading = (async () => {
      try {
        const app = getApp()
        const loggedIn = Boolean(app.globalData && app.globalData.session)
        const readOptions = { publicRead: !loggedIn }
        const result = await api.players.get({ playerId: this.data.id }, readOptions)
        if (run !== this.playerLoadRun) return
        const raw = result.player || {}
        const skills = Array.isArray(raw.skills) ? raw.skills : []
        const previous = this.data.player
        const avatarUrl = previous && previous.avatarFileId === raw.avatarFileId ? previous.avatarUrl || '' : ''
        const player = Object.assign({}, raw, {
          displayName: raw.displayName || '球友',
          avatarUrl,
          locationText: [raw.city || '杭州', raw.district].filter(Boolean).join(' · '),
          ballAge: raw.ballAge || '未填写',
          ballAgeText: String(raw.ballAge || '未填写').replace(/^球龄\s*/, ''),
          skills,
          ratingText: raw.ratingPlatform && raw.ratingPlatform !== '未填写' && raw.ratingValue
            ? `${raw.ratingPlatform} ${raw.ratingValue}` : ''
        })
        this.setData({ state: 'ready', player, isSelf: result.isSelf === true, loggedIn })
        this.loadPlayerAvatar(raw.avatarFileId, raw.playerId || this.data.id, run, readOptions)
      } catch (error) {
        if (run !== this.playerLoadRun) return
        if (hadReadyState && (!error || !['NOT_FOUND', 'FORBIDDEN'].includes(error.code))) {
          errors.toast(error, '资料暂时未更新')
        } else {
          this.setData({
            state: 'error',
            notFound: error && error.code === 'NOT_FOUND',
            errorMessage: errors.message(error)
          })
        }
      }
    })()
    try {
      await this.loading
    } finally {
      this.loading = null
    }
  },

  async loadPlayerAvatar(fileId, playerId, run, options = { publicRead: !this.data.loggedIn }) {
    if (!fileId || !api.files || !api.files.resolve) return
    try {
      const media = await api.files.resolve([fileId], options)
      const current = this.data.player
      if (run !== this.playerLoadRun || !current || (current.playerId || this.data.id) !== playerId || current.avatarFileId !== fileId) return
      this.setData({ 'player.avatarUrl': media.urls && media.urls[fileId] || '' })
    } catch (_) {
      // The stable local avatar remains visible when temporary media links fail.
    }
  },

  async openSafety() {
    if (!(await this.ensureInteractiveSession())) return
    wx.showActionSheet({
      itemList: ['举报球友资料', '屏蔽该球友'],
      success: (result) => {
        if (result.tapIndex === 0) this.reportPlayer()
        if (result.tapIndex === 1) this.blockPlayer()
      }
    })
  },

  async ensureInteractiveSession() {
    if (this.data.loggedIn && getApp().globalData && getApp().globalData.session) return true
    try {
      await getApp().ensureSession({ interactive: true })
      this.setData({ loggedIn: true })
      return true
    } catch (error) {
      if (error && error.code !== 'LOGIN_REQUIRED') errors.toast(error, '暂时无法登录，请稍后重试')
      return false
    }
  },

  reportPlayer() {
    wx.showActionSheet({
      itemList: ['资料不实', '骚扰行为', '疑似诈骗或诱导转账', '不安全或不当内容'],
      success: async (result) => {
        const options = [
          { category: 'false_information', details: '用户反馈球友资料不实' },
          { category: 'harassment', details: '用户反馈存在骚扰行为' },
          { category: 'fraud', details: '用户反馈疑似诈骗或诱导转账' },
          { category: 'unsafe_content', details: '用户反馈存在不安全或不当内容' }
        ]
        try {
          await api.safety.report(Object.assign({ targetType: 'player', targetId: this.data.id }, options[result.tapIndex]), {
            requestId: api.createRequestId()
          })
          wx.showToast({ title: '举报已提交', icon: 'success' })
        } catch (error) {
          errors.toast(error)
        }
      }
    })
  },

  blockPlayer() {
    wx.showModal({
      title: '屏蔽该球友',
      content: '屏蔽后，双方不会在推荐列表中互相出现，对方消息也会被隐藏。',
      confirmText: '确认屏蔽',
      confirmColor: '#b42318',
      success: async (result) => {
        if (!result.confirm) return
        try {
          await api.safety.block({ playerId: this.data.id, blocked: true })
          wx.showToast({ title: '已屏蔽', icon: 'success' })
          this.goBack()
        } catch (error) {
          errors.toast(error)
        }
      }
    })
  },

  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/home/home' })
  }
})
