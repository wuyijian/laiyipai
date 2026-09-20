const api = require('../../utils/api')
const errors = require('../../utils/error')
const present = require('../../utils/present')
const share = require('../../utils/share')

const TAGS = ['教学', '比赛', '训练', '切磋']
const SUBMISSION_STATUSES = ['reviewing', 'approved', 'rejected']

function formatSubmission(raw = {}) {
  const source = raw && raw.submission !== undefined ? raw.submission : raw
  if (!source || typeof source !== 'object') return null
  const rawStatus = source.status || source.verificationStatus
  const status = rawStatus === 'pending' ? 'reviewing' : rawStatus === 'verified' ? 'approved' : rawStatus
  if (!SUBMISSION_STATUSES.includes(status)) return null
  const views = {
    reviewing: {
      statusLabel: '审核中',
      title: '已提交，等待审核',
      copy: '审核通过前仅你可见，暂不能用于发布球局。'
    },
    approved: {
      statusLabel: '已通过',
      title: '球馆已通过审核',
      copy: '现在可以在发布球局时选择这家球馆。'
    },
    rejected: {
      statusLabel: '需修改',
      title: '这次提交需要修改',
      copy: '查看原因，修改适合活动后可以重新提交。'
    }
  }
  return Object.assign({}, source, views[status], {
    id: source.id || source._id || source.submissionId || '',
    venueId: source.venueId || '',
    name: source.name || '未命名球馆',
    activityTags: Array.isArray(source.activityTags) ? source.activityTags : [],
    rejectionReason: source.rejectionReason || source.reviewReason || '',
    status
  })
}

