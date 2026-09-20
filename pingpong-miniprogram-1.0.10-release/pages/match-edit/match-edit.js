const api = require('../../utils/api')
const dateUtil = require('../../utils/date')
const errors = require('../../utils/error')
const present = require('../../utils/present')
const matchOptions = require('../../utils/match-options')

const BALL_AGES = ['不限球龄', '新手友好', '球龄 1 年以内', '球龄 2—5 年', '球龄 5 年以上']
const INTENTS = matchOptions.PRACTICE_INTENTS.map((value) => ({ value }))

Page({
  data: {
    id: '', state: 'loading', errorMessage: '', saving: false, saveError: '', dirty: false,
    venues: [], venueNames: [], visibleVenues: [], venueIndex: 0, venueId: '', minimumDate: '',
    currentVenueUnavailable: false, selectedVenueUnavailable: false, arrangementChanged: false, courtResetNotice: '',
    title: '', note: '', noteLength: 0,
    date: '', startTime: '', endTime: '', capacity: 2, participantCount: 1,
    expectedBallAge: BALL_AGES[0], ballAges: BALL_AGES, ballAgeIndex: 0,
    practiceIntent: matchOptions.DEFAULT_PRACTICE_INTENT, intents: INTENTS,
    joinMode: 'direct', courtStatus: 'unbooked', feePerPerson: '',
    venueSearch: '', venueSearching: false, venueSearched: false, venueSearchError: '',
    version: 1
  },

  onLoad(options = {}) {
    this.setData({ id: options.id || '', minimumDate: dateUtil.today() })
    this.load()
  },

  onUnload() {
    this.destroyed = true
    this.venueSearchRun = Number(this.venueSearchRun || 0) + 1
    if (this.navigateTimer) clearTimeout(this.navigateTimer)
    this.navigateTimer = null
  },

  formValues() {
    return {
      title: String(this.data.title || '').trim(),
      note: String(this.data.note || '').trim(),
      venueId: this.data.venueId,
      date: this.data.date,
      startTime: this.data.startTime,
      endTime: this.data.endTime,
      capacity: Number(this.data.capacity),
      expectedBallAge: this.data.expectedBallAge,
      practiceIntent: this.data.practiceIntent,
      joinMode: Number(this.data.capacity) === 1 ? 'direct' : this.data.joinMode,
      courtStatus: this.data.courtStatus,
      feePerPerson: this.data.feePerPerson === '' ? 0 : Number(this.data.feePerPerson)
    }
  },

  refreshDirty() {
    const dirty = Boolean(this.originalForm && JSON.stringify(this.formValues()) !== JSON.stringify(this.originalForm))
    if (dirty !== this.data.dirty) this.setData({ dirty })
  },

  async load() {
    if (!this.data.id || this.loading) return this.loading
    this.setData({ state: 'loading', errorMessage: '' })
    this.loading = (async () => {
      try {
        await getApp().ensureSession({ interactive: true })
        const [matchResult, venueResult] = await Promise.all([
          api.matches.get({ matchId: this.data.id }),
          api.venues.list({ city: '杭州', page: 1, pageSize: 50 })
        ])
        if (!matchResult.membership || matchResult.membership.status !== 'host') {
          throw Object.assign(new Error('仅发起人可编辑球局'), { code: 'FORBIDDEN' })
        }
        const match = present.match(matchResult.match)
        const startAt = present.jsDate(match.startAt)
        if (!startAt || startAt.getTime() <= Date.now() || ['started', 'cancelled', 'completed'].includes(match.status)) {
          throw Object.assign(new Error('球局已开始或结束，无法修改'), { code: 'MATCH_CLOSED' })
        }
        let venues = (venueResult.items || []).map(present.venue)
        let currentVenueUnavailable = false
        if (!venues.some((item) => item.id === match.venueId)) {
          const activeVenue = await api.venues.get({ venueId: match.venueId }).catch(() => null)
          if (activeVenue) {
            venues.unshift(present.venue(activeVenue))
          } else {
            currentVenueUnavailable = true
            venues.unshift({
              id: match.venueId,
              name: match.venueName || '原球馆',
              locationText: match.venueLocationText || '',
              unavailable: true,
              current: true
            })
          }
        }
        const venueIndex = Math.max(0, venues.findIndex((item) => item.id === match.venueId))
        const ballAgeIndex = Math.max(0, BALL_AGES.indexOf(match.expectedBallAge))
        if (this.destroyed) return
        this.allVenues = venues
        this.originalArrangement = {
          venueId: match.venueId,
          date: match.date,
          startTime: match.startTime,
          endTime: match.endTime
        }
        this.originalCourtStatus = match.courtStatus
        const patch = {
          state: 'ready', venues, venueNames: venues.map((item) => item.name), venueIndex,
          venueId: match.venueId, currentVenueUnavailable, selectedVenueUnavailable: currentVenueUnavailable,
          title: match.title || '', note: match.note || '', noteLength: String(match.note || '').length,
          date: match.date, startTime: match.startTime, endTime: match.endTime,
          capacity: match.capacity, participantCount: match.participantCount,
          expectedBallAge: BALL_AGES[ballAgeIndex], ballAgeIndex,
          practiceIntent: match.practiceIntent, joinMode: match.capacity === 1 ? 'direct' : match.joinMode,
          courtStatus: match.courtStatus, feePerPerson: match.feePerPerson ? String(match.feePerPerson) : '',
          arrangementChanged: false, courtResetNotice: '', version: match.version, dirty: false
        }
        this.setData(patch, () => {
          this.originalForm = this.formValues()
          this.refreshDirty()
        })
      } catch (error) {
        if (this.destroyed) return
        this.setData({ state: 'error', errorMessage: errors.message(error, '球局资料暂时无法加载') })
      }
    })()
    try { await this.loading } finally { this.loading = null }
  },

  changed() {
    this.updateRequestId = ''
    this.setData({ saveError: '' })
    this.refreshDirty()
  },

  changeNumeric(event) {
    this.setData({ feePerPerson: String(event.detail.value || '').replace(/\D/g, '').slice(0, 3) }, () => this.changed())
  },

  changeText(event) {
    const field = event.currentTarget.dataset.field
    const value = String(event.detail.value || '')
    const patch = { [field]: value }
    if (field === 'note') patch.noteLength = value.length
    this.setData(patch, () => this.changed())
  },

  applyArrangementPatch(patch) {
    const next = Object.assign({
      venueId: this.data.venueId,
      date: this.data.date,
      startTime: this.data.startTime,
      endTime: this.data.endTime
    }, patch)
    const original = this.originalArrangement || next
    const arrangementChanged = next.venueId !== original.venueId || next.date !== original.date ||
      next.startTime !== original.startTime || next.endTime !== original.endTime
    if (arrangementChanged && !this.data.arrangementChanged) this.courtStatusBeforeArrangement = this.data.courtStatus
    if (arrangementChanged) patch.courtStatus = 'unbooked'
    if (!arrangementChanged && this.data.arrangementChanged) {
      patch.courtStatus = this.courtStatusBeforeArrangement || this.originalCourtStatus || 'unbooked'
      this.courtStatusBeforeArrangement = ''
    }
    patch.arrangementChanged = arrangementChanged
    patch.courtResetNotice = arrangementChanged ? '时间或球馆有变化，原订台状态将重置；保存后请重新确认球台。' : ''
    this.setData(patch, () => this.changed())
  },

  changeDate(event) { this.applyArrangementPatch({ date: event.detail.value }) },
  changeStart(event) { this.applyArrangementPatch({ startTime: event.detail.value }) },
  changeEnd(event) { this.applyArrangementPatch({ endTime: event.detail.value }) },

  changeVenue(event) {
    const venueIndex = Number(event.detail.value)
    const venue = this.data.venues[venueIndex]
    if (!venue) return
    if (venue.unavailable && venue.id !== this.data.venueId) {
      return wx.showToast({ title: '该球馆已下架，请选择其他球馆', icon: 'none' })
    }
    this.applyArrangementPatch({ venueIndex, venueId: venue.id, selectedVenueUnavailable: Boolean(venue.unavailable) })
  },

  selectVenueResult(event) {
    const venueId = event.currentTarget.dataset.id
    const venueIndex = this.data.venues.findIndex((item) => item.id === venueId)
    if (venueIndex < 0) return
    const selectedVenue = this.data.venues[venueIndex]
    if (selectedVenue.unavailable && selectedVenue.id !== this.data.venueId) {
      return wx.showToast({ title: '该球馆已下架，请选择其他球馆', icon: 'none' })
    }
    const allVenues = this.allVenues || []
    if (!allVenues.some((item) => item.id === venueId)) this.allVenues = [selectedVenue].concat(allVenues)
    this.applyArrangementPatch({ venueId, venueIndex, selectedVenueUnavailable: Boolean(selectedVenue.unavailable), venueSearch: '', venueSearched: false, venueSearchError: '' })
    this.applyVenueSearch()
  },

  applyVenueSearch() {
    const query = String(this.data.venueSearch || '').trim().toLowerCase()
    const local = this.allVenues || []
    const matched = query
      ? local.filter((item) => `${item.name || ''} ${item.address || ''}`.toLowerCase().includes(query))
      : local.slice()
    const seen = new Set(matched.map((item) => item.id))
    const venues = query
      ? matched.concat((this.searchedVenues || []).filter((item) => item.id && !seen.has(item.id)))
      : matched
    const selectedVenue = venues.find((item) => item.id === this.data.venueId)
    this.setData({
      venues,
      venueNames: venues.map((item) => item.unavailable ? `${item.name}（已下架）` : item.name),
      visibleVenues: venues.slice(0, 6),
      venueIndex: Math.max(0, venues.findIndex((item) => item.id === this.data.venueId)),
      selectedVenueUnavailable: Boolean(selectedVenue && selectedVenue.unavailable)
    })
  },

  inputVenueSearch(event) {
    this.searchedVenues = []
    this.venueSearchRun = Number(this.venueSearchRun || 0) + 1
    this.setData({ venueSearch: event.detail.value, venueSearching: false, venueSearched: false, venueSearchError: '' }, () => this.applyVenueSearch())
  },

  async searchVenues() {
    const keyword = String(this.data.venueSearch || '').trim().slice(0, 30)
    if (!keyword) {
      this.searchedVenues = []
      return this.setData({ venueSearched: false, venueSearchError: '' }, () => this.applyVenueSearch())
    }
    if (this.data.venueSearching) return
    const run = Number(this.venueSearchRun || 0) + 1
    this.venueSearchRun = run
    this.setData({ venueSearching: true, venueSearchError: '' })
    try {
      const result = await api.venues.list({ city: '杭州', keyword, page: 1, pageSize: 50 })
      if (run !== this.venueSearchRun || this.destroyed) return
      this.searchedVenues = (result.items || []).map(present.venue).filter((item) => item.id)
      this.setData({ venueSearching: false, venueSearched: true }, () => this.applyVenueSearch())
    } catch (failure) {
      if (run !== this.venueSearchRun || this.destroyed) return
      this.setData({
        venueSearching: false,
        venueSearched: true,
        venueSearchError: errors.message(failure, '球馆搜索暂时不可用，请重试')
      })
    }
  },

  changeBallAge(event) {
    const ballAgeIndex = Number(event.detail.value)
    this.setData({ ballAgeIndex, expectedBallAge: BALL_AGES[ballAgeIndex] }, () => this.changed())
  },

  changeCapacity(event) {
    const capacity = Math.max(this.data.participantCount, Math.min(8, Number(event.detail.value || 2)))
    this.setData({ capacity, joinMode: capacity === 1 ? 'direct' : this.data.joinMode }, () => this.changed())
  },

  selectIntent(event) { this.setData({ practiceIntent: event.currentTarget.dataset.value }, () => this.changed()) },
  selectJoinMode(event) { if (this.data.capacity > 1) this.setData({ joinMode: event.currentTarget.dataset.value }, () => this.changed()) },
  selectCourtStatus(event) {
    if (this.data.arrangementChanged) return wx.showToast({ title: '保存后再确认新的订台状态', icon: 'none' })
    this.setData({ courtStatus: event.currentTarget.dataset.value }, () => this.changed())
  },

  validate() {
    if (!this.data.venueId) return '请选择球馆'
    if (this.data.title.trim().length < 2) return '球局名称至少需要 2 个字'
    const scheduleChanged = Boolean(this.data.arrangementChanged && (
      this.data.date !== this.originalArrangement.date ||
      this.data.startTime !== this.originalArrangement.startTime ||
      this.data.endTime !== this.originalArrangement.endTime
    ))
    if (scheduleChanged && !dateUtil.isFutureSchedule(this.data.date, this.data.startTime, 10)) return '新的开始时间至少应晚于当前时间 10 分钟'
    const start = new Date(`${this.data.date}T${this.data.startTime}:00+08:00`).getTime()
    const end = new Date(`${this.data.date}T${this.data.endTime}:00+08:00`).getTime()
    const duration = end - start
    if (!Number.isFinite(duration) || duration < 30 * 60000 || duration > 6 * 60 * 60000) return '球局时长需在 30 分钟到 6 小时之间'
    if (this.data.capacity < this.data.participantCount) return `当前已有 ${this.data.participantCount} 人，不能再减少总人数`
    const fee = this.data.feePerPerson === '' ? 0 : Number(this.data.feePerPerson)
    if (!Number.isInteger(fee) || fee < 0 || fee > 999) return '人均费用请输入 0—999 元'
    return ''
  },

  async save() {
    if (this.data.saving) return
    if (!this.data.dirty) return wx.showToast({ title: '没有需要保存的修改', icon: 'none' })
    const validationError = this.validate()
    if (validationError) return this.setData({ saveError: validationError })
    this.updateRequestId = this.updateRequestId || api.createRequestId()
    this.setData({ saving: true, saveError: '' })
    try {
      const result = await api.matches.update(Object.assign({
        matchId: this.data.id,
        expectedVersion: this.data.version
      }, this.formValues()), { requestId: this.updateRequestId, retry: true })
      this.updateRequestId = ''
      if (this.destroyed) return
      this.setData({ saving: false })
      wx.showToast({ title: result && result.noop ? '内容没有变化' : '球局已更新', icon: result && result.noop ? 'none' : 'success' })
      if (result && result.noop) return
      this.navigateTimer = setTimeout(() => {
        this.navigateTimer = null
        if (!this.destroyed) wx.navigateBack()
      }, 450)
    } catch (error) {
      if (this.destroyed) return
      if (error && error.code === 'VERSION_CONFLICT') return this.recoverFromConflict()
      this.setData({ saving: false, saveError: errors.message(error, '保存失败，请重试') })
    }
  },

  async recoverFromConflict() {
    this.updateRequestId = ''
    try {
      const result = await api.matches.get({ matchId: this.data.id })
      if (this.destroyed) return
      const match = present.match(result.match)
      const startAt = present.jsDate(match.startAt)
      if (!result.membership || result.membership.status !== 'host' || !startAt || startAt.getTime() <= Date.now()) {
        return this.setData({ saving: false, state: 'error', errorMessage: '球局已经开始或你已没有编辑权限' })
      }
      this.setData({
        saving: false,
        version: match.version,
        participantCount: match.participantCount,
        capacity: Math.max(this.data.capacity, match.participantCount),
        saveError: '球局刚刚被更新过，请确认下面的内容后重新保存'
      }, () => this.refreshDirty())
    } catch (error) {
      if (this.destroyed) return
      this.setData({ saving: false, saveError: errors.message(error, '球局已被更新，请返回后重新进入编辑') })
    }
  }
})
