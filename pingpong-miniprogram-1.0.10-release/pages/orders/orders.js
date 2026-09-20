const api = require('../../utils/api')
const clientState = require('../../utils/client-state')
const present = require('../../utils/present')
const errors = require('../../utils/error')
const tabBar = require('../../utils/tab-bar')

const TYPE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'match', label: '球局' },
  { value: 'coach', label: '教练课' }
]

function appointmentTimestamp(item) {
  const raw = item && item.raw || {}
  const resource = item && item.kind === 'coach' ? raw.booking : raw.match
  const value = new Date(resource && resource.startAt).getTime()
  return Number.isFinite(value) ? value : null
}

Page({
  data: {
    state: 'loading',
    errorMessage: '',
    syncError: '',
    period: 'upcoming',
    type: 'all',
    typeOptions: TYPE_OPTIONS,
    allAppointments: [],
    appointments: [],
    joinRequests: [],
    joinRequestsState: 'idle',
    joinRequestsError: '',
    refreshing: false,
    hasHostMatches: false,
    requestBusyMatchId: '',
    emptyTitle: '还没有待开始的预约',
    emptyCopy: '找到合适的球局后可直接加入；教练课需要先选择具体时段。',
    emptyActionText: '去首页看看',
    actionBusyId: '',
    cancelSheet: false,
    selectedAppointment: null,
    cancelReasons: ['临时有事', '时间不合适', '身体不适', '行程有变', '其他原因'],
    cancelReasonIndex: 0,
    cancelBusy: false
  },

  onShow() {
    tabBar.sync(this, 'pages/orders/orders')
    this.visible = true
    if (clientState.consumeJoinRequestsDestination()) this.setData({ period: 'upcoming', type: 'all' })
    return this.loadAppointments()
  },

  onHide() {
    this.visible = false
    clearTimeout(this.refreshTimer)
    this.appointmentRun = (this.appointmentRun || 0) + 1
    this.joinRequestRun = (this.joinRequestRun || 0) + 1
    this.loading = null
    this.joinRequestsLoading = null
    this.manualRefresh = null
    this.setData({ refreshing: false })
  },

  onUnload() {
    this.onHide()
  },

  scheduleRefresh() {
    clearTimeout(this.refreshTimer)
    if (!this.visible) return
    this.refreshTimer = setTimeout(() => {
      if (this.data.cancelSheet || this.data.requestBusyMatchId || this.data.actionBusyId || this.data.refreshing) return this.scheduleRefresh()
      this.loadAppointments()
    }, this.data.joinRequestsState === 'error' || this.data.state === 'error'
      ? 30000 : Math.max(15000, Number(this.requestMatchCount || 0) * 1000))
  },

  onPullDownRefresh() {
    return this.refreshAppointments().finally(() => wx.stopPullDownRefresh())
  },

  async refreshAppointments() {
    if (this.manualRefresh) return this.manualRefresh
    if (this.data.requestBusyMatchId || this.data.actionBusyId || this.data.cancelBusy) return
    this.setData({ refreshing: true })
    const task = this.loadAppointments().then(() => this.joinRequestsLoading)
    this.manualRefresh = task
    try { await task } finally {
      if (this.manualRefresh === task) {
        this.manualRefresh = null
        this.setData({ refreshing: false })
      }
    }
  },

  async loadAppointments(event) {
    if (this.loading) return this.loading
    clearTimeout(this.refreshTimer)
    const run = (this.appointmentRun || 0) + 1
    this.appointmentRun = run
    this.joinRequestRun = (this.joinRequestRun || 0) + 1
    const hadReadyState = this.data.state === 'ready'
    this.setData(hadReadyState ? { errorMessage: '', syncError: '' } : { state: 'loading', errorMessage: '', syncError: '' })
    const task = (async () => {
      try {
        await getApp().ensureSession({ interactive: Boolean(event && event.currentTarget) })
        if (run !== this.appointmentRun) return
        const result = await api.appointments.list({ pageSize: 50 })
        if (run !== this.appointmentRun) return
        const allAppointments = (result.items || []).map((raw) => {
          const appointment = present.appointment(raw)
          appointment.canRebook = appointment.kind === 'match' && appointment.period === 'history'
          return appointment
        })
        this.setData(Object.assign({
          state: 'ready',
          syncError: '',
          allAppointments
        }, this.filteredState(allAppointments)))
        this.joinRequestsLoading = this.loadJoinRequests(allAppointments)
      } catch (error) {
        if (run !== this.appointmentRun) return
        if (hadReadyState) {
          this.setData({ syncError: errors.message(error) })
          if (this.data.refreshing) errors.toast(error, '刷新失败，请稍后重试')
        }
        else this.setData({ state: 'error', errorMessage: errors.message(error) })
        this.scheduleRefresh()
      }
    })()
    this.loading = task
    try {
      await task
    } finally {
      if (this.loading === task) this.loading = null
    }
  },

  changePeriod(event) {
    this.setData({ period: event.currentTarget.dataset.value }, () => this.applyFilters())
  },

  changeType(event) {
    this.setData({ type: event.currentTarget.dataset.value }, () => this.applyFilters())
  },

  applyFilters() {
    this.setData(this.filteredState(this.data.allAppointments))
  },

  filteredState(allAppointments) {
    const upcoming = this.data.period === 'upcoming'
    const periodAppointments = allAppointments.filter((item) => item.period === this.data.period).slice().sort((left, right) => {
      const leftTime = appointmentTimestamp(left)
      const rightTime = appointmentTimestamp(right)
      if (leftTime === null && rightTime === null) return 0
      if (leftTime === null) return 1
      if (rightTime === null) return -1
      return upcoming ? leftTime - rightTime : rightTime - leftTime
    })
    const appointments = periodAppointments.filter((item) => (
      item.period === this.data.period && (this.data.type === 'all' || item.kind === this.data.type)
    )).map((item, index) => Object.assign({}, item, {
      isNext: upcoming && index === 0
    }))
    const emptyByType = {
      all: {
        title: '还没有待开始的预约',
        copy: '找到合适的球局后可以直接加入，也可以预约教练时段。'
      },
      match: {
        title: '还没有待开始的球局',
        copy: '去首页看看附近正在约球的球友。'
      },
      coach: {
        title: '还没有待开始的教练课',
        copy: '去首页选择教练和合适的可约时段。'
      }
    }
    const empty = emptyByType[this.data.type] || emptyByType.all
    const counts = periodAppointments.reduce((value, item) => {
      value.all += 1
      if (value[item.kind] !== undefined) value[item.kind] += 1
      return value
    }, { all: 0, match: 0, coach: 0 })
    return {
      appointments,
      typeOptions: TYPE_OPTIONS.map((item) => Object.assign({}, item, { count: counts[item.value] || 0 })),
      emptyTitle: upcoming ? empty.title : '还没有历史预约',
      emptyCopy: upcoming ? empty.copy : '完成或取消的预约会保留在这里。',
      emptyActionText: this.data.type === 'match' ? '去找球局' : this.data.type === 'coach' ? '去看看教练' : '去首页看看'
    }
  },

  async loadJoinRequests(allAppointments = this.data.allAppointments) {
    clearTimeout(this.refreshTimer)
    const requestRun = (this.joinRequestRun || 0) + 1
    this.joinRequestRun = requestRun
    const hostMatches = allAppointments.filter((item) => (
      item.canReviewRequests
    ))
    this.requestMatchCount = hostMatches.length
    this.setData({ hasHostMatches: hostMatches.length > 0 })
    if (!hostMatches.length) {
      if (requestRun === this.joinRequestRun) this.setData({ joinRequests: [], joinRequestsState: 'ready', joinRequestsError: '' })
      this.updateRequestBadge(0)
      this.scheduleRefresh()
      return
    }

    const previousRequests = this.data.joinRequests
    this.setData({ joinRequestsState: 'loading', joinRequestsError: '' })
    const results = []
    let serviceError = null
    // Each API call updates the same user's rate-limit bucket. Avoid a burst
    // of concurrent transactions, and stop obsolete refreshes between calls.
    for (const item of hostMatches) {
      if (requestRun !== this.joinRequestRun) return
      try {
        if (serviceError) throw serviceError
        const pending = await api.matches.pending({ matchId: item.matchId })
        results.push({
          ok: true,
          matchId: item.matchId,
          items: (pending.items || []).map((request) => ({
            id: request.membershipId,
            membershipId: request.membershipId,
            matchId: item.matchId,
            matchVersion: pending.matchVersion || item.version,
            matchTitle: item.title,
            scheduleText: item.scheduleText,
            applicantName: request.player && request.player.displayName || '球友',
            ballAge: request.player && request.player.ballAge || '未填写球龄',
            skillsText: request.player && request.player.skills && request.player.skills.length ? ` · ${request.player.skills.join('、')}` : '',
            status: request.status,
            statusLabel: request.status === 'waitlisted' ? '候补申请' : '待确认',
            busy: false,
            busyAction: '',
            stale: false
          }))
        })
      } catch (error) {
        results.push({ ok: false, matchId: item.matchId, items: [], error })
        if (['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE', 'RATE_LIMITED'].includes(error.code)) serviceError = error
      }
      if (requestRun !== this.joinRequestRun) return
      // Show the first received applications immediately; a slow later match
      // must not hide an already loaded request behind the whole queue.
      this.renderJoinRequests(results, previousRequests, hostMatches, false)
    }
    if (requestRun !== this.joinRequestRun) return
    this.renderJoinRequests(results, previousRequests, hostMatches, true)
    this.scheduleRefresh()
  },

  renderJoinRequests(results, previousRequests, hostMatches, complete) {
    const failedMatchIds = results.filter((result) => !result.ok).map((result) => result.matchId)
    const finishedMatchIds = new Set(results.map((result) => result.matchId))
    const unknownMatchIds = failedMatchIds.concat(hostMatches.filter((item) => !finishedMatchIds.has(item.matchId)).map((item) => item.matchId))
    const freshRequests = results.filter((result) => result.ok).flatMap((result) => result.items)
    const preservedRequests = previousRequests.filter((request) => unknownMatchIds.includes(request.matchId)).map((request) => (
      Object.assign({}, request, { busy: false, busyAction: '', stale: true })
    ))
    this.setData({
      joinRequests: freshRequests.concat(preservedRequests),
      joinRequestsState: complete ? failedMatchIds.length ? 'error' : 'ready' : 'loading',
      joinRequestsError: failedMatchIds.length ? errors.message(results.find((result) => !result.ok).error) : ''
    })
    if (complete && !failedMatchIds.length) this.updateRequestBadge(freshRequests.length)
  },

  retryJoinRequests() {
    return this.refreshAppointments()
  },

  updateRequestBadge(count) {
    if (count && wx.setTabBarBadge) wx.setTabBarBadge({ index: 2, text: count > 99 ? '99+' : String(count), fail() {} })
    else if (!count && wx.removeTabBarBadge) wx.removeTabBarBadge({ index: 2, fail() {} })
  },

  showJoinRequests() {
    this.setData({ period: 'upcoming', type: 'all' }, () => this.applyFilters())
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },

  setRequestBusy(id, busy, busyAction = '') {
    this.setData({
      joinRequests: this.data.joinRequests.map((item) => (
        item.id === id ? Object.assign({}, item, { busy, busyAction: busy ? busyAction : '' }) : item
      ))
    })
  },

  approveRequest(event) {
    return this.respondRequest(event.currentTarget.dataset.id, 'accept')
  },

  rejectRequest(event) {
    const id = event.currentTarget.dataset.id
    const request = this.data.joinRequests.find((item) => item.id === id)
    if (!request || request.busy || request.stale || this.data.requestBusyMatchId) return
    wx.showModal({
      title: '拒绝加入申请？',
      content: `将拒绝${request.applicantName}加入这场球局。`,
      confirmText: '确认拒绝',
      confirmColor: '#a9483d',
      success: (result) => {
        if (result.confirm) this.respondRequest(id, 'reject')
      }
    })
  },

  async respondRequest(id, decision) {
    const request = this.data.joinRequests.find((item) => item.id === id)
    if (!request || request.busy || request.stale || this.data.requestBusyMatchId) return
    // Keep one request id until the server outcome is known. A timeout must
    // never turn a retry into a second, contradictory review decision.
    this.reviewAttempts = this.reviewAttempts || {}
    const previous = this.reviewAttempts[id]
    if (previous && previous.decision !== decision) {
      return wx.showToast({ title: '结果待确认，请重试上次操作', icon: 'none' })
    }
    const attempt = previous || { decision, requestId: api.createRequestId(), version: request.matchVersion }
    this.reviewAttempts[id] = attempt
    clearTimeout(this.refreshTimer)
    this.appointmentRun = (this.appointmentRun || 0) + 1
    this.loading = null
    this.joinRequestRun = (this.joinRequestRun || 0) + 1
    this.joinRequestsLoading = null
    this.setData({ requestBusyMatchId: request.matchId })
    this.setRequestBusy(id, true, decision)
    try {
      await api.matches.respondJoin({
        matchId: request.matchId,
        membershipId: request.membershipId,
        decision,
        expectedVersion: attempt.version
      }, { requestId: attempt.requestId })
      delete this.reviewAttempts[id]
      if (this.visible !== false) wx.showToast({ title: decision === 'accept' ? '已同意加入' : '已拒绝申请', icon: 'none' })
      this.setData({
        joinRequests: this.data.joinRequests.filter((item) => item.id !== id),
        requestBusyMatchId: ''
      })
      if (this.visible !== false) {
        await this.loadAppointments()
        await this.joinRequestsLoading
      }
    } catch (error) {
      const uncertain = Boolean(error.details && error.details.outcomeUnknown) || ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INTERNAL'].includes(error.code)
      if (!uncertain) delete this.reviewAttempts[id]
      this.setRequestBusy(id, false)
      this.setData({ requestBusyMatchId: '' })
      if (this.visible === false) return
      errors.toast(error)
      if (['VERSION_CONFLICT', 'INVALID_STATE', 'MATCH_FULL', 'MATCH_CLOSED'].includes(error.code) || uncertain) {
        await this.loadAppointments()
        await this.joinRequestsLoading
      }
    } finally {
      this.scheduleRefresh()
    }
  },

  openAppointment(event) {
    const item = this.data.allAppointments.find((row) => row.id === event.currentTarget.dataset.id)
    if (!item) return
    if (item.kind === 'match') wx.navigateTo({ url: `/pages/match-detail/match-detail?id=${item.matchId}` })
    else if (item.raw.booking && item.raw.booking.coachId) wx.navigateTo({ url: `/pages/coach-detail/coach-detail?id=${item.raw.booking.coachId}` })
  },

  openChat(event) {
    const matchId = event.currentTarget.dataset.matchId
    if (matchId) wx.navigateTo({ url: `/pages/chat/chat?id=${matchId}` })
  },

  openRebook(event) {
    const item = this.data.allAppointments.find((row) => row.id === event.currentTarget.dataset.id)
    if (!item || !item.canRebook || !item.raw || !item.raw.match) return
    const continueToPublish = () => {
      const prefill = clientState.setRebookPrefill(item.raw.match)
      if (!prefill) {
        wx.showToast({ title: '暂时无法准备发布内容，请稍后重试', icon: 'none' })
        return
      }
      wx.switchTab({ url: '/pages/publish/publish' })
    }
    if (!clientState.hasPublishDraft()) {
      continueToPublish()
      return
    }
    wx.showModal({
      title: '替换发布草稿？',
      content: '发布页里还有未提交的内容。继续后会用这场球局的设置替换它，原草稿不会保留。',
      confirmText: '替换并继续',
      cancelText: '保留草稿',
      success: (result) => {
        if (result.confirm) continueToPublish()
      }
    })
  },

  async confirmSchedule(event) {
    const matchId = event.currentTarget.dataset.matchId
    if (!matchId || this.data.actionBusyId || this.data.requestBusyMatchId === matchId) return
    this.setData({ actionBusyId: matchId })
    try {
      await api.matches.confirmSchedule({ matchId })
      wx.showToast({ title: '新时间已确认', icon: 'success' })
      await this.loadAppointments()
    } catch (error) {
      errors.toast(error)
    } finally {
      this.setData({ actionBusyId: '' })
    }
  },

  openCancel(event) {
    const selectedAppointment = this.data.allAppointments.find((item) => item.id === event.currentTarget.dataset.id)
    if (!selectedAppointment || this.data.actionBusyId === selectedAppointment.matchId || this.data.requestBusyMatchId === selectedAppointment.matchId) return
    this.cancelRequestId = ''
    this.setData({ cancelSheet: true, selectedAppointment, cancelReasonIndex: 0 })
  },

  closeCancel() {
    if (!this.data.cancelBusy) this.setData({ cancelSheet: false, selectedAppointment: null })
  },

  changeCancelReason(event) {
    this.cancelRequestId = ''
    this.setData({ cancelReasonIndex: Number(event.detail.value) })
  },

  async confirmCancel() {
    const item = this.data.selectedAppointment
    if (!item || this.data.cancelBusy) return
    this.setData({ cancelBusy: true })
    this.cancelRequestId = this.cancelRequestId || api.createRequestId()
    const reason = this.data.cancelReasons[this.data.cancelReasonIndex]
    try {
      if (item.kind === 'match') {
        await api.matches.cancel({ matchId: item.matchId, expectedVersion: item.version, reason }, { requestId: this.cancelRequestId })
      } else {
        await api.coachBookings.cancel({ bookingId: item.resourceId, expectedVersion: item.version, reason }, { requestId: this.cancelRequestId })
      }
      wx.showToast({ title: '预约已取消', icon: 'success' })
      const allAppointments = this.data.allAppointments.filter((appointment) => appointment.id !== item.id)
      this.setData(Object.assign({
        cancelBusy: false,
        cancelSheet: false,
        selectedAppointment: null,
        allAppointments
      }, this.filteredState(allAppointments)))
      this.cancelRequestId = ''
      await this.loadAppointments()
    } catch (error) {
      this.setData({ cancelBusy: false })
      errors.toast(error)
    }
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' })
  },

  noop() {}
})
