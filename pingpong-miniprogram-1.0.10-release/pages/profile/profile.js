const api = require('../../utils/api')
const present = require('../../utils/present')
const privacy = require('../../utils/privacy')
const errors = require('../../utils/error')
const clientState = require('../../utils/client-state')
const tabBar = require('../../utils/tab-bar')
const messageNotifier = require('../../utils/message-notifier')
const playerLevels = require('../../utils/player-levels')
const profileEditor = require('../../utils/profile-editor')

const BALL_AGES = ['未填写', '球龄 1 年以内', '球龄 1—2 年', '球龄 2—5 年', '球龄 5—10 年', '球龄 10 年以上']
const RATING_PLATFORMS = ['未填写', '开球网', 'ChinaTT', '其他平台']
const DISTRICTS = ['暂不选择', '滨江区', '萧山区', '上城区', '西湖区', '拱墅区', '余杭区', '临平区', '钱塘区', '富阳区', '临安区', '桐庐县', '淳安县', '建德市']
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

async function settle(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

function formatProfile(rawProfile, previousProfile) {
  const skills = Array.isArray(rawProfile.skills) ? rawProfile.skills : []
  const ratingPlatform = rawProfile.ratingPlatform || '未填写'
  const ratingValue = rawProfile.ratingValue || ''
  const canReuseAvatar = Boolean(
    rawProfile.avatarFileId &&
    previousProfile &&
    previousProfile.avatarFileId === rawProfile.avatarFileId
  )
  return Object.assign({}, rawProfile, {
    nickname: rawProfile.nickname || '新球友',
    avatarUrl: canReuseAvatar ? previousProfile.avatarUrl : '',
    locationText: ['杭州', rawProfile.district].filter(Boolean).join(' · '),
    ballAge: rawProfile.ballAge || '未填写',
    ballAgeText: String(rawProfile.ballAge || '未填写').replace(/^球龄\s*/, ''),
    skills,
    playingProfile: playerLevels.normalize(rawProfile.playingProfile),
    playingSummary: playerLevels.summary(rawProfile),
    ratingPlatform,
    ratingValue,
    ratingText: ratingPlatform !== '未填写' && ratingValue ? `${ratingPlatform} ${ratingValue}` : '未填写',
    complete: rawProfile.nickname && rawProfile.nickname !== '新球友' && (rawProfile.ballAge && rawProfile.ballAge !== '未填写' || skills.length > 0 || playerLevels.summary(rawProfile).assessedCount > 0 || playerLevels.summary(rawProfile).traits.length > 0 || Boolean(ratingValue))
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
    matchStats: null,
    matchStatsState: 'idle',
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
    editSection: 'basics',
    editSections: [{ id: 'basics', label: '基本资料' }, { id: 'rating', label: '积分等级' }, { id: 'traits', label: '技术特点' }, { id: 'abilities', label: '能力项' }],
    abilityGroupIndex: 0,
    abilityGroupLabels: playerLevels.ABILITY_GROUPS.map(group => group.label),
    abilityStates: playerLevels.ABILITY_STATES,
    levelBands: playerLevels.LEVEL_BANDS,
    showLevelGuide: false,
    legacySkillsExpanded: false,
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
    const resumingInFlightLoad = Boolean(this.loading)
    const task = this.loadProfile()
    if (resumingInFlightLoad) {
      this.loadVenueSubmissions()
      this.loadMatchStats()
    }
    return task
  },

  onHide() {
    this.active = false
    this.invalidateMatchStats()
    this.savedVenueRun = Number(this.savedVenueRun || 0) + 1
    this.venueSubmissionRun = Number(this.venueSubmissionRun || 0) + 1
  },

  onUnload() {
    this.active = false
    this.invalidateMatchStats()
    if (this.unsubscribeMessages) this.unsubscribeMessages()
    this.unsubscribeMessages = null
    this.savedVenueRun = Number(this.savedVenueRun || 0) + 1
    this.venueSubmissionRun = Number(this.venueSubmissionRun || 0) + 1
  },

  onPullDownRefresh() {
    return Promise.all([
      this.loadProfile().then(() => this.matchStatsLoading),
      messageNotifier.poll()
    ]).finally(() => wx.stopPullDownRefresh())
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
          // A cold start already validated the signed-in session. Do not run
          // another bootstrap in parallel with the profile read: on the
          // experience build that doubled cloud-function cold starts and made
          // both the home and account pages time out together.
          session = app.globalData.session
          rawProfile = await api.profile.get()
        } else {
          session = await app.ensureSession()
          // bootstrap returns the same public profile shape as profile.get;
          // avoid a second serial cloud call on first entry.
          rawProfile = session && session.profile && session.profile.playerId
            ? session.profile
            : await api.profile.get()
        }
        const previousProfile = this.data.profile
        const profile = formatProfile(rawProfile, previousProfile)
        if (!previousProfile || previousProfile.playerId !== profile.playerId) {
          this.invalidateMatchStats()
          this.setData({ matchStats: null, matchStatsState: 'idle' })
        }

        // 基础资料先解除整页骨架；头像和球馆各自完成后再局部更新。
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
        // Statistics are optional and must never hold up account, venues or
        // messages. The module owns its loading/error state independently.
        this.loadMatchStats()

        await Promise.all([
          this.loadAvatarDetails(rawProfile),
          this.loadSavedVenues(),
          this.loadCoachApplication(),
          this.loadVenueSubmissions()
        ])
      } catch (error) {
        if (['LOGIN_REQUIRED', 'UNAUTHENTICATED', 'ACCOUNT_DELETED', 'ACCOUNT_SUSPENDED', 'CONSENT_REQUIRED', 'CONSENT_VERSION_MISMATCH'].includes(error.code)) {
          this.invalidateMatchStats()
          this.setData({ state: 'error', profile: null, matchStats: null, matchStatsState: 'idle', savedVenues: [], editVisible: false, loginRequired: true, errorMessage: errors.message(error) })
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

  invalidateMatchStats() {
    this.matchStatsRun = Number(this.matchStatsRun || 0) + 1
    this.matchStatsLoading = null
  },

  async loadMatchStats() {
    if (this.active === false || !this.data.profile || this.data.loginRequired) return
    if (this.matchStatsLoading) return this.matchStatsLoading
    const run = Number(this.matchStatsRun || 0) + 1
    this.matchStatsRun = run
    const playerId = this.data.profile.playerId
    const app = getApp()
    const generation = app.globalData && app.globalData.sessionGeneration
    const current = () => this.active !== false && run === this.matchStatsRun &&
      this.data.profile && this.data.profile.playerId === playerId &&
      generation === (app.globalData && app.globalData.sessionGeneration)
    this.setData({ matchStatsState: 'loading' })
    const task = (async () => {
      try {
        if (!api.profile || typeof api.profile.stats !== 'function') {
          if (current()) this.setData({ matchStatsState: 'unavailable' })
          return
        }
        const result = await api.profile.stats()
        if (!current()) return
        if (!result || !['historyCount', 'monthCount', 'hostedCount'].every(key => Number.isSafeInteger(result[key]) && result[key] >= 0) ||
            result.monthCount > result.historyCount || result.hostedCount > result.historyCount) {
          throw new Error('Invalid statistics response')
        }
        this.setData({ matchStats: result, matchStatsState: 'ready' })
      } catch (error) {
        if (!current()) return
        if (['UNAUTHENTICATED', 'ACCOUNT_DELETED', 'ACCOUNT_SUSPENDED', 'CONSENT_REQUIRED', 'CONSENT_VERSION_MISMATCH'].includes(error.code)) {
          this.setData({ matchStats: null, matchStatsState: 'error' })
        } else {
          this.setData({ matchStatsState: error.code === 'ACTION_NOT_FOUND' ? 'unavailable' : 'error' })
        }
      }
    })()
    this.matchStatsLoading = task
    try { await task } finally {
      if (this.matchStatsLoading === task) this.matchStatsLoading = null
    }
  },

  showStatsHelp() {
    wx.showModal({
      title: '约球统计说明',
      content: '历史参与：已结束、未取消且至少两人报名的球局，你需为发起人或已加入成员；改期后需确认新时间。同一球局只计一次。\n本月参与：其中开球日期在本月的球局，按北京时间计算。\n发起成局：其中由你发起的球局。\n未成局、待审核、候补、拒绝和退出不计入。统计根据报名记录计算，不代表签到或实际到场。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#176b53'
    })
  },

  async loadAvatarDetails(rawProfile) {
    // Existing approved avatars are read-only. Do not request pending reviews.
    const result = await this.resolveFiles(rawProfile.avatarFileId ? [rawProfile.avatarFileId] : [])
    const current = this.data.profile
    if (!current || current.avatarFileId !== rawProfile.avatarFileId) return
    this.setData({ profile: Object.assign({}, current, {
      avatarUrl: result.urls[rawProfile.avatarFileId] || current.avatarUrl || ''
    }) })
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

  async resolveFiles(fileIds) {
    if (!fileIds.length) return { ok: true, urls: {} }
    if (!api.files || !api.files.resolve) return { ok: false, urls: {} }
    try {
      const result = await api.files.resolve(Array.from(new Set(fileIds)))
      return { ok: true, urls: result.urls || {} }
    } catch (_) {
      return { ok: false, urls: {} }
    }
  },

  openEdit() {
    const editProfile = {
      nickname: this.data.profile.nickname,
      district: this.data.profile.district || '',
      ballAge: this.data.profile.ballAge || '未填写',
      skills: this.data.profile.skills.slice(),
      ratingPlatform: this.data.profile.ratingPlatform || '未填写',
      ratingValue: this.data.profile.ratingValue || '',
      playingProfile: playerLevels.normalize(this.data.profile.playingProfile)
    }
    const districtOptions = editProfile.district && !DISTRICTS.includes(editProfile.district) ? DISTRICTS.concat(editProfile.district) : DISTRICTS
    this.setData(Object.assign({
      editVisible: true,
      districtOptions, editDistrictIndex: Math.max(0, districtOptions.indexOf(editProfile.district)),
      editSection: 'basics', abilityGroupIndex: 0, showLevelGuide: false, legacySkillsExpanded: false,
      editProfile,
      editBallAgeIndex: Math.max(0, BALL_AGES.indexOf(editProfile.ballAge)),
      ratingPlatformIndex: Math.max(0, RATING_PLATFORMS.indexOf(editProfile.ratingPlatform)),
      newSkill: '',
      editError: '',
      editDirty: false,
      profileDirty: false
    }, profileEditor.view(editProfile)))
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

  changeNickname(event) {
    const nickname = String(event.detail.value || '')
    if (this.data.saving || !this.data.editProfile || nickname === this.data.editProfile.nickname) return
    this.setData({ 'editProfile.nickname': nickname, editError: '', editDirty: true, profileDirty: true })
  },
  changeDistrict(event) { this.setData({ 'editProfile.district': event.detail.value, editError: '', editDirty: true, profileDirty: true }) },
  changeEditBallAge(event) {
    const editBallAgeIndex = Number(event.detail.value)
    this.setData({ editBallAgeIndex, 'editProfile.ballAge': BALL_AGES[editBallAgeIndex], editError: '', editDirty: true, profileDirty: true })
  },
  changeRatingPlatform(event) {
    if (this.data.saving) return
    const ratingPlatformIndex = Number(event.detail.value)
    const ratingPlatform = RATING_PLATFORMS[ratingPlatformIndex]
    if (!ratingPlatform) return
    const patch = { ratingPlatformIndex, 'editProfile.ratingPlatform': ratingPlatform, editError: '', editDirty: true, profileDirty: true }
    if (ratingPlatform === '未填写') patch['editProfile.ratingValue'] = ''
    this.setData(patch)
    this.setData(profileEditor.view(this.data.editProfile, this.data.abilityGroupIndex))
  },
  selectDistrict(event) {
    if (this.data.saving) return
    const index = Number(event.detail.value)
    if (!Number.isInteger(index) || !this.data.districtOptions[index]) return
    this.setData({ editDistrictIndex: index })
    this.changeDistrict({ detail: { value: index ? this.data.districtOptions[index] : '' } })
  },
  changeRatingValue(event) {
    if (this.data.saving) return
    this.setData({ 'editProfile.ratingValue': String(event.detail.value || '').replace(/\D/g, '').slice(0, 4), editError: '', editDirty: true, profileDirty: true })
    this.setData(profileEditor.view(this.data.editProfile, this.data.abilityGroupIndex))
  },
  switchEditSection(event) {
    const section = event.currentTarget.dataset.section
    if (this.data.saving || !this.data.editSections.some(item => item.id === section)) return
    this.setData({ editSection: section })
  },
  toggleLevelGuide() { this.setData({ showLevelGuide: !this.data.showLevelGuide }) },
  toggleLegacySkills() { this.setData({ legacySkillsExpanded: !this.data.legacySkillsExpanded }) },
  updatePlayingProfile(value) {
    if (this.data.saving) return
    this.setData({ 'editProfile.playingProfile': value, editDirty: true, profileDirty: true, editError: '' })
    this.setData(profileEditor.view(this.data.editProfile, this.data.abilityGroupIndex))
  },
  changeEquipment(event) {
    const item = playerLevels.EQUIPMENT.find(item => item.key === event.currentTarget.dataset.field)
    const index = Number(event.detail.value)
    if (!item || !Number.isInteger(index) || !item.options[index]) return
    this.updatePlayingProfile(Object.assign({}, this.data.editProfile.playingProfile, { [item.key]: item.options[index] }))
  },
  toggleTrait(event) {
    if (this.data.saving) return
    const { field, value } = event.currentTarget.dataset
    const group = playerLevels.TRAITS.find(item => item.key === field)
    if (!group || !group.options.includes(value)) return
    const selected = this.data.editProfile.playingProfile[field]
    if (!selected.includes(value) && selected.length >= group.limit) {
      return wx.showToast({ title: `${group.label}最多选择 ${group.limit} 项`, icon: 'none' })
    }
    this.updatePlayingProfile(Object.assign({}, this.data.editProfile.playingProfile, {
      [field]: selected.includes(value) ? selected.filter(item => item !== value) : selected.concat(value)
    }))
  },
  changeAbilityGroup(event) {
    const index = Number(event.detail.value)
    if (this.data.saving || !Number.isInteger(index) || !playerLevels.ABILITY_GROUPS[index]) return
    this.setData(Object.assign({ abilityGroupIndex: index }, profileEditor.view(this.data.editProfile, index)))
  },
  changeAbility(event) {
    if (this.data.saving) return
    const id = event.currentTarget.dataset.id
    const state = Number(event.detail.value)
    if (!playerLevels.ABILITY_GROUPS.some(group => group.items.some(item => item.id === id)) || !Number.isInteger(state) || !playerLevels.ABILITY_STATES[state]) return
    const abilities = Object.assign({}, this.data.editProfile.playingProfile.abilities)
    if (state === 0) delete abilities[id]
    else abilities[id] = state
    this.updatePlayingProfile(Object.assign({}, this.data.editProfile.playingProfile, { abilities }))
  },
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
    if (validationError) return this.setData({ editError: validationError, editSection: !this.data.editProfile.nickname.trim() ? 'basics' : 'rating' })
    const skills = this.data.editProfile.skills.slice()
    const pendingSkill = this.data.newSkill.trim()
    if (pendingSkill && !skills.includes(pendingSkill)) {
      if (skills.length >= 6) return this.setData({ editError: '擅长技术最多填写 6 项' })
      skills.push(pendingSkill)
    }
    const submittedProfile = Object.assign({}, this.data.editProfile, {
      nickname: this.data.editProfile.nickname.trim(),
      district: this.data.editProfile.district.trim(),
      playingProfile: playerLevels.normalize(this.data.editProfile.playingProfile),
      skills
    })
    this.setData({ saving: true, editError: '' })
    try {
      await privacy.authorize()
      const saved = await api.profile.update({
        nickname: submittedProfile.nickname,
        city: '杭州',
        district: submittedProfile.district,
        ballAge: submittedProfile.ballAge,
        skills: submittedProfile.skills,
        ratingPlatform: submittedProfile.ratingPlatform,
        ratingValue: submittedProfile.ratingValue,
        playingProfile: submittedProfile.playingProfile
      })
      const changedPlayingProfile = JSON.stringify(submittedProfile.playingProfile) !== JSON.stringify(playerLevels.normalize(this.data.profile.playingProfile))
      if (changedPlayingProfile && (!saved || !saved.playingProfile)) {
        throw new Error('基础资料可能已保存，技术档案服务尚未更新，请稍后重试')
      }
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
        playingProfile: submittedProfile.playingProfile,
        playingSummary: playerLevels.summary(submittedProfile),
        complete: submittedProfile.nickname !== '新球友' && (submittedProfile.ballAge !== '未填写' || submittedProfile.skills.length > 0 || playerLevels.summary(submittedProfile).assessedCount > 0 || playerLevels.summary(submittedProfile).traits.length > 0 || Boolean(submittedProfile.ratingValue))
      })
      this.setData({ saving: false, editVisible: false, editDirty: false, profileDirty: false, newSkill: '', profile })
      wx.showToast({ title: '资料已保存', icon: 'success' })
      await this.loadProfile()
    } catch (error) {
      this.setData({
        saving: false,
        editDirty: true,
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
