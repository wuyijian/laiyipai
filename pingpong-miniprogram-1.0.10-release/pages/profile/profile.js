const api = require('../../utils/api')
const present = require('../../utils/present')
const privacy = require('../../utils/privacy')
const errors = require('../../utils/error')
const clientState = require('../../utils/client-state')
const tabBar = require('../../utils/tab-bar')
const messageNotifier = require('../../utils/message-notifier')

const BALL_AGES = ['未填写', '球龄 1 年以内', '球龄 1—2 年', '球龄 2—5 年', '球龄 5—10 年', '球龄 10 年以上']
const RATING_PLATFORMS = ['未填写', '开球网', 'ChinaTT', '其他平台']
const FAVORITE_PAGE_SIZE = 20
const FAVORITE_RETRY_DELAY_MS = 260
const FAVORITE_RETRY_CODES = new Set(['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE', 'INVALID_SERVER_RESPONSE', 'INTERNAL'])
const COACH_APPLICATION_STATUSES = ['not_submitted', 'reviewing', 'approved', 'rejected']
const VENUE_SUBMISSION_STATUSES = ['reviewing', 'approved', 'rejected']

function formatVenueSubmission(raw = {}) {
  const rawStatus = raw.status || raw.verificationStatus
  const status = rawStatus === 'pending' ? 'reviewing' : rawStatus === 'verified' ? 'approved' : rawStatus
  if (!VENUE_SUBMISSION_STATUSES.includes(status)) return null
  const views = {
    reviewing: { statusLabel: '处理中', statusCopy: '早期提交记录仍按原流程处理' },
    approved: { statusLabel: '已处理', statusCopy: '已进入球馆库，可用于发布球局' },
    rejected: { statusLabel: '需修改', statusCopy: raw.rejectionReason || raw.reviewReason || '这是早期记录，可查看原因后处理' }
  }
  return Object.assign({}, raw, views[status], {
    id: raw.id || raw._id || raw.submissionId || '',
    name: raw.name || '未命名球馆',
    status,
    rejectionReason: raw.rejectionReason || raw.reviewReason || ''
  })
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function formatCoachApplication(raw) {
  const envelopeStatus = raw && raw.status
  const source = raw && raw.application !== undefined ? raw.application : raw
  const value = source && typeof source === 'object' ? source : {}
  const status = COACH_APPLICATION_STATUSES.includes(value.status)
    ? value.status
    : COACH_APPLICATION_STATUSES.includes(envelopeStatus) ? envelopeStatus : 'not_submitted'
  const views = {
    not_submitted: {
      title: '申请成为教练',
      copy: '填写教学经历与联系方式，由运营人工核验',
      statusLabel: '可申请'
    },
    reviewing: {
      title: '教练认证审核中',
      copy: '申请已提交，可进入查看资料',
      statusLabel: '审核中'
    },
    approved: {
      title: '教练身份已认证',
      copy: '认证资料已通过运营核验',
      statusLabel: '已认证'
    },
    rejected: {
      title: '教练认证未通过',
      copy: value.reviewReason || '查看原因并修改申请资料',
      statusLabel: '需修改'
    }
  }
  return Object.assign({}, value, views[status], { status })
}

function formatProfile(rawProfile, previousProfile) {
  const skills = Array.isArray(rawProfile.skills) ? rawProfile.skills : []
  const ratingPlatform = rawProfile.ratingPlatform || '未填写'
  const ratingValue = rawProfile.ratingValue || ''
  return Object.assign({}, rawProfile, {
    nickname: rawProfile.nickname || '新球友',
    // 审核版统一使用 player-avatar 的稳定系统头像。历史
    // avatarFileId 仍可随资料返回，但不再解析、展示或发起审核。
    avatarUrl: '',
    locationText: ['杭州', rawProfile.district].filter(Boolean).join(' · '),
    ballAge: rawProfile.ballAge || '未填写',
    ballAgeText: String(rawProfile.ballAge || '未填写').replace(/^球龄\s*/, ''),
    skills,
    ratingPlatform,
    ratingValue,
    ratingText: ratingPlatform !== '未填写' && ratingValue ? `${ratingPlatform} ${ratingValue}` : '未填写',
    complete: rawProfile.nickname && rawProfile.nickname !== '新球友' && (rawProfile.ballAge && rawProfile.ballAge !== '未填写' || skills.length > 0)
  })
}

function formatMessageConversation(item = {}) {
  const match = item.match || {}
  const sender = item.sender || {}
  return Object.assign({}, item, {
    matchId: String(item.matchId || ''),
    unreadCount: Math.max(1, Number(item.unreadCount || 1)),
    title: match.title || match.venueName || '球局沟通',
    scheduleText: [match.date, match.startTime, match.venueName].filter(Boolean).join(' · '),
    previewText: `${sender.displayName || '球友'}：${item.preview || '发来一条新消息'}`
  })
}

Page({
  data: {
    state: 'loading',
    errorMessage: '',
    loginRequired: false,
    isAdmin: false,
    canReviewCoaches: false,
    canManageCatalog: false,
    profile: null,
    coachApplication: formatCoachApplication(null),
    coachApplicationState: 'idle',
    venueSubmissions: [],
    venueSubmissionsState: 'idle',
    savedVenues: [],
    savedVenuesTotal: 0,
    savedVenuesPage: 0,
    savedVenuesHasMore: false,
    loadingMoreVenues: false,
    unmarkingVenueId: '',
    venuesState: 'idle',
    messageUnreadCount: 0,
    messageBadgeText: '',
    messageConversations: [],
    editVisible: false,
    editProfile: null,
    editDirty: false,
    profileDirty: false,
    ballAgeOptions: BALL_AGES,
    editBallAgeIndex: 0,
    ratingPlatforms: RATING_PLATFORMS,
    ratingPlatformIndex: 0,
    newSkill: '',
    editError: '',
    saving: false
  },

  onLoad() {
    this.active = true
    this.unsubscribeMessages = messageNotifier.subscribe((state) => this.applyMessageState(state))
  },

  onShow() {
    tabBar.sync(this, 'pages/profile/profile')
    this.active = true
    messageNotifier.start()
    messageNotifier.poll()
    const resumingInFlightLoad = Boolean(this.loading)
    const task = this.loadProfile()
    if (resumingInFlightLoad) this.loadVenueSubmissions()
    return task
  },

  onHide() {
    this.active = false
    this.savedVenueRun = Number(this.savedVenueRun || 0) + 1
    this.venueSubmissionRun = Number(this.venueSubmissionRun || 0) + 1
  },

  onUnload() {
    this.active = false
    if (this.unsubscribeMessages) this.unsubscribeMessages()
    this.unsubscribeMessages = null
    this.savedVenueRun = Number(this.savedVenueRun || 0) + 1
    this.venueSubmissionRun = Number(this.venueSubmissionRun || 0) + 1
  },

  onPullDownRefresh() {
    Promise.all([this.loadProfile(), messageNotifier.poll()]).finally(() => wx.stopPullDownRefresh())
  },

  applyMessageState(state = {}) {
    const count = Math.max(0, Number(state.unreadCount || 0))
    const messageConversations = (state.items || []).map(formatMessageConversation).filter((item) => item.matchId)
    this.setData({
      messageUnreadCount: count,
      messageBadgeText: count > 99 ? '99+' : String(count || ''),
      messageConversations
    })
  },

  async loadProfile(event) {
    if (event && event.currentTarget && this.data.loginRequired) return getApp().openLogin()
    if (this.loading) return this.loading
    const hadReadyState = this.data.state === 'ready'
    const previousVenuesState = this.data.venuesState
    const previousCoachApplicationState = this.data.coachApplicationState
    const previousVenueSubmissionsState = this.data.venueSubmissionsState
    this.setData(hadReadyState
      ? { errorMessage: '', venuesState: 'loading', coachApplicationState: 'loading', venueSubmissionsState: 'loading' }
      : { state: 'loading', errorMessage: '', venuesState: 'loading', coachApplicationState: 'loading', venueSubmissionsState: 'loading' })
    this.loading = (async () => {
      try {
        const app = getApp()
        const hasCachedSession = Boolean(app.globalData && app.globalData.session)
        let session
        let rawProfile
        if (hasCachedSession) {
          // Refresh server-derived capabilities whenever the account page is
          // shown. Role grants and revocations must not wait for WeChat to
          // destroy the whole mini-program process. Run the profile read in
          // parallel so this check does not add another serial round trip.
          ;[session, rawProfile] = await Promise.all([
            app.ensureSession({ refresh: true }),
            api.profile.get()
          ])
        } else {
          session = await app.ensureSession()
          rawProfile = await api.profile.get()
        }
        const previousProfile = this.data.profile
        const profile = formatProfile(rawProfile, previousProfile)

        // 基础资料先解除整页骨架；球馆等次要模块再并行更新。
        const capabilities = session && session.capabilities || {}
        this.setData({
          state: 'ready',
          loginRequired: false,
          isAdmin: Boolean(session && session.capabilities && session.capabilities.adminVenueReview === true),
          // adminVenueReview was the original generic administrator hint. Keep
          // it as a rolling-deploy fallback until every cloud environment
          // returns the more precise coach capability.
          canReviewCoaches: capabilities.adminCoachReview === true || capabilities.adminVenueReview === true,
          canManageCatalog: capabilities.adminCoachReview === true || capabilities.adminVenueReview === true,
          profile
        })
        messageNotifier.start()
        messageNotifier.poll()

        await Promise.all([
          this.loadSavedVenues(),
          this.loadCoachApplication(),
          this.loadVenueSubmissions()
        ])
      } catch (error) {
        if (['LOGIN_REQUIRED', 'UNAUTHENTICATED', 'ACCOUNT_DELETED', 'ACCOUNT_SUSPENDED', 'CONSENT_REQUIRED', 'CONSENT_VERSION_MISMATCH'].includes(error.code)) {
          this.setData({ state: 'error', profile: null, savedVenues: [], editVisible: false, loginRequired: true, errorMessage: errors.message(error) })
        } else if (hadReadyState) {
          this.setData({ venuesState: previousVenuesState, coachApplicationState: previousCoachApplicationState, venueSubmissionsState: previousVenueSubmissionsState })
          errors.toast(error, '刷新失败，请稍后重试')
        }
        else this.setData({ state: 'error', errorMessage: errors.message(error) })
      }
    })()
    try {
      await this.loading
    } finally {
      this.loading = null
    }
  },

  async loadSavedVenues() {
    const run = Number(this.savedVenueRun || 0) + 1
    this.savedVenueRun = run
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await api.favorites.list({ page: 1, pageSize: FAVORITE_PAGE_SIZE })
        if (run !== this.savedVenueRun || this.active === false) return false
        const savedVenues = (result.items || []).map(present.venue)
        this.setData({
          savedVenues,
          savedVenuesTotal: Number(result.total === undefined ? savedVenues.length : result.total),
          savedVenuesPage: Number(result.page || 1),
          savedVenuesHasMore: result.hasMore === true,
          loadingMoreVenues: false,
          venuesState: 'ready'
        })
        return true
      } catch (error) {
        if (run !== this.savedVenueRun || this.active === false) return false
        if (attempt === 0 && FAVORITE_RETRY_CODES.has(error && error.code)) {
          await wait(FAVORITE_RETRY_DELAY_MS)
          if (run !== this.savedVenueRun || this.active === false) return false
          continue
        }
        this.setData({ loadingMoreVenues: false, venuesState: 'error' })
        return false
      }
    }
    return false
  },

  retrySavedVenues() {
    if (this.data.venuesState === 'loading') return false
    this.setData({ venuesState: 'loading' })
    return this.loadSavedVenues()
  },

  async loadCoachApplication() {
    if (!api.coachApplications || typeof api.coachApplications.get !== 'function') {
      this.setData({ coachApplication: formatCoachApplication(null), coachApplicationState: 'ready' })
      return
    }
    try {
      const result = await api.coachApplications.get()
      this.setData({ coachApplication: formatCoachApplication(result), coachApplicationState: 'ready' })
    } catch (_) {
      this.setData({ coachApplicationState: 'error' })
    }
  },

  async loadVenueSubmissions() {
    const run = Number(this.venueSubmissionRun || 0) + 1
    this.venueSubmissionRun = run
    if (!api.venues || !api.venues.submissions || typeof api.venues.submissions.list !== 'function') {
      if (this.active !== false) this.setData(this.data.venueSubmissions.length
        ? { venueSubmissionsState: 'error' }
        : { venueSubmissions: [], venueSubmissionsState: 'unavailable' })
      return
    }
    if (this.active !== false) this.setData({ venueSubmissionsState: 'loading' })
    try {
      const result = await api.venues.submissions.list({ page: 1, pageSize: 10 })
      if (run !== this.venueSubmissionRun || this.active === false) return
      const venueSubmissions = (result.items || [])
        .map(formatVenueSubmission)
        .filter(Boolean)
      this.setData({ venueSubmissions, venueSubmissionsState: 'ready' })
    } catch (error) {
      if (run !== this.venueSubmissionRun || this.active === false) return
      if (['ACTION_NOT_FOUND', 'CLOUD_FUNCTION_NOT_DEPLOYED'].includes(error.code)) {
        this.setData(this.data.venueSubmissions.length
          ? { venueSubmissionsState: 'error' }
          : { venueSubmissions: [], venueSubmissionsState: 'unavailable' })
      } else {
        this.setData({ venueSubmissionsState: 'error' })
      }
    }
  },

  openEdit() {
    const editProfile = {
      nickname: this.data.profile.nickname,
      district: this.data.profile.district || '',
      ballAge: this.data.profile.ballAge || '未填写',
      skills: this.data.profile.skills.slice(),
      ratingPlatform: this.data.profile.ratingPlatform || '未填写',
      ratingValue: this.data.profile.ratingValue || ''
    }
    this.setData({
      editVisible: true,
      editProfile,
      editBallAgeIndex: Math.max(0, BALL_AGES.indexOf(editProfile.ballAge)),
      ratingPlatformIndex: Math.max(0, RATING_PLATFORMS.indexOf(editProfile.ratingPlatform)),
      newSkill: '',
      editError: '',
      editDirty: false,
      profileDirty: false
    })
  },

  closeEdit() {
    if (this.data.saving) return
    const dismiss = () => {
      this.setData({ editVisible: false, editDirty: false, profileDirty: false, editError: '' })
    }
    if (!this.data.editDirty) return dismiss()
    wx.showModal({
      title: '放弃本次修改？',
      content: '尚未保存的资料将不会保留。',
      confirmText: '放弃修改',
      confirmColor: '#a9483d',
      success: (result) => {
        if (result.confirm) dismiss()
      }
    })
  },

  changeNickname(event) { this.setData({ 'editProfile.nickname': event.detail.value, editError: '', editDirty: true, profileDirty: true }) },
  changeDistrict(event) { this.setData({ 'editProfile.district': event.detail.value, editError: '', editDirty: true, profileDirty: true }) },
  changeEditBallAge(event) {
    const editBallAgeIndex = Number(event.detail.value)
    this.setData({ editBallAgeIndex, 'editProfile.ballAge': BALL_AGES[editBallAgeIndex], editError: '', editDirty: true, profileDirty: true })
  },
  changeRatingPlatform(event) {
    const ratingPlatformIndex = Number(event.detail.value)
    const ratingPlatform = RATING_PLATFORMS[ratingPlatformIndex]
    const patch = { ratingPlatformIndex, 'editProfile.ratingPlatform': ratingPlatform, editError: '', editDirty: true, profileDirty: true }
    if (ratingPlatform === '未填写') patch['editProfile.ratingValue'] = ''
    this.setData(patch)
  },
  changeRatingValue(event) { this.setData({ 'editProfile.ratingValue': String(event.detail.value || '').replace(/\D/g, '').slice(0, 4), editError: '', editDirty: true, profileDirty: true }) },
  changeNewSkill(event) { this.setData({ newSkill: event.detail.value, editDirty: true, profileDirty: true }) },

  addSkill() {
    const value = this.data.newSkill.trim()
    if (!value) return
    if (this.data.editProfile.skills.includes(value)) return wx.showToast({ title: '这项技术已经添加', icon: 'none' })
    if (this.data.editProfile.skills.length >= 6) return wx.showToast({ title: '最多填写 6 项', icon: 'none' })
    this.setData({ 'editProfile.skills': this.data.editProfile.skills.concat([value]), newSkill: '', editError: '', editDirty: true, profileDirty: true })
  },

  removeSkill(event) {
    const value = event.currentTarget.dataset.value
    this.setData({ 'editProfile.skills': this.data.editProfile.skills.filter((item) => item !== value), editError: '', editDirty: true, profileDirty: true })
  },

  validateEdit() {
    if (!this.data.editProfile.nickname.trim()) return '请填写昵称'
    const rating = this.data.editProfile.ratingValue
    if (this.data.editProfile.ratingPlatform !== '未填写' && !rating) return '选择积分平台后请填写积分'
    if (rating && (Number(rating) < 1 || Number(rating) > 9999)) return '积分请输入 1—9999'
    return ''
  },

  async saveProfile() {
    if (this.data.saving || !this.data.editDirty) return
    const validationError = this.validateEdit()
    if (validationError) return this.setData({ editError: validationError })
    const skills = this.data.editProfile.skills.slice()
    const pendingSkill = this.data.newSkill.trim()
    if (pendingSkill && !skills.includes(pendingSkill)) {
      if (skills.length >= 6) return this.setData({ editError: '擅长技术最多填写 6 项' })
      skills.push(pendingSkill)
    }
    const submittedProfile = Object.assign({}, this.data.editProfile, {
      nickname: this.data.editProfile.nickname.trim(),
      district: this.data.editProfile.district.trim(),
      skills
    })
    this.setData({ saving: true, editError: '' })
    try {
      await privacy.authorize()
      await api.profile.update({
        nickname: submittedProfile.nickname,
        city: '杭州',
        district: submittedProfile.district,
        ballAge: submittedProfile.ballAge,
        skills: submittedProfile.skills,
        ratingPlatform: submittedProfile.ratingPlatform,
        ratingValue: submittedProfile.ratingValue
      })
      const ratingText = submittedProfile.ratingPlatform !== '未填写' && submittedProfile.ratingValue
        ? `${submittedProfile.ratingPlatform} ${submittedProfile.ratingValue}` : '未填写'
      const profile = Object.assign({}, this.data.profile, {
        nickname: submittedProfile.nickname,
        district: submittedProfile.district,
        locationText: ['杭州', submittedProfile.district].filter(Boolean).join(' · '),
        ballAge: submittedProfile.ballAge,
        ballAgeText: String(submittedProfile.ballAge || '未填写').replace(/^球龄\s*/, ''),
        skills: submittedProfile.skills,
        ratingPlatform: submittedProfile.ratingPlatform,
        ratingValue: submittedProfile.ratingValue,
        ratingText,
        complete: submittedProfile.nickname !== '新球友' && (submittedProfile.ballAge !== '未填写' || submittedProfile.skills.length > 0)
      })
      this.setData({ saving: false, editVisible: false, editDirty: false, profileDirty: false, newSkill: '', profile })
      wx.showToast({ title: '资料已保存', icon: 'success' })
      await this.loadProfile()
    } catch (error) {
      this.setData({
        saving: false,
        editDirty: true,
        profileDirty: true,
        editError: errors.message(error)
      })
    }
  },

  openVenue(event) {
    const venueId = event.currentTarget.dataset.id
    const venue = this.data.savedVenues.find((item) => item.id === venueId)
    if (!venue || venue.unavailable) return wx.showToast({ title: '球馆已下架，可取消标记', icon: 'none' })
    wx.navigateTo({ url: `/pages/venue-detail/venue-detail?id=${venueId}` })
  },

  async loadMoreVenues() {
    if (this.data.loadingMoreVenues || !this.data.savedVenuesHasMore) return
    this.setData({ loadingMoreVenues: true })
    try {
      const result = await api.favorites.list({
        page: this.data.savedVenuesPage + 1,
        pageSize: FAVORITE_PAGE_SIZE
      })
      const byId = new Map(this.data.savedVenues.map((item) => [item.id, item]))
      ;(result.items || []).map(present.venue).forEach((item) => byId.set(item.id, item))
      const savedVenues = Array.from(byId.values())
      this.setData({
        savedVenues,
        savedVenuesTotal: Number(result.total === undefined ? savedVenues.length : result.total),
        savedVenuesPage: Number(result.page || this.data.savedVenuesPage + 1),
        savedVenuesHasMore: result.hasMore === true,
        venuesState: 'ready'
      })
    } catch (error) {
      errors.toast(error, '更多标记球馆加载失败')
    } finally {
      this.setData({ loadingMoreVenues: false })
    }
  },

  async refreshLoadedVenuePages() {
    const pageCount = Math.max(1, Number(this.data.savedVenuesPage || 1))
    const results = []
    for (let page = 1; page <= pageCount; page += 1) {
      const result = await api.favorites.list({ page, pageSize: FAVORITE_PAGE_SIZE })
      results.push(result)
      if (!result.hasMore) break
    }
    const savedVenues = results.flatMap((result) => result.items || []).map(present.venue)
    const last = results[results.length - 1] || {}
    this.setData({
      savedVenues,
      savedVenuesTotal: Number(last.total === undefined ? savedVenues.length : last.total),
      savedVenuesPage: Number(last.page || results.length || 1),
      savedVenuesHasMore: last.hasMore === true,
      venuesState: 'ready'
    })
  },

  async unmarkVenue(event) {
    const venueId = typeof event === 'string' ? event : event.currentTarget.dataset.id
    if (!venueId || this.data.unmarkingVenueId) return
    const previousVenues = this.data.savedVenues.slice()
    const previousTotal = this.data.savedVenuesTotal
    this.setData({ unmarkingVenueId: venueId })
    try {
      await api.favorites.set({ venueId, marked: false })
      this.setData({
        savedVenues: previousVenues.filter((item) => item.id !== venueId),
        savedVenuesTotal: Math.max(0, previousTotal - 1)
      })
      wx.showToast({ title: '已取消标记', icon: 'none' })
      if (this.data.savedVenuesHasMore) {
        try {
          await this.refreshLoadedVenuePages()
        } catch (_) {
          // 当前页已正确移除；下次进入页面会重新对齐后续分页。
        }
      }
    } catch (error) {
      errors.toast(error, '取消标记失败，请重试')
    } finally {
      this.setData({ unmarkingVenueId: '' })
    }
  },

  manageVenue(event) {
    const venueId = event.currentTarget.dataset.id
    const venue = this.data.savedVenues.find((item) => item.id === venueId)
    if (!venue || this.data.unmarkingVenueId) return
    wx.showActionSheet({
      itemList: ['取消标记'],
      itemColor: '#a9483d',
      success: (result) => {
        if (result.tapIndex === 0) this.unmarkVenue(venueId)
      }
    })
  },

  openSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' })
  },

  openFriends() {
    wx.navigateTo({ url: '/pages/friends/friends' })
  },

  openMessages() {
    const first = this.data.messageConversations[0]
    if (first && first.matchId) {
      wx.navigateTo({ url: `/pages/chat/chat?id=${encodeURIComponent(first.matchId)}` })
      return
    }
    wx.switchTab({ url: '/pages/orders/orders' })
  },

  openMessageConversation(event) {
    const matchId = event.currentTarget.dataset.id
    if (!matchId) return
    wx.navigateTo({ url: `/pages/chat/chat?id=${encodeURIComponent(matchId)}` })
  },

  openCoachApplication() {
    wx.navigateTo({ url: '/pages/coach-apply/coach-apply' })
  },

  openVenueCreate() {
    wx.navigateTo({ url: '/pages/venue-create/venue-create' })
  },

  openVenueSubmission(event) {
    const submissionId = event.currentTarget.dataset.id
    if (!submissionId) return
    wx.navigateTo({ url: `/pages/venue-create/venue-create?submissionId=${encodeURIComponent(submissionId)}` })
  },

  openAdminVenueReview() {
    if (!this.data.isAdmin) return
    wx.navigateTo({ url: '/pages/admin-venue-review/admin-venue-review' })
  },

  openAdminCoachReview() {
    if (!this.data.canReviewCoaches) return
    wx.navigateTo({ url: '/pages/admin-coach-review/admin-coach-review' })
  },

  openAdminCatalog() {
    if (!this.data.canManageCatalog) return
    wx.navigateTo({ url: '/pages/admin-catalog/admin-catalog' })
  },

  goHome() {
    clientState.requestVenueDiscovery()
    wx.switchTab({ url: '/pages/home/home' })
  },

  noop() {}
})
