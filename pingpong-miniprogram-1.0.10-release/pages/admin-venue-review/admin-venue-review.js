const api = require('../../utils/api')
const errors = require('../../utils/error')

const PAGE_SIZE = 20
const MAX_REASON_LENGTH = 200

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

function formatSubmission(raw = {}, page = 1) {
  const submitter = raw.submitter && typeof raw.submitter === 'object' ? raw.submitter : {}
  const activityTags = Array.isArray(raw.activityTags) ? raw.activityTags.filter(Boolean).slice(0, 4) : []
  const name = raw.name || '未命名球馆'
  const submitterName = submitter.displayName || '球友'
  return Object.assign({}, raw, {
    id: raw.id || raw._id || raw.submissionId || '',
    name,
    city: raw.city || '杭州',
    activityTags,
    submitterName,
    submitterId: submitter.playerId || '',
    submittedText: submittedText(raw.submittedAt),
    version: Math.max(1, Number(raw.version || 1)),
    listPage: page,
    ariaLabel: `${name}，${submitterName}提交，${submittedText(raw.submittedAt)}`
  })
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
    detailVisible: false,
    selectedSubmission: null,
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
    return this.loadPending({ preserve: this.data.items.length > 0 })
  },

  onHide() {
    this.active = false
    this.listRun = Number(this.listRun || 0) + 1
    // Do not let onShow reuse a request whose response was invalidated above.
    this.listLoading = null
  },

  onUnload() {
    this.onHide()
  },

  onPullDownRefresh() {
    if (this.data.detailVisible || this.data.reviewing || this.data.statusChecking) {
      wx.stopPullDownRefresh()
      return
    }
    this.setData({ refreshing: true })
    return this.loadPending({ preserve: true }).finally(() => {
      this.setData({ refreshing: false })
      wx.stopPullDownRefresh()
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
        const result = await api.admin.pendingVenueSubmissions({ page, pageSize: PAGE_SIZE })
        if (run !== this.listRun || this.active === false) return
        const fresh = (result.items || []).map((item) => formatSubmission(item, page))
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
        if (this.data.detailVisible && this.data.selectedSubmission) {
          const latest = items.find((item) => item.id === this.data.selectedSubmission.id)
          if (latest) {
            patch.selectedSubmission = latest
            if (this.data.conflictPending) {
              this.reviewAttempt = null
              patch.conflictPending = false
              patch.outcomeUnknown = false
              patch.detailError = '申请已刷新，请按最新信息重新审核。'
            }
          } else if (!append && Number(this.data.selectedSubmission.listPage || 1) === 1) {
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
            errorMessage: forbidden ? '当前账号没有球馆审核权限。' : errors.message(error),
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

  retryLoad() {
    if (this.data.loginRequired) return getApp().openLogin()
    return this.loadPending({ interactive: true, preserve: true })
  },

  loadMore() {
    return this.loadPending({ append: true, preserve: true })
  },

  openSubmission(event) {
    if (this.data.reviewing || this.data.statusChecking) return
    const id = event.currentTarget.dataset.id
    const selectedSubmission = this.data.items.find((item) => item.id === id)
    if (!selectedSubmission) return
    this.reviewAttempt = null
    this.setData({
      detailVisible: true,
      selectedSubmission,
      reviewMode: '',
      rejectionReason: '',
      reasonError: '',
      detailError: '',
      outcomeUnknown: false,
      conflictPending: false
    })
  },

  closedDetailState() {
    return {
      detailVisible: false,
      selectedSubmission: null,
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

  beginReject() {
    if (this.data.reviewing || this.data.outcomeUnknown || this.data.conflictPending) return
    this.setData({ reviewMode: 'reject', rejectionReason: '', reasonError: '', detailError: '' })
  },

  cancelReject() {
    if (!this.data.reviewing) this.setData({ reviewMode: '', rejectionReason: '', reasonError: '' })
  },

  changeRejectionReason(event) {
    if (this.data.reviewing || this.data.outcomeUnknown || this.data.conflictPending) return
    this.setData({ rejectionReason: event.detail.value, reasonError: '', detailError: '' })
  },

  approveSubmission() {
    const selected = this.data.selectedSubmission
    if (!selected || this.data.reviewing || this.data.outcomeUnknown || this.data.conflictPending) return Promise.resolve(false)
    return new Promise((resolve) => {
      wx.showModal({
        title: '确认通过这家球馆？',
        content: `通过后「${selected.name}」会立即公开，并可用于发布球局。`,
        confirmText: '确认通过',
        confirmColor: '#0f5c45',
        success: (result) => {
          if (!result.confirm) return resolve(false)
          Promise.resolve(this.performReview('approve', '')).then(resolve, resolve)
        },
        fail: () => resolve(false)
      })
    })
  },

  rejectSubmission() {
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
    const selected = this.data.selectedSubmission
    if (!selected || this.data.reviewing) return false
    const previous = this.reviewAttempt
    if (previous && !options.reuseAttempt) {
      wx.showToast({ title: '上次结果待确认，请先同步状态', icon: 'none' })
      return false
    }
    const attempt = previous || {
      submissionId: selected.id,
      expectedVersion: selected.version,
      decision,
      reason,
      requestId: api.createRequestId()
    }
    if (attempt.submissionId !== selected.id || attempt.decision !== decision || attempt.reason !== reason) return false
    this.reviewAttempt = attempt
    // A list read that started before this mutation must never restore the
    // reviewed row after the write completes.
    this.listRun = Number(this.listRun || 0) + 1
    this.listLoading = null
    this.setData({ reviewing: true, detailError: '', reasonError: '', outcomeUnknown: false })
    try {
      await api.admin.reviewVenueSubmission({
        submissionId: attempt.submissionId,
        expectedVersion: attempt.expectedVersion,
        decision: attempt.decision,
        reason: attempt.reason
      }, { requestId: attempt.requestId, retry: false })
      this.reviewAttempt = null
      const reviewedName = selected.name
      this.setData(Object.assign({
        items: this.data.items.filter((item) => item.id !== attempt.submissionId)
      }, this.closedDetailState()))
      const label = decision === 'approve' ? '球馆已通过审核' : '已驳回申请'
      wx.showToast({ title: label, icon: 'none' })
      await this.loadPending({ preserve: true })
      return reviewedName
    } catch (error) {
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
          errorMessage: '当前账号没有球馆审核权限。'
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
    const selected = this.data.selectedSubmission
    if (!selected || this.data.statusChecking || this.data.reviewing) return false
    this.setData({ statusChecking: true, detailError: options.fromConflict ? '申请已被更新，正在获取最新状态…' : '正在确认最新审核状态…' })
    try {
      await getApp().ensureSession()
      const result = await api.admin.getVenueSubmission({ submissionId: selected.id }, { deduplicate: false })
      const raw = result && result.submission
      if (!raw || raw.status !== 'reviewing') {
        this.reviewAttempt = null
        this.setData(Object.assign({
          state: 'ready',
          items: this.data.items.filter((item) => item.id !== selected.id),
          syncError: ''
        }, this.closedDetailState()))
        const statusText = raw && raw.status === 'approved' ? '该球馆已通过审核' : raw && raw.status === 'rejected' ? '该申请已被驳回' : '该申请已离开待审队列'
        wx.showToast({ title: statusText, icon: 'none' })
        return true
      }
      const latest = formatSubmission(raw, selected.listPage || 1)
      const wasConflict = this.data.conflictPending
      if (wasConflict) this.reviewAttempt = null
      this.setData({
        state: 'ready',
        items: this.data.items.map((item) => item.id === latest.id ? latest : item),
        selectedSubmission: latest,
        statusChecking: false,
        conflictPending: false,
        outcomeUnknown: wasConflict ? false : Boolean(this.reviewAttempt),
        detailError: wasConflict
          ? '申请已刷新，请按最新信息重新审核。'
          : this.reviewAttempt ? '申请仍在待审，可安全重试上次操作。' : '申请仍在待审。'
      })
      return true
    } catch (error) {
      if (error && error.code === 'FORBIDDEN') {
        this.reviewAttempt = null
        this.setData(Object.assign({ state: 'forbidden', items: [], errorMessage: '当前账号没有球馆审核权限。' }, this.closedDetailState()))
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