Page({
  data: {
    name: '', city: '杭州', fromPublish: false, fromCoachReview: false,
    tags: TAGS.map((label) => ({ label, selected: false })),
    suggestions: [], searchState: 'idle', errorMessage: '',
    saving: false, outcomeUnknown: false,
    savedVenue: null, reused: false,
    submission: null, submissionLoading: false,
    submissionLoadError: '', editingRejected: false
  },

  onLoad(options = {}) {
    share.disable()
    this.active = true
    this.submissionId = options.submissionId || options.id || ''
    this.setData({
      fromPublish: options.from === 'publish',
      fromCoachReview: options.from === 'coach-review'
    })
    if (this.submissionId) this.loadSubmission()
  },

  onShow() {
    if (!this.pendingSaveAfterLogin) return
    const app = getApp()
    if (!(app.globalData && app.globalData.session)) {
      // The user returned with "先逛逛". Do not keep an old write intent that
      // could fire after an unrelated login later.
      this.pendingSaveAfterLogin = false
      return
    }
    this.pendingSaveAfterLogin = false
    return this.save()
  },

  onUnload() {
    this.active = false
    this.pendingSaveAfterLogin = false
    this.searchRun = Number(this.searchRun || 0) + 1
  },

  formLocked() {
    return this.data.saving || this.data.outcomeUnknown || Boolean(this.data.savedVenue) || Boolean(this.data.submission && !this.data.editingRejected)
  },

  changeName(event) {
    if (this.formLocked() || this.data.editingRejected) return
    this.searchRun = Number(this.searchRun || 0) + 1
    this.attempt = null
    this.setData({ name: event.detail.value, suggestions: [], searchState: 'idle', errorMessage: '' })
  },

  toggleTag(event) {
    if (this.formLocked()) return
    const label = event.currentTarget.dataset.value
    this.attempt = null
    this.setData({ tags: this.data.tags.map((item) => item.label === label ? Object.assign({}, item, { selected: !item.selected }) : item) })
  },

  async loadSubmission() {
    if (!this.submissionId || this.data.submissionLoading) return
    if (!api.venues.submissions || typeof api.venues.submissions.get !== 'function') {
      this.setData({ submissionLoadError: '当前云端暂不支持查看审核进度，请先更新 api 云函数' })
      return
    }
    this.setData({ submissionLoading: true, submissionLoadError: '', errorMessage: '' })
    try {
      await getApp().ensureSession({ interactive: true })
      if (this.active === false) return
      const result = await api.venues.submissions.get({ submissionId: this.submissionId })
      if (this.active !== false) this.applyResult(result)
    } catch (error) {
      if (this.active !== false) this.setData({ submissionLoadError: errors.message(error, '审核进度暂时没加载出来') })
    } finally {
      if (this.active !== false) this.setData({ submissionLoading: false })
    }
  },

  async searchExisting() {
    const name = this.data.name.trim()
    if (name.length < 2 || this.formLocked() || this.data.editingRejected) return
    const run = Number(this.searchRun || 0) + 1
    this.searchRun = run
    this.setData({ searchState: 'loading' })
    try {
      const app = getApp()
      const readOptions = { publicRead: !(app.globalData && app.globalData.session) }
      if (run !== this.searchRun || this.active === false) return
      const result = await api.venues.list({ city: '杭州', keyword: name.slice(0, 30), page: 1, pageSize: 5 }, readOptions)
      if (run !== this.searchRun || this.active === false) return
      this.setData({ suggestions: (result.items || []).map(present.venue), searchState: 'ready' })
    } catch (_) {
      if (run === this.searchRun && this.active !== false) this.setData({ searchState: 'error' })
    }
  },

  async useExisting(event) {
    if (this.formLocked()) return
    const selected = this.data.suggestions.find((item) => item.id === event.currentTarget.dataset.id)
    if (!selected) return
    this.searchRun = Number(this.searchRun || 0) + 1
    this.setData({ saving: true, errorMessage: '' })
    try {
      const app = getApp()
      const readOptions = { publicRead: !(app.globalData && app.globalData.session) }
      if (this.active === false) return
      const venue = await api.venues.get({ venueId: selected.id }, readOptions)
      if (!venue || venue.id !== selected.id) throw Object.assign(new Error('球馆暂不可用，请重试'), { code: 'NOT_FOUND' })
      if (this.active !== false) this.finishExisting(venue, true)
    } catch (error) {
      if (this.active !== false) this.setData({ errorMessage: errors.message(error) })
    } finally {
      if (this.active !== false) this.setData({ saving: false })
    }
  },

  async save() {
    if (this.data.saving) return
    if (this.data.savedVenue) return this.continueWithVenue()
    if (this.data.submission && !this.data.editingRejected) return
    const name = this.data.name.trim().replace(/\s+/g, ' ')
    if (name.length < 2 || name.length > 60) {
      this.setData({ errorMessage: '请填写 2—60 个字的球馆名称' })
      return
    }
    const activityTags = this.data.tags.filter((item) => item.selected).map((item) => item.label)
    const resubmitting = Boolean(this.data.editingRejected && this.data.submission && this.data.submission.id)
    this.searchRun = Number(this.searchRun || 0) + 1
    this.attempt = this.attempt || {
      requestId: api.createRequestId(),
      type: resubmitting ? 'resubmit' : 'create',
      payload: resubmitting
        ? {
            submissionId: this.data.submission.id,
            activityTags,
            confirmPublic: true,
            expectedVersion: this.data.submission.version
          }
        : { name, activityTags, confirmPublic: true }
    }
    this.setData({ saving: true, errorMessage: '', searchState: 'idle' })
    try {
      const app = getApp()
      if (!(app.globalData && app.globalData.session)) this.pendingSaveAfterLogin = true
      await app.ensureSession({ interactive: true })
      this.pendingSaveAfterLogin = false
      if (this.active === false) return
      const method = this.attempt.type === 'resubmit' && api.venues.submissions && api.venues.submissions.resubmit
        ? api.venues.submissions.resubmit
        : this.attempt.type === 'resubmit' ? null : api.venues.create
      if (!method) throw Object.assign(new Error('当前云端暂不支持重新提交，请先更新 api 云函数'), { code: 'ACTION_NOT_FOUND' })
      const result = await method(this.attempt.payload, { requestId: this.attempt.requestId, retry: false })
      if (!result || (!result.submission && !result.venue && !formatSubmission(result))) {
        throw Object.assign(new Error('提交结果尚未确认，请重试'), { code: 'REQUEST_TIMEOUT' })
      }
      if (this.active !== false) this.applyResult(result)
    } catch (error) {
      if (this.active === false) return
      if (error && error.code === 'LOGIN_REQUIRED') {
        this.setData({ errorMessage: '', outcomeUnknown: false })
        return
      }
      this.pendingSaveAfterLogin = false
      const failedAttempt = this.attempt
      const versionConflict = error.code === 'VERSION_CONFLICT' && failedAttempt && failedAttempt.type === 'resubmit'
      const unknown = Boolean(error.details && error.details.outcomeUnknown) || ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INTERNAL'].includes(error.code)
      if (!unknown || versionConflict) this.attempt = null
      if (versionConflict) {
        this.setData({ errorMessage: '审核状态已更新，正在刷新最新结果…', outcomeUnknown: false })
        await this.loadSubmission()
        return
      }
      const message = error.code === 'ACTION_NOT_FOUND' || error.code === 'CLOUD_FUNCTION_NOT_DEPLOYED'
        ? (failedAttempt && failedAttempt.type === 'resubmit'
            ? '云端暂不支持历史记录处理，请先更新 api 云函数'
            : '云端暂不支持直接录入球馆，请先更新 api 云函数')
        : unknown ? '保存结果尚未确认，请重试；不会重复生成球馆。' : errors.message(error, '球馆暂时未保存，请重试')
      this.setData({ errorMessage: message, outcomeUnknown: unknown })
    } finally {
      if (this.active !== false) this.setData({ saving: false })
    }
  },

  applyResult(rawResult) {
    const attemptType = this.attempt && this.attempt.type
    const rawObject = rawResult && typeof rawResult === 'object' ? rawResult : null
    const hasOwn = (key) => Boolean(rawObject && Object.prototype.hasOwnProperty.call(rawObject, key))
    const envelope = hasOwn('submission') || hasOwn('venue') || hasOwn('created') || hasOwn('duplicateExisting')
    const legacyWithoutSubmission = envelope && !hasOwn('submission')
    const result = envelope ? rawObject : { submission: rawResult }
    const submission = formatSubmission(result.submission)
    const venue = result.venue && result.venue.id ? present.venue(result.venue) : null
    const usableVenue = venue && (!submission || submission.status === 'approved') ? venue : null
    this.attempt = null
    if (usableVenue) {
      const createdFromForm = attemptType === 'create'
      this.setData({
        savedVenue: usableVenue,
        reused: result.duplicateExisting === true || (legacyWithoutSubmission && result.created === false),
        // New direct entries should never stop on the historical review UI.
        submission: createdFromForm ? null : submission,
        editingRejected: false,
        outcomeUnknown: false,
        saving: false,
        errorMessage: ''
      }, () => {
        if (createdFromForm && (this.data.fromPublish || this.data.fromCoachReview)) this.continueWithVenue()
      })
      return
    }
    if (submission) {
      if (attemptType === 'create') {
        this.setData({
          submission: null,
          savedVenue: null,
          reused: false,
          editingRejected: false,
          outcomeUnknown: false,
          saving: false,
          errorMessage: '当前云端仍在使用旧审核流程，请部署新版 api 云函数后重试'
        })
        return
      }
      this.submissionId = submission.id || this.submissionId
      this.setData({
        submission,
        savedVenue: null,
        reused: false,
        editingRejected: false,
        outcomeUnknown: false,
        saving: false,
        errorMessage: '',
        name: submission.name,
        tags: TAGS.map((label) => ({ label, selected: submission.activityTags.includes(label) }))
      })
      return
    }
    this.setData({ errorMessage: '云端未返回可用球馆，请更新 api 云函数后再试' })
  },

  finishExisting(venue, continueNow) {
    this.attempt = null
    this.setData({
      savedVenue: present.venue(venue), reused: true, submission: null,
      editingRejected: false, outcomeUnknown: false, saving: false, errorMessage: ''
    })
    if (continueNow) this.continueWithVenue()
  },

  editRejected() {
    const submission = this.data.submission
    if (!submission || submission.status !== 'rejected' || this.data.saving) return
    this.attempt = null
    this.setData({
      editingRejected: true,
      name: submission.name,
      tags: TAGS.map((label) => ({ label, selected: submission.activityTags.includes(label) })),
      suggestions: [], searchState: 'idle', errorMessage: ''
    })
  },

  cancelEditRejected() {
    if (this.data.saving || this.data.outcomeUnknown) return
    this.attempt = null
    this.setData({ editingRejected: false, suggestions: [], searchState: 'idle', errorMessage: '' })
  },

  startNewSubmission() {
    if (this.data.saving || this.data.outcomeUnknown) return
    this.attempt = null
    this.submissionId = ''
    this.setData({
      submission: null, savedVenue: null, editingRejected: false,
      name: '', tags: TAGS.map((label) => ({ label, selected: false })),
      suggestions: [], searchState: 'idle', errorMessage: ''
    })
  },

  async useApprovedVenue() {
    const submission = this.data.submission
    if (!submission || submission.status !== 'approved' || !submission.venueId || this.data.saving) return
    this.setData({ saving: true, errorMessage: '' })
    try {
      await getApp().ensureSession({ interactive: true })
      const venue = await api.venues.get({ venueId: submission.venueId })
      if (!venue || venue.id !== submission.venueId) throw Object.assign(new Error('已通过的球馆暂不可用，请稍后重试'), { code: 'NOT_FOUND' })
      if (this.active !== false) this.finishExisting(venue, true)
    } catch (error) {
      if (this.active !== false) this.setData({ errorMessage: errors.message(error) })
    } finally {
      if (this.active !== false) this.setData({ saving: false })
    }
  },

  continueWithVenue() {
    const venue = this.data.savedVenue
    if (!venue || this.navigating) return
    this.navigating = true
    const fail = () => { this.navigating = false }
    if (this.data.fromPublish) {
      const channel = this.getOpenerEventChannel && this.getOpenerEventChannel()
      if (channel && channel.emit) {
        channel.emit('venueCreated', { venue })
        wx.navigateBack({ fail })
      } else {
        this.navigating = false
        this.setData({ errorMessage: '球馆已可用，请返回发布页重新选择' })
      }
    } else if (this.data.fromCoachReview) {
      wx.navigateBack({ fail })
    } else {
      wx.redirectTo({ url: `/pages/venue-detail/venue-detail?id=${encodeURIComponent(venue.id)}`, fail })
    }
  },

  leaveResult() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/profile' }) })
  }
})
