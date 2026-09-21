const api = require('./utils/api')
const privacy = require('./utils/privacy')
const loginConsent = require('./utils/login-consent')
const messageNotifier = require('./utils/message-notifier')

function loginError(code, message) { return Object.assign(new Error(message), { code }) }

App({
  globalData: {
    city: '杭州', session: null, sessionPromise: null, sessionGeneration: 0,
    loginVisible: false, loginPrompted: false, visible: false
  },

  onLaunch() {
    // Keep cold start free of account and inbox traffic. The public home
    // feed signals restoreSessionAfterPrimary() only after its main list is
    // already interactive.
  },

  onShow() {
    this.globalData.visible = true
    if (this.globalData.session) messageNotifier.start({ immediate: true })
    else this.scheduleSessionRestore()
  },

  onHide() {
    this.globalData.visible = false
    if (this.sessionRestoreTimer && typeof clearTimeout === 'function') clearTimeout(this.sessionRestoreTimer)
    this.sessionRestoreTimer = null
    messageNotifier.stop()
  },

  scheduleSessionRestore(delay = 12000) {
    if (!loginConsent.accepted() || this.globalData.session || this.globalData.sessionPromise || this.sessionRestoreTimer) return false
    this.sessionRestoreTimer = setTimeout(() => {
      this.sessionRestoreTimer = null
      if (this.globalData.visible === false) return
      this.restoreSession()
    }, delay)
    return true
  },

  restoreSessionAfterPrimary(delay = 250) {
    if (!loginConsent.accepted() || this.globalData.session || this.globalData.sessionPromise) return false
    // Replace the slow fallback used by non-home entry pages. The home feed
    // is already interactive, so restoring account state can now start.
    if (this.sessionRestoreTimer && typeof clearTimeout === 'function') clearTimeout(this.sessionRestoreTimer)
    this.sessionRestoreTimer = null
    return this.scheduleSessionRestore(delay)
  },

  async restoreSession() {
    if (!loginConsent.accepted()) return null
    if (this.globalData.session) return this.globalData.session
    try {
      // The stored preference is scoped to this AppID and privacy/terms
      // version. It is only a signal to attempt a trusted cloud bootstrap;
      // the server still validates OPENID, account state and consent.
      return await this.authenticateWechat({ skipPrivacy: true })
    } catch (_) {
      // A passive restore must never block public browsing or show a login
      // error. The next explicit action/onShow can retry.
      return null
    }
  },

  async ensureSession(options = {}) {
    const hasSession = Boolean(this.globalData.session)
    const refresh = options.refresh === true && hasSession
    if (hasSession && !refresh) return this.globalData.session
    if (this.globalData.sessionPromise) return this.globalData.sessionPromise
    if (!loginConsent.accepted()) {
      // Passive page loading must never interrupt browsing with an authorization
      // screen. Only a user-initiated action may open the login page.
      if (options.interactive === true) this.openLogin()
      throw loginError('LOGIN_REQUIRED', '登录后可发布或加入球局、管理预约和标记球馆')
    }
    return this.authenticateWechat({ skipPrivacy: refresh })
  },

  openLogin() {
    if (this.globalData.loginVisible) return
    this.globalData.loginVisible = true
    this.globalData.loginPrompted = true
    // Keep the originating page, including share parameters and form drafts.
    wx.navigateTo({
      url: '/pages/login/login',
      fail: () => {
        this.globalData.loginVisible = false
        wx.showToast({ title: '暂时无法打开登录页，请在“我的”重试', icon: 'none' })
      }
    })
  },

  async loginWithWechat(consentAccepted) {
    if (consentAccepted !== true) throw loginError('CONSENT_REQUIRED', '请先阅读并同意用户协议与隐私保护指引')
    return this.authenticateWechat()
  },

  async authenticateWechat(options = {}) {
    if (this.globalData.sessionPromise) return this.globalData.sessionPromise
    const generation = this.globalData.sessionGeneration
    const pending = (async () => {
      if (options.skipPrivacy !== true) await privacy.authorize()
      if (generation !== this.globalData.sessionGeneration) throw loginError('LOGIN_CANCELLED', '已取消登录')
      api.init()
      // wx.cloud carries trusted WeChat identity; never trust a client OPENID.
      const session = await api.bootstrap(true)
      if (generation !== this.globalData.sessionGeneration) throw loginError('LOGIN_CANCELLED', '登录状态已更新，请重试')
      if (!session || !session.profile || !session.profile.playerId) throw loginError('INVALID_SERVER_RESPONSE', '未能确认微信登录，请重试')
      this.globalData.session = session
      loginConsent.remember()
      if (this.globalData.visible !== false) messageNotifier.start({ immediate: true })
      return session
    })()
    this.globalData.sessionPromise = pending
    try {
      return await pending
    } catch (error) {
      if (generation === this.globalData.sessionGeneration && ['UNAUTHENTICATED', 'ACCOUNT_DELETED', 'ACCOUNT_SUSPENDED', 'CONSENT_REQUIRED', 'CONSENT_VERSION_MISMATCH'].includes(error.code)) {
        loginConsent.forget()
        this.globalData.session = null
      }
      throw error
    } finally {
      if (this.globalData.sessionPromise === pending) this.globalData.sessionPromise = null
    }
  },

  clearSession() {
    if (this.sessionRestoreTimer && typeof clearTimeout === 'function') clearTimeout(this.sessionRestoreTimer)
    this.sessionRestoreTimer = null
    messageNotifier.reset()
    this.globalData.sessionGeneration = Number(this.globalData.sessionGeneration || 0) + 1
    if (api.invalidateReads) api.invalidateReads()
    if (api.diagnostics) api.diagnostics.clear()
    loginConsent.forget()
    this.globalData.session = null
    this.globalData.sessionPromise = null
  }
})
