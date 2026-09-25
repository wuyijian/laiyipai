const api = require('../../utils/api')
const dateUtil = require('../../utils/date')
const present = require('../../utils/present')
const errors = require('../../utils/error')
const cloudConfig = require('../../utils/cloud-config')
const share = require('../../utils/share')

Page({
  data: {
    id: '',
    state: 'loading',
    notFound: false,
    errorMessage: '',
    coach: null,
    slots: [],
    dateOptions: [],
    selectedDate: '',
    visibleSlots: [],
    selectedSlotId: '',
    selectedSlot: null,
    bookingSheet: false,
    booking: false,
    bookingError: '',
    loggedIn: false
  },

  onLoad(options) {
    share.disable()
    this.setData({ id: options && options.id || '' })
  },

  async onShow() {
    const pending = this.pendingBookingIntent
    const loggedIn = this.hasActiveSession()
    if (pending && !loggedIn) this.clearPendingBookingIntent()
    const loaded = await this.loadCoach({ force: Boolean(pending && loggedIn) })
    if (pending && loggedIn && this.pendingBookingIntent === pending) {
      this.restorePendingBookingIntent(pending, loaded)
    }
    return loaded
  },

  onPullDownRefresh() {
    this.loadCoach().finally(() => wx.stopPullDownRefresh())
  },

  async loadCoach(event = {}) {
    if (!this.data.id) {
      share.disable()
      this.setData({ state: 'error', notFound: true, errorMessage: '缺少教练编号' })
      return false
    }
    if (this.loading && !event.force) return this.loading
    const requestSequence = Number(this.loadRequestSequence || 0) + 1
    this.loadRequestSequence = requestSequence
    this.latestLoadRequestSequence = requestSequence
    const isStale = () => requestSequence !== this.latestLoadRequestSequence
    const hadReadyState = this.data.state === 'ready'
    share.disable()
    this.setData(hadReadyState ? { errorMessage: '', notFound: false } : { state: 'loading', errorMessage: '', notFound: false })
    const task = (async () => {
      try {
        const app = getApp()
        const session = app.globalData && app.globalData.session
        const loggedIn = Boolean(session)
        const readOptions = { publicRead: !loggedIn }
        const result = await api.coaches.get({ coachId: this.data.id }, readOptions)
        if (isStale()) return false
        const rawCoach = result.coach || result
        const rawSlots = result.slots || rawCoach.nextSlots || []
        const venueIds = Array.from(new Set((rawCoach.venueIds || []).concat(rawSlots.map((item) => item.venueId)).filter(Boolean)))
        const avatarPromise = this.resolveFiles(rawCoach.avatarFileId ? [rawCoach.avatarFileId] : [], readOptions)
        const venues = await Promise.all(venueIds.map(async (venueId) => {
          try { return await api.venues.get({ venueId }, readOptions) } catch (_) { return null }
        }))
        const venueMap = {}
        venues.filter(Boolean).forEach((item) => { venueMap[item.id] = present.venue(item) })
        const urls = await avatarPromise
        if (isStale()) return false
        const slots = rawSlots.map((item) => {
          const value = present.slot(item)
          return Object.assign(value, { venueName: venueMap[item.venueId] && venueMap[item.venueId].name || '球馆资料待加载' })
        }).sort((left, right) => present.jsDate(left.startAt) - present.jsDate(right.startAt))
        const firstSlot = slots[0]
        const selectedSlot = slots.find((item) => item.id === this.data.selectedSlotId) || null
        if (!selectedSlot) this.bookingRequestId = ''
        const sessionPolicies = session && session.policies || {}
        const coach = Object.assign(present.coach(Object.assign({}, rawCoach, { nextSlots: slots }), venueMap), {
          avatarUrl: urls[rawCoach.avatarFileId] || '',
          bio: rawCoach.introduction || '',
          experienceYearsText: rawCoach.experienceYears ? `${rawCoach.experienceYears} 年` : '未提供',
          courtFeeNotice: rawCoach.courtFeeNotice || '以球馆实际收费为准',
          cancelPolicyText: rawCoach.cancelPolicyText || `开课前 ${sessionPolicies.coachCancellationHours || 12} 小时可在线取消`
        })
        const venueSlot = selectedSlot || firstSlot
        coach.venueId = venueSlot && venueSlot.venueId || rawCoach.venueIds && rawCoach.venueIds[0] || ''
        if (coach.venueId) coach.venueName = venueMap[coach.venueId] && venueMap[coach.venueId].name || '球馆资料待加载'
        const availableDates = Array.from(new Set(slots.map((item) => item.date)))
        const dateOptions = availableDates.length
          ? availableDates.map(dateUtil.dateTab).filter(Boolean)
          : dateUtil.dateTabs(14).slice(1)
        const selectedDate = selectedSlot ? selectedSlot.date : firstSlot ? firstSlot.date : dateUtil.today()
        this.setData({
          state: 'ready',
          coach,
          slots,
          dateOptions,
          selectedDate,
          selectedSlotId: selectedSlot ? selectedSlot.id : '',
          selectedSlot,
          loggedIn,
          bookingSheet: selectedSlot ? this.data.bookingSheet : false,
          bookingError: ''
        }, () => this.applyDate())
        share.enable()
        return true
      } catch (error) {
        if (isStale()) return false
        if (hadReadyState && error && error.code !== 'NOT_FOUND' && error.code !== 'FORBIDDEN') {
          share.enable()
          errors.toast(error, '暂时无法更新，请稍后重试')
        } else {
          share.disable()
          this.setData({ state: 'error', bookingSheet: false, selectedSlot: null, selectedSlotId: '', notFound: error && error.code === 'NOT_FOUND', errorMessage: errors.message(error) })
        }
        return false
      }
    })()
    this.loading = task
    try {
      return await task
    } finally {
      if (this.loading === task) this.loading = null
    }
  },

  async resolveFiles(fileIds, options = { publicRead: !this.data.loggedIn }) {
    if (!fileIds.length || !api.files || !api.files.resolve) return {}
    try {
      const result = await api.files.resolve(fileIds, options)
      return result.urls || {}
    } catch (_) {
      return {}
    }
  },

  selectDate(event) {
    if (this.data.booking || event.currentTarget.dataset.value === this.data.selectedDate) return
    this.bookingRequestId = ''
    this.setData({ selectedDate: event.currentTarget.dataset.value, selectedSlotId: '', selectedSlot: null }, () => this.applyDate())
  },

  applyDate() {
    this.setData({ visibleSlots: this.data.slots.filter((item) => item.date === this.data.selectedDate) })
  },

  selectSlot(event) {
    if (this.data.booking) return
    const selectedSlotId = event.currentTarget.dataset.id
    if (selectedSlotId !== this.data.selectedSlotId) this.bookingRequestId = ''
    const selectedSlot = this.data.slots.find((item) => item.id === selectedSlotId) || null
    const patch = { selectedSlotId, selectedSlot, bookingError: '' }
    if (selectedSlot) {
      patch['coach.venueName'] = selectedSlot.venueName || '球馆资料待加载'
      patch['coach.venueId'] = selectedSlot.venueId || ''
    }
    this.setData(patch)
  },

  async openBooking() {
    if (!this.data.selectedSlot) return
    if (this.data.loggedIn && this.hasActiveSession()) {
      this.setData({ loggedIn: true, bookingSheet: true, bookingError: '' })
      return
    }
    const intent = { coachId: this.data.id, slotId: this.data.selectedSlot.id }
    this.pendingBookingIntent = intent
    if (!(await this.ensureInteractiveSession())) {
      if (this.lastInteractiveSessionError !== 'LOGIN_REQUIRED') this.clearPendingBookingIntent()
      return
    }
    const loaded = await this.loadCoach({ force: true })
    this.restorePendingBookingIntent(intent, loaded)
  },

  hasActiveSession() {
    const app = getApp()
    return Boolean(app.globalData && app.globalData.session)
  },

  clearPendingBookingIntent() {
    this.pendingBookingIntent = null
    if (this.data.bookingSheet) this.setData({ bookingSheet: false, bookingError: '' })
  },

  restorePendingBookingIntent(intent, loaded) {
    if (!intent || this.pendingBookingIntent !== intent) return false
    this.pendingBookingIntent = null
    const selectedSlot = this.data.slots.find((item) => item.id === intent.slotId) || null
    const available = loaded === true && this.data.state === 'ready' &&
      intent.coachId === this.data.id && selectedSlot && Number(selectedSlot.remaining || 0) > 0
    if (!available) {
      this.setData({ bookingSheet: false, bookingError: '' })
      wx.showToast({ title: '该时段已不可约，请重新选择', icon: 'none' })
      return false
    }
    this.setData({
      selectedDate: selectedSlot.date,
      selectedSlotId: selectedSlot.id,
      selectedSlot,
      bookingSheet: true,
      bookingError: ''
    }, () => this.applyDate())
    return true
  },

  async ensureInteractiveSession() {
    if (this.data.loggedIn && getApp().globalData && getApp().globalData.session) return true
    this.lastInteractiveSessionError = ''
    try {
      await getApp().ensureSession({ interactive: true })
      this.setData({ loggedIn: true })
      return true
    } catch (error) {
      this.lastInteractiveSessionError = error && error.code || 'UNKNOWN'
      if (error && error.code !== 'LOGIN_REQUIRED') errors.toast(error, '暂时无法登录，请稍后重试')
      return false
    }
  },

  closeBooking() {
    if (!this.data.booking) {
      this.pendingBookingIntent = null
      this.setData({ bookingSheet: false, bookingError: '' })
    }
  },

  async confirmBooking() {
    if (!this.data.selectedSlot || this.data.booking) return
    if (!(await this.ensureInteractiveSession())) return
    this.setData({ booking: true, bookingError: '' })
    this.bookingRequestId = this.bookingRequestId || api.createRequestId()
    try {
      await api.coachBookings.create({
        slotId: this.data.selectedSlot.id,
        note: '',
        termsAccepted: true,
        termsVersion: cloudConfig.termsVersion
      }, { requestId: this.bookingRequestId })
      this.bookingRequestId = ''
      this.setData({ booking: false, bookingSheet: false })
      wx.showModal({
        title: '预约已确认',
        content: '课时费和场地费按预约说明到店结算。',
        showCancel: false,
        confirmText: '查看预约',
        success: () => wx.switchTab({ url: '/pages/orders/orders' })
      })
    } catch (error) {
      this.setData({ booking: false, bookingError: errors.message(error) })
    }
  },

  noop() {},

  openTerms() {
    wx.navigateTo({ url: '/pages/settings/settings?section=terms' })
  },

  openVenue() {
    const venueId = this.data.coach && this.data.coach.venueId
    if (!venueId) return wx.showToast({ title: '球馆资料暂不可用', icon: 'none' })
    wx.navigateTo({ url: `/pages/venue-detail/venue-detail?id=${venueId}` })
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' })
  },

  onShareAppMessage() {
    const coach = this.data.coach
    return share.appMessage({
      title: coach ? `${coach.displayName} · ${coach.specialtyText}｜搭拍子` : '杭州乒乓球教练｜搭拍子',
      path: `/pages/coach-detail/coach-detail?id=${encodeURIComponent(this.data.id)}`,
      imageUrl: coach && coach.avatarUrl
    })
  },

  onShareTimeline() {
    const coach = this.data.coach
    return share.timeline({
      title: coach ? `${coach.displayName} · ${coach.specialtyText}｜搭拍子` : '杭州乒乓球教练｜搭拍子',
      params: { id: this.data.id },
      imageUrl: coach && coach.avatarUrl
    })
  }
})
