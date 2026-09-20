const api = require('../../utils/api')
const errors = require('../../utils/error')

const PAGE_SIZE = 20
const MAX_REASON_LENGTH = 200
const VENUE_PAGE_SIZE = 50
const MAX_VENUE_PAGES = 20
const MAX_SELECTED_VENUES = 10

function timeValue(raw) {
  if (!raw) return NaN
  if (raw instanceof Date) return raw.getTime()
  if (typeof raw === 'number') return raw < 100000000000 ? raw * 1000 : raw
  if (typeof raw === 'object') {
    if (raw.$date !== undefined) return timeValue(raw.$date)
    if (raw._seconds !== undefined) return Number(raw._seconds) * 1000
    if (raw.seconds !== undefined) return Number(raw.seconds) * 1000
  }
  return new Date(raw).getTime()
}

function pad(value) { return String(value).padStart(2, '0') }

function todayDate() {
  const date = new Date()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function submittedText(raw) {
  const value = timeValue(raw)
  if (!Number.isFinite(value)) return '提交时间待同步'
  const date = new Date(value)
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const wasYesterday = date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate()
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (sameDay) return `今天 ${clock}`
  if (wasYesterday) return `昨天 ${clock}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

function maskMobile(raw) {
  const mobile = String(raw || '')
  return mobile.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
}

function formatApplication(raw = {}, page = 1) {
  const specialty = Array.isArray(raw.specialty) ? raw.specialty.filter(Boolean).slice(0, 8) : []
  const name = String(raw.realName || '').trim() || '未填写姓名'
  const mobile = String(raw.mobile || '')
  const experienceYears = Math.max(0, Number(raw.experienceYears || 0))
  const venueName = String(raw.venueName || '').trim() || '未填写球馆'
  return Object.assign({}, raw, {
    id: raw.id || raw._id || raw.applicationId || '',
    name,
    mobile,
    mobileMasked: maskMobile(mobile),
    experienceYears,
    experienceText: `${experienceYears} 年`,
    specialty,
    specialtyText: specialty.length ? specialty.join('、') : '未填写',
    venueName,
    qualification: String(raw.qualification || ''),
    introduction: String(raw.introduction || ''),
    submittedText: submittedText(raw.submittedAt),
    version: Math.max(1, Number(raw.version || 1)),
    listPage: page,
    ariaLabel: `${name}，${venueName}，${submittedText(raw.submittedAt)}`
  })
}

function formatVenue(raw = {}) {
  const nameOnly = raw.nameOnly === true || raw.listingMode === 'name_only'
  return {
    id: raw.id || raw._id || '',
    name: raw.name || '未命名球馆',
    district: raw.district || '',
    address: raw.address || '',
    verified: raw.verified === true || raw.partnerVerified === true,
    nameOnly,
    userContributed: raw.userContributed === true,
    meta: nameOnly ? '名称记录 · 杭州' : (raw.district || raw.address || '杭州'),
    selected: false
  }
}

function isOutcomeUnknown(error) {
  return Boolean(error && error.details && error.details.outcomeUnknown) || ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INTERNAL', 'INVALID_SERVER_RESPONSE'].includes(error && error.code)
}

function dedupe(items) {
  const byId = new Map()
  items.forEach((item) => { if (item && item.id) byId.set(item.id, item) })
  return Array.from(byId.values())
}

Page({
  data: {
    state: 'loading',
    errorMessage: '',
    syncError: '',
    loginRequired: false,
    items: [],
    page: 1,
    hasMore: false,
    loadingMore: false,
    refreshing: false,
    skeletonRows: [1, 2, 3],
    venues: [],
    venuesState: 'loading',
    venuesError: '',
    detailVisible: false,
    selectedApplication: null,
    selectedVenueIds: [],
    verificationDate: todayDate(),
    maxVerificationDate: todayDate(),
    featuredRank: '',
    approvalError: '',
    reviewMode: '',
    rejectionReason: '',
    reasonError: '',
    detailError: '',
    reviewing: false,
    outcomeUnknown: false,
    conflictPending: false,
    statusChecking: false,
    maxReasonLength: MAX_REASON_LENGTH
  },

  onLoad() {
    this.active = true
    if (wx.hideShareMenu) wx.hideShareMenu()
  },

  onShow() {
    this.active = true
    const forceVenueReload = this.reloadVenuesOnShow === true
    this.reloadVenuesOnShow = false
    if (this.hiddenReviewState || this.data.statusChecking) {
      const hidden = this.hiddenReviewState
      this.hiddenReviewState = null
      const patch = { reviewing: false, statusChecking: false }
      if (hidden && hidden.kind === 'unknown') {
        patch.outcomeUnknown = true
        patch.conflictPending = false
        patch.detailError = '网络中断，审核结果尚未确认。请先同步状态，或用原操作安全重试。'
      } else if (hidden && hidden.kind === 'error') {
        patch.outcomeUnknown = false
        patch.detailError = hidden.message
      }
      this.setData(patch)
    }
    return Promise.all([
      this.loadPending({ preserve: this.data.items.length > 0 }),
      this.loadVenues({ force: forceVenueReload })
    ])
  },

  onHide() {
    this.active = false
    this.listRun = Number(this.listRun || 0) + 1
    this.venueRun = Number(this.venueRun || 0) + 1
    this.listLoading = null
    this.venueLoading = null
  },

  onUnload() {
    this.destroyed = true
    this.onHide()
  },

  onPullDownRefresh() {
    if (this.data.detailVisible || this.data.reviewing || this.data.statusChecking) {
      wx.stopPullDownRefresh()
      return
    }
    this.setData({ refreshing: true })
    return Promise.all([
      this.loadPending({ preserve: true }),
      this.loadVenues({ force: true })
    ]).finally(() => {
      if (this.active !== false) {
        this.setData({ refreshing: false })
        wx.stopPullDownRefresh()
      }
    })
  },

  async loadPending(options = {}) {
    const append = options.append === true
    if (append && (this.data.loadingMore || !this.data.hasMore)) return
    if (!append && this.listLoading) return this.listLoading
    const page = append ? Number(this.data.page || 1) + 1 : 1
    const run = Number(this.listRun || 0) + 1
    this.listRun = run
    const hasCachedItems = this.data.items.length > 0
    this.setData(append
      ? { loadingMore: true, syncError: '' }
      : hasCachedItems && options.preserve !== false
        ? { syncError: '' }
        : { state: 'loading', errorMessage: '', syncError: '' })

    const task = (async () => {
      try {
        await getApp().ensureSession({ interactive: Boolean(options.interactive) })
        if (run !== this.listRun || this.active === false) return
        const result = await api.admin.pendingCoachApplications({ page, pageSize: PAGE_SIZE })
        if (run !== this.listRun || this.active === false) return
        const fresh = (result.items || []).map((item) => formatApplication(item, page))
        const items = append ? dedupe(this.data.items.concat(fresh)) : fresh
        const patch = {
          state: 'ready',
          loginRequired: false,
          errorMessage: '',
          syncError: '',
          items,
          page: Number(result.page || page),
          hasMore: result.hasMore === true,
          loadingMore: false
        }
        if (this.data.detailVisible && this.data.selectedApplication) {
          const latest = items.find((item) => item.id === this.data.selectedApplication.id)
          if (latest) {
            patch.selectedApplication = latest
            if (this.data.conflictPending) {
              this.reviewAttempt = null
              patch.conflictPending = false
              patch.outcomeUnknown = false
              patch.detailError = '申请已刷新，请按最新信息重新审核。'
            }
          } else if (!append && Number(this.data.selectedApplication.listPage || 1) === 1) {
            this.reviewAttempt = null
            Object.assign(patch, this.closedDetailState())
            wx.showToast({ title: '该申请已处理，队列已更新', icon: 'none' })
          }
        }
        this.setData(patch)
      } catch (error) {
        if (run !== this.listRun || this.active === false) return
        const forbidden = error && error.code === 'FORBIDDEN'
        const loginRequired = error && ['LOGIN_REQUIRED', 'UNAUTHENTICATED', 'BOOTSTRAP_REQUIRED', 'CONSENT_REQUIRED', 'CONSENT_VERSION_MISMATCH'].includes(error.code)
        if (forbidden || loginRequired) {
          this.reviewAttempt = null
          this.setData(Object.assign({
            state: forbidden ? 'forbidden' : 'error',
            loginRequired,
            items: [],
            errorMessage: forbidden ? '当前账号没有教练认证审核权限。' : errors.message(error),
            loadingMore: false,
            hasMore: false
          }, this.closedDetailState()))
        } else if (hasCachedItems) {
          this.setData({ state: 'ready', syncError: errors.message(error), loadingMore: false })
        } else {
          this.setData({ state: 'error', errorMessage: errors.message(error), loadingMore: false })
        }
      }
    })()
    if (!append) this.listLoading = task
    try {
      await task
    } finally {
      if (!append && this.listLoading === task) this.listLoading = null
      if (append && run === this.listRun && this.active !== false) this.setData({ loadingMore: false })
    }
  },

  async loadVenues(options = {}) {
    if (this.data.venuesState === 'ready' && options.force !== true) {
      this.applySuggestedVenueSelection()
      return
    }
    if (this.venueLoading) return this.venueLoading
    const run = Number(this.venueRun || 0) + 1
    this.venueRun = run
    this.setData({ venuesState: 'loading', venuesError: '' })
    const task = (async () => {
      try {
        await getApp().ensureSession({ interactive: Boolean(options.interactive) })
        if (run !== this.venueRun || this.active === false) return
        const collected = []
        for (let page = 1; page <= MAX_VENUE_PAGES; page += 1) {
          const result = await api.venues.list({ city: '杭州', page, pageSize: VENUE_PAGE_SIZE })
          if (run !== this.venueRun || this.active === false) return
          const pageItems = Array.isArray(result && result.items) ? result.items : []
          collected.push(...pageItems)
          if (pageItems.length < VENUE_PAGE_SIZE) break
        }
        // venues.list only returns active directory entries. A name-only entry
        // can be linked as a teaching location even though its public presenter
        // correctly does not describe the venue itself as platform-verified.
        const venues = dedupe(collected
          .map(formatVenue)
          .filter((venue) => venue.id && (venue.verified || venue.nameOnly)))
        const selected = new Set(this.data.selectedVenueIds)
        this.setData({ venues: venues.map((venue) => Object.assign({}, venue, { selected: selected.has(venue.id) })), venuesState: 'ready', venuesError: '' })
        this.applySuggestedVenueSelection()
      } catch (error) {
        if (run !== this.venueRun || this.active === false) return
        this.setData({ venuesState: 'error', venuesError: errors.message(error, '已核验球馆暂时无法加载') })
      }
    })()
    this.venueLoading = task
    try {
      await task
    } finally {
      if (this.venueLoading === task) this.venueLoading = null
    }
  },

  retryLoad() {
    if (this.data.loginRequired) return getApp().openLogin()
    return Promise.all([
      this.loadPending({ interactive: true, preserve: true }),
      this.loadVenues({ interactive: true, force: this.data.venuesState === 'error' })
    ])
  },

  retryVenues() {
    return this.loadVenues({ interactive: true, force: true })
  },

  createVenue() {
    if (this.data.reviewing || this.data.statusChecking) return
    this.reloadVenuesOnShow = true
    wx.navigateTo({ url: '/pages/venue-create/venue-create?from=coach-review' })
  },

  loadMore() {
    return this.loadPending({ append: true, preserve: true })
  },

  openApplication(event) {
    if (this.data.reviewing || this.data.statusChecking) return
    const id = event.currentTarget.dataset.id
    const selectedApplication = this.data.items.find((item) => item.id === id)
    if (!selectedApplication) return
    this.reviewAttempt = null
    this.venueSelectionTouched = false
    this.setData({
      detailVisible: true,
      selectedApplication,
      selectedVenueIds: [],
      verificationDate: todayDate(),
      featuredRank: '',
      approvalError: '',
      reviewMode: '',
      rejectionReason: '',
      reasonError: '',
      detailError: '',
      outcomeUnknown: false,
      conflictPending: false
    })
    this.applySuggestedVenueSelection()
  },

  applySuggestedVenueSelection() {
    const application = this.data.selectedApplication
    if (!this.data.detailVisible || !application || this.venueSelectionTouched || this.data.selectedVenueIds.length) return
    const expected = String(application.venueName || '').trim().toLowerCase()
    const matching = this.data.venues.find((venue) => venue.name.trim().toLowerCase() === expected)
    if (matching) this.setData({
      selectedVenueIds: [matching.id],
      venues: this.data.venues.map((venue) => Object.assign({}, venue, { selected: venue.id === matching.id }))
    })
  },

  closedDetailState() {
    return {
      detailVisible: false,
      selectedApplication: null,
      selectedVenueIds: [],
      approvalError: '',
      reviewMode: '',
      rejectionReason: '',
      reasonError: '',
      detailError: '',
      reviewing: false,
      outcomeUnknown: false,
      conflictPending: false,
      statusChecking: false
    }
  },

  closeDetail() {
    if (this.data.reviewing || this.data.statusChecking) return
    if (this.data.outcomeUnknown || this.data.conflictPending) {
      wx.showToast({ title: '请先确认最新审核状态', icon: 'none' })
      return
    }
    this.reviewAttempt = null
    this.setData(this.closedDetailState())
  },

  noop() {},

  toggleVenue(event) {
    if (this.data.reviewing || this.data.outcomeUnknown || this.data.conflictPending) return
    const id = event.currentTarget.dataset.id
    if (!this.data.venues.some((venue) => venue.id === id)) return
    const selected = this.data.selectedVenueIds.slice()
    const index = selected.indexOf(id)
    if (index >= 0) selected.splice(index, 1)
    else {
      if (selected.length >= MAX_SELECTED_VENUES) {
        wx.showToast({ title: `最多关联 ${MAX_SELECTED_VENUES} 家球馆`, icon: 'none' })
        return
      }
      selected.push(id)
    }
    this.venueSelectionTouched = true
    const selectedSet = new Set(selected)
    this.setData({
      selectedVenueIds: selected,
      venues: this.data.venues.map((venue) => Object.assign({}, venue, { selected: selectedSet.has(venue.id) })),
      approvalError: '',
      detailError: ''
    })
  },

  changeVerificationDate(event) {
    if (this.data.reviewing || this.data.outcomeUnknown || this.data.conflictPending) return
    this.setData({ verificationDate: String(event.detail.value || ''), approvalError: '' })
  },

  changeFeaturedRank(event) {
    if (this.data.reviewing || this.data.outcomeUnknown || this.data.conflictPending) return
    const featuredRank = String(event.detail.value || '').replace(/\D/g, '').slice(0, 4)
    this.setData({ featuredRank, approvalError: '' })
  },

  beginReject() {
    if (this.data.reviewing || this.data.outcomeUnknown || this.data.conflictPending) return
    this.setData({ reviewMode: 'reject', rejectionReason: '', reasonError: '', approvalError: '', detailError: '' })
  },

  cancelReject() {
    if (!this.data.reviewing) this.setData({ reviewMode: '', rejectionReason: '', reasonError: '' })
  },

  changeRejectionReason(event) {
    if (this.data.reviewing || this.data.outcomeUnknown || this.data.conflictPending) return
    this.setData({ rejectionReason: event.detail.value, reasonError: '', detailError: '' })
  },

  approvalPayload() {
    if (this.data.venuesState !== 'ready') return { error: '请先加载球馆目录' }
    if (!this.data.venues.length) return { error: '暂无可关联球馆，请先录入球馆后重试' }
    const validIds = new Set(this.data.venues.map((venue) => venue.id))
    const venueIds = this.data.selectedVenueIds.filter((id) => validIds.has(id))
    if (!venueIds.length) return { error: '请至少选择一家授课球馆' }
    const verificationDate = String(this.data.verificationDate || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(verificationDate)) return { error: '请选择身份核验日期' }
    const rankText = String(this.data.featuredRank || '')
    if (rankText && (!/^\d{1,4}$/.test(rankText) || Number(rankText) > 9999)) return { error: '推荐排序请填写 0—9999' }
    const payload = { venueIds, verificationDate }
    if (rankText) payload.featuredRank = Number(rankText)
    return { payload }
  },

  approveApplication() {
    const selected = this.data.selectedApplication
    if (!selected || this.data.reviewing || this.data.outcomeUnknown || this.data.conflictPending) return Promise.resolve(false)
    const approval = this.approvalPayload()
    if (approval.error) {
      this.setData({ approvalError: approval.error })
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      wx.showModal({
        title: '确认通过教练认证？',
        content: `通过后将为「${selected.name}」创建已认证教练档案；补齐可约时段前不会公开展示。`,
        confirmText: '确认通过',
        confirmColor: '#0f5c45',
        success: (result) => {
          if (!result.confirm) return resolve(false)
          Promise.resolve(this.performReview('approve', '', { approval: approval.payload })).then(resolve, resolve)
        },
        fail: () => resolve(false)
      })
    })
  },

  rejectApplication() {
    const reason = String(this.data.rejectionReason || '').trim()
    if (reason.length < 2) {
      this.setData({ reasonError: '请填写至少 2 个字的驳回原因' })
      return Promise.resolve(false)
    }
    if (reason.length > MAX_REASON_LENGTH) {
      this.setData({ reasonError: `驳回原因不能超过 ${MAX_REASON_LENGTH} 个字` })
      return Promise.resolve(false)
    }
    return this.performReview('reject', reason)
  },

  retryUnknownReview() {
    const attempt = this.reviewAttempt
    if (!attempt || !this.data.outcomeUnknown || this.data.reviewing) return Promise.resolve(false)
    return this.performReview(attempt.decision, attempt.reason, { reuseAttempt: true })
  },

  async performReview(decision, reason, options = {}) {
    const selected = this.data.selectedApplication
    if (!selected || this.data.reviewing || this.active === false) return false
    const previous = this.reviewAttempt
    if (previous && !options.reuseAttempt) {
      wx.showToast({ title: '上次结果待确认，请先同步状态', icon: 'none' })
      return false
    }
    const approval = options.approval || {}
    const attempt = previous || {
      applicationId: selected.id,
      expectedVersion: selected.version,
      decision,
      reason,
      venueIds: decision === 'approve' ? approval.venueIds.slice() : [],
      verificationDate: decision === 'approve' ? approval.verificationDate : '',
      featuredRank: decision === 'approve' && approval.featuredRank !== undefined ? approval.featuredRank : undefined,
      requestId: api.createRequestId()
    }
    if (attempt.applicationId !== selected.id || attempt.decision !== decision || attempt.reason !== reason) return false
    this.reviewAttempt = attempt
    this.listRun = Number(this.listRun || 0) + 1
    this.listLoading = null
    this.setData({ reviewing: true, detailError: '', reasonError: '', approvalError: '', outcomeUnknown: false })
    const payload = {
      applicationId: attempt.applicationId,
      expectedVersion: attempt.expectedVersion,
      decision: attempt.decision,
      reason: attempt.reason
    }
    if (attempt.decision === 'approve') {
      payload.venueIds = attempt.venueIds.slice()
      payload.verificationDate = attempt.verificationDate
      if (attempt.featuredRank !== undefined) payload.featuredRank = attempt.featuredRank
    }
    try {
      await api.admin.reviewCoachApplication(payload, { requestId: attempt.requestId, retry: false })
      this.reviewAttempt = null
      const reviewedName = selected.name
      // Reads may start while the write is in flight. Invalidate them again
      // after commit so no pre-commit response can restore this row.
      this.listRun = Number(this.listRun || 0) + 1
      this.listLoading = null
      if (this.active === false) {
        this.hiddenReviewState = { kind: 'success' }
        return reviewedName
      }
      this.setData(Object.assign({
        items: this.data.items.filter((item) => item.id !== attempt.applicationId)
      }, this.closedDetailState()))
      wx.showToast({ title: decision === 'approve' ? '教练认证已通过' : '已驳回申请', icon: 'none' })
      await this.loadPending({ preserve: true, forceFirstPage: true })
      return reviewedName
    } catch (error) {
      if (this.active === false) {
        if (isOutcomeUnknown(error)) {
          this.hiddenReviewState = { kind: 'unknown' }
        } else {
          this.reviewAttempt = null
          this.hiddenReviewState = { kind: 'error', message: errors.message(error) }
        }
        return false
      }
      if (error && ['VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(error.code)) {
        this.reviewAttempt = null
        this.setData({
          reviewing: false,
          outcomeUnknown: false,
          conflictPending: true,
          detailError: '申请已被更新，正在获取最新状态…'
        })
        await this.syncSelectedStatus({ fromConflict: true })
        return false
      }
      if (error && error.code === 'FORBIDDEN') {
        this.reviewAttempt = null
        this.setData(Object.assign({
          state: 'forbidden',
          items: [],
          errorMessage: '当前账号没有教练认证审核权限。'
        }, this.closedDetailState()))
        return false
      }
      if (isOutcomeUnknown(error)) {
        this.setData({
          reviewing: false,
          outcomeUnknown: true,
          conflictPending: false,
          detailError: '网络中断，审核结果尚未确认。请先同步状态，或用原操作安全重试。'
        })
        return false
      }
      this.reviewAttempt = null
      this.setData({ reviewing: false, outcomeUnknown: false, detailError: errors.message(error) })
      return false
    }
  },

  async syncSelectedStatus(options = {}) {
    const selected = this.data.selectedApplication
    if (!selected || this.data.statusChecking || this.data.reviewing || this.active === false) return false
    this.setData({ statusChecking: true, detailError: options.fromConflict ? '申请已被更新，正在获取最新状态…' : '正在确认最新审核状态…' })
    try {
      await getApp().ensureSession()
      if (this.active === false) return false
      const result = await api.admin.getCoachApplication({ applicationId: selected.id }, { deduplicate: false })
      if (this.active === false) return false
      const raw = result && result.application
      if (!raw || raw.status !== 'reviewing') {
        this.reviewAttempt = null
        this.setData(Object.assign({
          state: 'ready',
          items: this.data.items.filter((item) => item.id !== selected.id),
          syncError: ''
        }, this.closedDetailState()))
        const statusText = raw && raw.status === 'approved' ? '该教练认证已通过' : raw && raw.status === 'rejected' ? '该申请已被驳回' : '该申请已离开待审队列'
        wx.showToast({ title: statusText, icon: 'none' })
        return true
      }
      const latest = formatApplication(raw, selected.listPage || 1)
      const wasConflict = this.data.conflictPending
      if (wasConflict) this.reviewAttempt = null
      this.setData({
        state: 'ready',
        items: this.data.items.map((item) => item.id === latest.id ? latest : item),
        selectedApplication: latest,
        statusChecking: false,
        conflictPending: false,
        outcomeUnknown: wasConflict ? false : Boolean(this.reviewAttempt),
        detailError: wasConflict
          ? '申请已刷新，请按最新信息重新审核。'
          : this.reviewAttempt ? '申请仍在待审，可安全重试上次操作。' : '申请仍在待审。'
      })
      return true
    } catch (error) {
      if (this.active === false) return false
      if (error && error.code === 'FORBIDDEN') {
        this.reviewAttempt = null
        this.setData(Object.assign({ state: 'forbidden', items: [], errorMessage: '当前账号没有教练认证审核权限。' }, this.closedDetailState()))
      } else if (error && error.code === 'NOT_FOUND') {
        this.reviewAttempt = null
        this.setData(Object.assign({ state: 'ready', items: this.data.items.filter((item) => item.id !== selected.id) }, this.closedDetailState()))
        wx.showToast({ title: '该申请已不存在，队列已更新', icon: 'none' })
      } else {
        this.setData({ statusChecking: false, detailError: `状态同步失败：${errors.message(error)}` })
      }
      return false
    }
  }
})
