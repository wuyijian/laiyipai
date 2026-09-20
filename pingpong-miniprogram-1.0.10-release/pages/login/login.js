const privacy = require('../../utils/privacy')
const errors = require('../../utils/error')
const share = require('../../utils/share')

Page({
  data: { agreed: false, loading: false, errorMessage: '', complete: false },

  onLoad() {
    this.destroyed = false
    this.succeeded = false
    const app = getApp()
    app.globalData.loginVisible = true
    app.globalData.loginPrompted = true
    share.disable()
  },

  onUnload() {
    this.destroyed = true
    const app = getApp()
    app.globalData.loginVisible = false
    // A late cloud response must not sign the user in after leaving this page.
    if (this.data.loading && !this.succeeded) app.clearSession()
  },

  changeAgreement(event) {
    if (this.data.loading) return
    this.setData({ agreed: (event.detail.value || []).includes('agree'), errorMessage: '' })
  },

  openPrivacy() { privacy.openContract() },
  openTerms() { wx.navigateTo({ url: '/pages/settings/settings?section=terms' }) },

  async login() {
    if (this.data.loading) return
    if (!this.data.agreed) return this.setData({ errorMessage: '请先阅读并同意用户协议与隐私保护指引' })
    this.setData({ loading: true, errorMessage: '' })
    try {
      await getApp().loginWithWechat(true)
      if (this.destroyed) return
      this.succeeded = true
      this.setData({ loading: false, complete: true })
      this.returnToOrigin()
    } catch (error) {
      if (!this.destroyed) this.setData({ loading: false, errorMessage: errors.message(error, '微信登录失败，请重试') })
    }
  },

  returnToOrigin() {
    if (this.data.loading) return
    if (getCurrentPages().length > 1) {
      wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/home/home' }) })
    } else wx.switchTab({ url: '/pages/home/home' })
  }
})
