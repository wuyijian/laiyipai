const api = require('../../utils/api')
const clientState = require('../../utils/client-state')
const cloudConfig = require('../../utils/cloud-config')
const privacy = require('../../utils/privacy')
const errors = require('../../utils/error')

Page({
  data: {
    version: '1.0.11',
    wechatLoggedIn: false,
    termsEffectiveDate: '2026-09-13',
    termsVisible: false,
    blocksVisible: false,
    blocksLoading: false,
    blockedUsers: [],
    deleteVisible: false,
    deleteConfirmed: false,
    deleting: false,
    deleteError: ''
  },

  onLoad(options) {
    this.setData({ version: cloudConfig.appVersion || '1.0.11' })
    if (options && options.section === 'terms') this.setData({ termsVisible: true })
  },

  onShow() {
    const app = getApp()
    this.setData({ wechatLoggedIn: Boolean(app.globalData && app.globalData.session) })
  },

  openWechatLogin() { getApp().openLogin() },

  openPrivacy() {
    privacy.openContract()
  },

  openTerms() {
    this.setData({ termsVisible: true })
  },

  closeTerms() {
    this.setData({ termsVisible: false })
  },

  openPermissions() {
    wx.openSetting()
  },

  async openBlocks() {
    this.setData({ blocksVisible: true, blocksLoading: true })
    try {
      await getApp().ensureSession({ interactive: true })
      const result = await api.safety.listBlocks({ page: 1, pageSize: 50 })
      this.setData({ blockedUsers: (result.items || []).map((item) => ({
        id: item.playerId,
        displayName: item.nickname || '球友',
        busy: false
      })), blocksLoading: false })
    } catch (error) {
      this.setData({ blocksLoading: false })
      errors.toast(error)
    }
  },

  closeBlocks() {
    this.setData({ blocksVisible: false })
  },

  async unblockUser(event) {
    const playerId = event.currentTarget.dataset.id
    this.setData({ blockedUsers: this.data.blockedUsers.map((item) => item.id === playerId ? Object.assign({}, item, { busy: true }) : item) })
    try {
      await api.safety.block({ playerId, blocked: false })
      this.setData({ blockedUsers: this.data.blockedUsers.filter((item) => item.id !== playerId) })
    } catch (error) {
      this.setData({ blockedUsers: this.data.blockedUsers.map((item) => item.id === playerId ? Object.assign({}, item, { busy: false }) : item) })
      errors.toast(error)
    }
  },

  requestDelete() {
    this.setData({ deleteVisible: true, deleteConfirmed: false, deleteError: '' })
  },

  closeDelete() {
    if (!this.data.deleting) this.setData({ deleteVisible: false, deleteError: '' })
  },

  toggleDeleteConfirmed() {
    this.setData({ deleteConfirmed: !this.data.deleteConfirmed, deleteError: '' })
  },

  async deleteAccount() {
    if (!this.data.deleteConfirmed || this.data.deleting) return
    this.setData({ deleting: true, deleteError: '' })
    try {
      await api.account.delete({ confirmation: '注销账号' }, { requestId: api.createRequestId() })
      clientState.clear()
      getApp().clearSession()
      this.setData({ deleting: false, deleteVisible: false })
      wx.showModal({
        title: '注销申请已提交',
        content: '账号已停止使用，后台会继续完成数据清理。你可以关闭小程序。',
        showCancel: false,
        confirmText: '关闭小程序',
        success: () => { if (wx.exitMiniProgram) wx.exitMiniProgram() }
      })
    } catch (error) {
      this.setData({ deleting: false, deleteError: errors.message(error) })
    }
  },

  noop() {}
})
