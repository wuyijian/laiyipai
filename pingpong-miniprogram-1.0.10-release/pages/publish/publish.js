const api = require('../../utils/api')
const clientState = require('../../utils/client-state')
const cloudConfig = require('../../utils/cloud-config')
const dateUtil = require('../../utils/date')
const matchOptions = require('../../utils/match-options')
const present = require('../../utils/present')
const privacy = require('../../utils/privacy')
const errors = require('../../utils/error')
const tabBar = require('../../utils/tab-bar')

const BALL_AGES = ['不限球龄', '新手友好', '球龄 1 年以内', '球龄 2—5 年', '球龄 5 年以上']
const PRACTICE_INTENT_OPTIONS = [
  { value: '随便练练', caption: '不设目标，轻松打球' },
  { value: '切磋球技', caption: '按比赛节奏相互交流' }
]
const CAPACITY_MIN = 1
const CAPACITY_MAX = 8
const VENUE_PAGE_SIZE = 50
const VENUE_SEARCH_CACHE_TTL_MS = 2 * 60 * 1000
const VENUE_SEARCH_CACHE_MAX_ENTRIES = 8
const DRAFT_FIELDS = ['venueId', 'date', 'startTime', 'endTime', 'courtStatus', 'capacity', 'ballAgeIndex', 'practiceIntent', 'joinMode', 'feePerPerson', 'termsAccepted', 'rebookMode', 'rebookTimeConfirmed', 'rebookVenueUnavailable']

function isOutcomeUnknown(error) {
  return Boolean(error && error.details && error.details.outcomeUnknown) ||
    ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INTERNAL', 'INVALID_SERVER_RESPONSE'].includes(error && error.code)
}

function uniqueVenues(items) {
  const seen = new Set()
  return (items || []).filter((item) => {
    if (!item || !item.id || item.unavailable || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

function venueMatches(item, query) {
  if (!query) return true
  return [item.name, item.address, item.district, item.locationText]
    .map((value) => String(value || '').toLowerCase())
    .join(' ')
    .includes(query)
}

function normalizeCapacity(value) {
  if (value === undefined || value === null || value === '') return matchOptions.DEFAULT_CAPACITY
  const capacity = Number(value)
  if (!Number.isInteger(capacity)) return matchOptions.DEFAULT_CAPACITY
  return Math.min(CAPACITY_MAX, Math.max(CAPACITY_MIN, capacity))
}

function timeMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''))
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

function endTimeAfterStart(startTime, previousStartTime, previousEndTime) {
  const start = timeMinutes(startTime)
  if (start === null) return previousEndTime
  const previousStart = timeMinutes(previousStartTime)
  const previousEnd = timeMinutes(previousEndTime)
  const previousDuration = previousStart !== null && previousEnd !== null ? previousEnd - previousStart : 0
  const duration = previousDuration > 0 && previousDuration <= 360 ? previousDuration : 90
  const end = Math.min(23 * 60 + 59, start + duration)
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
}

function initialSchedule() {
  const now = new Date()
  now.setMinutes(Math.ceil(now.getMinutes() / 30) * 30, 0, 0)
  now.setHours(now.getHours() + 1)
  if (now.getHours() < 7 || now.getHours() >= 23) {
    if (now.getHours() >= 23) now.setDate(now.getDate() + 1)
    now.setHours(10, 0, 0, 0)
  }
  let end = new Date(now.getTime() + 90 * 60 * 1000)
  if (dateUtil.toDateString(end) !== dateUtil.toDateString(now)) {
    now.setDate(now.getDate() + 1)
    now.setHours(10, 0, 0, 0)
    end = new Date(now.getTime() + 90 * 60 * 1000)
  }
  return {
    date: dateUtil.toDateString(now),
    startTime: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    endTime: `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
  }
}

function rebookDraft(prefill) {
  const schedule = initialSchedule()
  const capacity = normalizeCapacity(prefill.capacity)
  const practiceIntent = matchOptions.normalizePracticeIntent(prefill.practiceIntent, prefill.selectedSkills)
  const ballAgeIndex = BALL_AGES.indexOf(prefill.expectedBallAge)
  const fee = Number(prefill.feePerPerson)
  return Object.assign({}, schedule, {
    minimumDate: dateUtil.today(),
    dateLabel: dateUtil.displayDate(schedule.date),
    publishedMatch: null,
    venueId: typeof prefill.venueId === 'string' ? prefill.venueId : '',
    venueIndex: 0,
    selectedVenue: null,
    courtStatus: 'unbooked',
    capacity,
    ballAgeIndex: ballAgeIndex >= 0 ? ballAgeIndex : 0,
    practiceIntent,
    joinMode: capacity === 1 || prefill.joinMode !== 'confirm' ? 'direct' : 'confirm',
    feePerPerson: Number.isInteger(fee) && fee > 0 ? String(Math.min(999, fee)) : '',
    showMoreOptions: false,
    termsAccepted: false,
    submitError: '',
    submitting: false,
    // Explicitly clear fields left in a live 1.0.7 page instance. They are no
    // longer rendered, persisted or submitted by the structured 1.0.10 form.
    title: '',
    note: '',
    courtBookingNote: '',
    rebookMode: true,
    rebookTimeConfirmed: false,
    rebookVenueUnavailable: false,
    rebookNotice: '已复用上次的球馆和练习设置。请确认本次时间；球台状态已重置。'
  })
}

Page({
  data: {
    loadState: 'loading',
    loginRequired: false,
    errorMessage: '',
    venues: [],
    venueNames: [],
    filteredVenues: [],
    filteredVenueNames: [],
    visibleFilteredVenues: [],
    venueSearch: '',
    venueSearching: false,
    venueSearched: false,
    venueSearchHasMore: false,
    venueSearchError: '',
    venueSelectionError: '',
    venueIndex: 0,
    venueId: '',
    selectedVenue: null,
    minimumDate: '',
    date: '',
    dateLabel: '',
    startTime: '',
    endTime: '',
    courtStatus: 'unbooked',
    capacityMin: CAPACITY_MIN,
    capacityMax: CAPACITY_MAX,
    capacity: matchOptions.DEFAULT_CAPACITY,
    ballAgeOptions: BALL_AGES,
    ballAgeIndex: 0,
    practiceIntent: matchOptions.DEFAULT_PRACTICE_INTENT,
    practiceIntentOptions: PRACTICE_INTENT_OPTIONS,
    joinMode: 'direct',
    feePerPerson: '',
    showMoreOptions: false,
    termsAccepted: false,
    submitError: '',
    submitting: false,
    publishOutcomeUnknown: false,
    publishedMatch: null,
    rebookMode: false,
    rebookTimeConfirmed: true,
    rebookVenueUnavailable: false,
    rebookNotice: '',
    prefillNotice: ''
  },

  onLoad() {
    const schedule = initialSchedule()
    const draft = clientState.getPublishDraft() || {}
    const rawAttempt = draft.publishAttempt
    const storedAttempt = rawAttempt && rawAttempt.requestId && rawAttempt.payload &&
      !Object.prototype.hasOwnProperty.call(rawAttempt.payload, 'title') &&
      !Object.prototype.hasOwnProperty.call(rawAttempt.payload, 'note')
      ? rawAttempt
      : null
    delete draft.publishAttempt
    // Purge free-text fields retained by an older 1.0.7 draft. The review
    // build only publishes structured booking information.
    delete draft.title
    delete draft.note
    delete draft.noteLength
    this.publishAttempt = draft.publishOutcomeUnknown && storedAttempt ? storedAttempt : null
    draft.publishOutcomeUnknown = Boolean(this.publishAttempt)
    if (draft.termsVersion !== cloudConfig.termsVersion) draft.termsAccepted = false
    if (!dateUtil.isFutureSchedule(draft.date, draft.startTime, 10)) {
      draft.date = schedule.date
      draft.startTime = schedule.startTime
      draft.endTime = schedule.endTime
      draft.courtStatus = 'unbooked'
      if (draft.rebookMode === true) draft.rebookTimeConfirmed = false
    }
    draft.capacity = normalizeCapacity(draft.capacity)
    draft.practiceIntent = matchOptions.normalizePracticeIntent(draft.practiceIntent, draft.selectedSkills)
    if (draft.capacity === 1) draft.joinMode = 'direct'
    draft.rebookMode = draft.rebookMode === true
    draft.rebookTimeConfirmed = draft.rebookMode ? draft.rebookTimeConfirmed === true : true
    draft.rebookVenueUnavailable = draft.rebookMode && draft.rebookVenueUnavailable === true
    this.pendingRebookVenueId = draft.rebookMode ? draft.venueId : ''
    const prefill = clientState.consumePublishPrefill()
    this.setData(Object.assign({}, schedule, draft, {
      minimumDate: dateUtil.today(),
      dateLabel: dateUtil.displayDate(draft.date || schedule.date),
      rebookNotice: draft.rebookMode
        ? draft.rebookVenueUnavailable
          ? '上次的球馆当前不可选择，请换一家球馆，并确认本次时间。'
          : '已复用上次的球馆和练习设置。请确认本次时间；球台状态已重置。'
        : '',
      showMoreOptions: false
    }))
    if (prefill) this.applyPrefill(prefill)
    this.loadVenues()
  },

  onShow() {
    tabBar.sync(this, 'pages/publish/publish')
    const prefill = clientState.consumePublishPrefill()
    if (prefill) this.applyPrefill(prefill)
    const app = getApp()
    const sessionReady = Boolean(app && app.globalData && app.globalData.session)
    // The first passive load is allowed to stop at LOGIN_REQUIRED for guests.
    // Once the user explicitly signs in and returns, resume that interrupted
    // venue load so the publish flow does not require a second retry tap.
    if (!this.data.publishedMatch && this.data.loadState !== 'ready' && sessionReady) {
      return this.loadVenues()
    }
  },

  onUnload() {
    this.destroyed = true
    this.venueLoadRun = Number(this.venueLoadRun || 0) + 1
    this.venueSearchRun = Number(this.venueSearchRun || 0) + 1
    if (!this.data.publishedMatch) this.persistDraft()
  },

  orderedVenues(items) {
    const favoriteIds = this.favoriteVenueIds || new Set()
    return uniqueVenues(items).map((item) => Object.assign({}, item, {
      favorited: favoriteIds.has(item.id)
    })).sort((left, right) => Number(right.favorited) - Number(left.favorited))
  },

  setVenueCatalog(items, run, done) {
    if (run !== this.venueLoadRun || this.destroyed) return
    const venues = this.orderedVenues(items)
    this.allVenues = venues
    const selectedVenue = this.data.venueId
      ? venues.find((item) => item.id === this.data.venueId) || this.data.selectedVenue
      : this.data.selectedVenue
    this.setData({
      venues,
      venueNames: venues.map((item) => item.name),
      selectedVenue
    }, () => {
      this.applyVenueSearch()
      if (done) done()
    })
  },

  async readFavoriteVenues(run) {
    if (!api.favorites || !api.favorites.list) return []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        let page = 1
        let hasMore = true
        let items = []
        while (hasMore) {
          const result = await api.favorites.list({ page, pageSize: VENUE_PAGE_SIZE })
          if (run !== this.venueLoadRun || this.destroyed) return null
          const pageItems = result.items || []
          items = items.concat(pageItems)
          hasMore = result.hasMore === true && pageItems.length > 0
          page += 1
        }
        return items
      } catch (error) {
        if (run !== this.venueLoadRun || this.destroyed) return null
        // Keep the public directory usable and retry marked venues once in the
        // background. A transient favorite failure must not block publishing.
        if (attempt > 0) return null
      }
    }
    return null
  },

  applyFavoriteVenues(rawFavorites, run) {
    if (!Array.isArray(rawFavorites) || run !== this.venueLoadRun || this.destroyed) return
    const favorites = uniqueVenues(rawFavorites.map(present.venue))
    this.favoriteVenueIds = new Set(favorites.map((item) => item.id))
    this.setVenueCatalog(favorites.concat(this.allVenues || []), run)
  },

  async loadVenues(event) {
    if (this.venueLoading) return this.venueLoading
    const run = Number(this.venueLoadRun || 0) + 1
    this.venueLoadRun = run
    this.destroyed = false
    this.setData({ loadState: 'loading', loginRequired: false, errorMessage: '' })
    const task = (async () => {
      try {
        await getApp().ensureSession({ interactive: Boolean(event && event.currentTarget) })
        const favoriteTask = this.readFavoriteVenues(run)
        const result = await api.venues.list({ city: '杭州', page: 1, pageSize: VENUE_PAGE_SIZE })
        if (run !== this.venueLoadRun) return
        const venues = uniqueVenues((result.items || []).map(present.venue))
        // A newly recorded or previously chosen venue may sort beyond page 1.
        // Validate it by ID rather than discarding a valid selection.
        const selectedId = this.data.venueId
        if (selectedId && !venues.some((item) => item.id === selectedId)) {
          try {
            const selected = await api.venues.get({ venueId: selectedId })
            if (selected && selected.id === selectedId) venues.unshift(present.venue(selected))
          } catch (error) {
            if (error.code !== 'NOT_FOUND') throw error
          }
        }
        if (run !== this.venueLoadRun) return
        this.allVenues = this.orderedVenues(venues)
        this.setData({
          loadState: 'ready',
          venues: this.allVenues,
          venueNames: this.allVenues.map((item) => item.name)
        }, () => {
          this.applyVenueSearch()
          this.restoreVenueSelection()
        })
        const favoriteLoading = favoriteTask.then((items) => this.applyFavoriteVenues(items, run))
        this.favoriteLoading = favoriteLoading
        favoriteLoading.finally(() => {
          if (this.favoriteLoading === favoriteLoading) this.favoriteLoading = null
        })
        // The picker renders only a compact result window. Avoid downloading
        // the whole Hangzhou directory after first paint; explicit search is
        // server-side and still covers the complete name/address collection.
      } catch (error) {
        if (run === this.venueLoadRun) this.setData({
          loadState: 'error',
          loginRequired: error.code === 'LOGIN_REQUIRED',
          errorMessage: errors.message(error)
        })
      }
    })()
    this.venueLoading = task
    try {
      await task
    } finally {
      if (this.venueLoading === task) this.venueLoading = null
    }
  },

  applyVenueSearch() {
    const query = String(this.data.venueSearch || '').trim().toLowerCase()
    const localMatches = (this.allVenues || this.data.venues || []).filter((item) => venueMatches(item, query))
    const combined = query ? localMatches.concat(this.searchedVenues || []) : localMatches
    const filteredVenues = this.orderedVenues(combined)
    const selectedIndex = filteredVenues.findIndex((item) => item.id === this.data.venueId)
    this.setData({
      filteredVenues,
      filteredVenueNames: filteredVenues.map((item) => item.name),
      visibleFilteredVenues: filteredVenues.slice(0, 8),
      venueIndex: selectedIndex >= 0 ? selectedIndex : 0
    })
  },

  inputVenueSearch(event) {
    this.searchedVenues = []
    this.venueSearchRun = Number(this.venueSearchRun || 0) + 1
    this.setData({
      venueSearch: String(event.detail.value || '').slice(0, 30),
      venueSearching: false,
      venueSearched: false,
      venueSearchHasMore: false,
      venueSearchError: ''
    }, () => this.applyVenueSearch())
  },

  async searchVenues() {
    const keyword = String(this.data.venueSearch || '').trim().slice(0, 30)
    if (!keyword) {
      this.searchedVenues = []
      this.setData({ venueSearched: false, venueSearchHasMore: false, venueSearchError: '' }, () => this.applyVenueSearch())
      return
    }
    if (this.data.venueSearching) return
    const run = Number(this.venueSearchRun || 0) + 1
    this.venueSearchRun = run
    this.setData({ venueSearching: true, venueSearchError: '' })
    try {
      this.venueSearchCache = this.venueSearchCache || new Map()
      const cacheKey = keyword.toLowerCase()
      let cached = this.venueSearchCache.get(cacheKey)
      if (cached && Date.now() - Number(cached.cachedAt || 0) >= VENUE_SEARCH_CACHE_TTL_MS) {
        this.venueSearchCache.delete(cacheKey)
        cached = null
      } else if (cached) {
        // Refresh insertion order so the bounded Map acts as a small LRU.
        this.venueSearchCache.delete(cacheKey)
        this.venueSearchCache.set(cacheKey, cached)
      }
      if (!cached) {
        const result = await api.venues.list({ city: '杭州', keyword, page: 1, pageSize: VENUE_PAGE_SIZE })
        cached = {
          items: (result.items || []).map(present.venue),
          hasMore: result.hasMore === true,
          cachedAt: Date.now()
        }
        this.venueSearchCache.set(cacheKey, cached)
        while (this.venueSearchCache.size > VENUE_SEARCH_CACHE_MAX_ENTRIES) {
          this.venueSearchCache.delete(this.venueSearchCache.keys().next().value)
        }
      }
      if (run !== this.venueSearchRun || this.destroyed) return
      const found = cached.items
      this.searchedVenues = this.orderedVenues(found)
      this.setData({
        venueSearching: false,
        venueSearched: true,
        venueSearchHasMore: cached.hasMore
      }, () => this.applyVenueSearch())
    } catch (error) {
      if (run !== this.venueSearchRun || this.destroyed) return
      this.setData({
        venueSearching: false,
        venueSearched: true,
        venueSearchError: errors.message(error, '球馆搜索暂时不可用，请重试')
      })
    }
  },

  restoreVenueSelection() {
    const venueId = this.data.venueId
    if (!venueId) return
    const venueIndex = this.data.venues.findIndex((item) => item.id === venueId)
    if (venueIndex < 0) {
      const rebook = this.pendingRebookVenueId === venueId
      this.pendingRebookVenueId = ''
      this.setData({
        venueId: '',
        venueIndex: 0,
        selectedVenue: null,
        rebookVenueUnavailable: rebook,
        venueSelectionError: '原先选择的球馆已下架或暂不可约，请重新选择',
        rebookNotice: rebook ? '上次的球馆当前不可选择，请换一家球馆，并确认本次时间。' : ''
      }, () => this.persistDraft())
      return
    }
    this.pendingRebookVenueId = ''
    this.setData({ venueId, venueIndex, selectedVenue: this.data.venues[venueIndex], venueSelectionError: '', rebookVenueUnavailable: false }, () => this.persistDraft())
  },

  applyPrefill(prefill) {
    if (!prefill) return
    // The review build is a focused booking tool. Public-feed availability is
    // deliberately not copied into a new match: the host must choose every
    // concrete schedule/venue field on this page.
    if (prefill.source === 'player-update' || prefill.source === 'friend-update') return
    if (prefill.kind === 'rebook') {
      const patch = rebookDraft(prefill)
      this.pendingRebookVenueId = patch.venueId
      this.publishRequestId = ''
      this.setData(patch, () => {
        this.persistDraft()
        this.loadVenues()
        wx.pageScrollTo({ scrollTop: 0, duration: 0 })
      })
      return
    }
    if (this.data.publishedMatch) this.resetForm()
    const patch = {}
    const schedule = initialSchedule()
    const previousDate = this.data.date
    const previousVenueId = this.data.venueId
    const requestedDate = typeof prefill.date === 'string' && dateUtil.dateTab(prefill.date)
      ? prefill.date
      : ''
    let safeDate = ''
    if (requestedDate) {
      safeDate = requestedDate >= schedule.date ? requestedDate : schedule.date
      patch.date = safeDate
      patch.dateLabel = dateUtil.displayDate(safeDate)
      const requestedStartTime = /^\d{2}:\d{2}$/.test(prefill.startTime || '') ? prefill.startTime : ''
      const requestedEndTime = /^\d{2}:\d{2}$/.test(prefill.endTime || '') ? prefill.endTime : ''
      if (requestedStartTime && requestedEndTime && requestedEndTime > requestedStartTime && dateUtil.isFutureSchedule(safeDate, requestedStartTime, 10)) {
        patch.startTime = requestedStartTime
        patch.endTime = requestedEndTime
      } else if (!dateUtil.isFutureSchedule(safeDate, this.data.startTime, 10)) {
        patch.startTime = schedule.startTime
        patch.endTime = schedule.endTime
      }
    }
    const ballAgeIndex = BALL_AGES.indexOf(prefill.expectedBallAge)
    if (ballAgeIndex >= 0) patch.ballAgeIndex = ballAgeIndex
    const dateChanged = Boolean(safeDate && safeDate !== previousDate)
    const venueChanged = Boolean(prefill.venueId && prefill.venueId !== previousVenueId)
    if (dateChanged || venueChanged) {
      patch.courtStatus = 'unbooked'
      patch.rebookVenueUnavailable = false
      if (this.data.rebookMode) {
        patch.rebookTimeConfirmed = false
        patch.rebookNotice = '日期或球馆已更换，请重新确认本次时间；球台状态已重置。'
        if (venueChanged) this.pendingRebookVenueId = prefill.venueId
      }
    }
    if (prefill.source === 'home' && (requestedDate || ballAgeIndex > 0)) {
      patch.prefillNotice = '已带入首页选择的日期和球龄，可继续调整'
    } else if (venueChanged) {
      patch.prefillNotice = '已切换球馆，球台状态已重置'
    }
    if (!prefill.venueId) {
      if (Object.keys(patch).length) this.setData(patch, () => this.changed())
      return
    }
    if (!this.data.venues.length) {
      this.setData(Object.assign(patch, { venueId: prefill.venueId, selectedVenue: null }), () => this.changed())
      this.loadVenues()
      return
    }
    const venueIndex = this.data.venues.findIndex((item) => item.id === prefill.venueId)
    if (venueIndex >= 0) this.setData(Object.assign(patch, { venueId: prefill.venueId, venueIndex, selectedVenue: this.data.venues[venueIndex] }), () => this.changed())
    else {
      this.setData(Object.assign(patch, { venueId: prefill.venueId, selectedVenue: null }), () => this.changed())
      this.loadVenues()
    }
  },

  openVenueCreate() {
    if (this.data.submitting) return
    this.persistDraft()
    const name = String(this.data.venueSearch || '').trim().slice(0, 60)
    wx.navigateTo({
      url: `/pages/venue-create/venue-create?from=publish${name ? `&name=${encodeURIComponent(name)}` : ''}`,
      events: { venueCreated: (event) => this.acceptCreatedVenue(event.venue) }
    })
  },

  acceptCreatedVenue(raw) {
    if (!raw || !raw.id || !raw.name) return
    const selectedVenue = present.venue(raw)
    this.venueLoadRun = Number(this.venueLoadRun || 0) + 1
    this.venueSearchRun = Number(this.venueSearchRun || 0) + 1
    this.searchedVenues = []
    this.venueSearchCache = new Map()
    this.venueLoading = null
    this.pendingRebookVenueId = ''
    const venues = [selectedVenue].concat((this.allVenues || this.data.venues).filter((item) => item.id !== selectedVenue.id))
    this.allVenues = venues
    this.setData({
      venues, venueNames: venues.map((item) => item.name), venueIndex: 0,
      venueSearch: '', venueSearched: false, venueSearchHasMore: false, venueSearchError: '', venueSearching: false,
      venueId: selectedVenue.id, selectedVenue, courtStatus: 'unbooked',
      loadState: 'ready', loginRequired: false, errorMessage: '', venueSelectionError: '', rebookVenueUnavailable: false,
      rebookNotice: this.data.rebookMode ? '已更换球馆，请确认本次时间与球台安排。' : ''
    }, () => { this.applyVenueSearch(); this.changed() })
  },

  changeVenue(event) {
    const venueIndex = Number(event.detail.value)
    const selectedVenue = this.data.filteredVenues[venueIndex] || this.data.venues[venueIndex] || null
    this.selectVenue(selectedVenue)
  },

  selectVenueResult(event) {
    const venueId = event.currentTarget.dataset.id
    const selectedVenue = (this.data.filteredVenues || []).find((item) => item.id === venueId) || null
    this.selectVenue(selectedVenue)
  },

  selectVenue(selectedVenue) {
    if (!selectedVenue) return
    const currentVenues = this.allVenues || this.data.venues || []
    const venues = currentVenues.some((item) => item.id === selectedVenue.id)
      ? currentVenues
      : [selectedVenue].concat(currentVenues)
    this.allVenues = venues
    this.setData({
      venues,
      venueNames: venues.map((item) => item.name),
      venueSearch: '',
      venueId: selectedVenue.id,
      selectedVenue,
      courtStatus: 'unbooked',
      venueSearched: false,
      venueSearchHasMore: false,
      venueSearchError: '',
      venueSelectionError: '',
      rebookVenueUnavailable: false,
      rebookNotice: this.data.rebookMode ? '已复用上次的练习设置。请确认本次时间；球台状态已重置。' : ''
    }, () => { this.applyVenueSearch(); this.changed() })
  },

  commitScheduleChange(patch) {
    this.publishRequestId = ''
    this.setData(Object.assign({
      courtStatus: 'unbooked',
      rebookTimeConfirmed: !this.data.rebookMode,
      prefillNotice: ''
    }, patch), () => {
      const submitError = this.validateSchedule()
      this.setData({ submitError }, () => this.persistDraft())
    })
  },

  changeDate(event) {
    this.commitScheduleChange({ date: event.detail.value, dateLabel: dateUtil.displayDate(event.detail.value) })
  },

  changeStartTime(event) {
    const startTime = event.detail.value
    const endTime = endTimeAfterStart(startTime, this.data.startTime, this.data.endTime)
    this.commitScheduleChange({ startTime, endTime })
  },
  changeEndTime(event) { this.commitScheduleChange({ endTime: event.detail.value }) },

  changeNumericField(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [field]: String(event.detail.value || '').replace(/\D/g, '').slice(0, 3) }, () => this.changed())
  },

  selectCourtStatus(event) { this.setData({ courtStatus: event.currentTarget.dataset.value }, () => this.changed()) },
  setCapacity(value) {
    const capacity = normalizeCapacity(value)
    if (capacity === this.data.capacity) return
    const patch = { capacity }
    if (capacity === 1) patch.joinMode = 'direct'
    this.setData(patch, () => this.changed())
  },
  previewCapacity(event) {
    const capacity = normalizeCapacity(event.detail.value)
    const patch = { capacity }
    if (capacity === 1) patch.joinMode = 'direct'
    this.setData(patch)
  },
  commitCapacity(event) {
    const capacity = normalizeCapacity(event.detail.value)
    const patch = { capacity }
    if (capacity === 1) patch.joinMode = 'direct'
    this.setData(patch, () => this.changed())
  },
  changeBallAge(event) { this.setData({ ballAgeIndex: Number(event.detail.value), prefillNotice: '' }, () => this.changed()) },
  selectJoinMode(event) { this.setData({ joinMode: event.currentTarget.dataset.value }, () => this.changed()) },

  selectPracticeIntent(event) {
    const practiceIntent = event.currentTarget.dataset.value
    if (!matchOptions.PRACTICE_INTENTS.includes(practiceIntent) || practiceIntent === this.data.practiceIntent) return
    this.setData({ practiceIntent }, () => this.changed())
  },

  toggleTerms() {
    this.setData({ termsAccepted: !this.data.termsAccepted }, () => this.changed())
  },

  confirmRebookTime() {
    const scheduleError = this.validateSchedule()
    if (scheduleError) {
      this.setData({ submitError: scheduleError })
      return
    }
    this.setData({ rebookTimeConfirmed: true, submitError: '' }, () => this.persistDraft())
  },

  openTerms() {
    wx.navigateTo({ url: '/pages/settings/settings?section=terms' })
  },

  openPrivacy() {
    privacy.openContract()
  },

  changed() {
    if (this.data.publishOutcomeUnknown) {
      this.setData({ submitError: '上次发布结果待确认，请先用原请求确认结果' })
      return
    }
    this.publishRequestId = ''
    this.setData({ submitError: '' })
    this.persistDraft()
  },

  persistDraft() {
    const draft = {}
    DRAFT_FIELDS.forEach((field) => { draft[field] = this.data[field] })
    draft.termsVersion = cloudConfig.termsVersion
    draft.publishOutcomeUnknown = this.data.publishOutcomeUnknown === true
    draft.publishAttempt = draft.publishOutcomeUnknown && this.publishAttempt
      ? this.publishAttempt
      : null
    clientState.savePublishDraft(draft)
  },

  validateSchedule() {
    if (!dateUtil.isFutureSchedule(this.data.date, this.data.startTime, 10)) return '开始时间至少应晚于当前时间 10 分钟'
    const start = new Date(`${this.data.date}T${this.data.startTime}:00+08:00`)
    const end = new Date(`${this.data.date}T${this.data.endTime}:00+08:00`)
    if (end <= start) return '结束时间必须晚于开始时间'
    if (end - start < 30 * 60 * 1000) return '球局至少需要 30 分钟，请调整时间'
    if (end - start > 6 * 60 * 60 * 1000) return '单场球局不能超过 6 小时'
    return ''
  },

  validate() {
    if (!this.data.venueId) return '请选择球馆'
    if (!this.data.selectedVenue || this.data.selectedVenue.id !== this.data.venueId) return '已选球馆当前不可用，请重新选择'
    const scheduleError = this.validateSchedule()
    if (scheduleError) return scheduleError
    if (this.data.rebookMode && !this.data.rebookTimeConfirmed) return '请先确认本次约球时间'
    if (!Number.isInteger(this.data.capacity) || this.data.capacity < CAPACITY_MIN || this.data.capacity > CAPACITY_MAX) return '球局总人数请选择 1—8 人'
    if (!matchOptions.PRACTICE_INTENTS.includes(this.data.practiceIntent)) return '请选择想怎么练'
    const fee = this.data.feePerPerson === '' ? 0 : Number(this.data.feePerPerson)
    if (!Number.isInteger(fee) || fee < 0 || fee > 999) return '人均费用请输入 0—999 元'
    if (!this.data.termsAccepted) return '请先阅读并同意用户协议和隐私保护指引'
    return ''
  },

  showValidationError(message, extraPatch = {}) {
    let selector = ''
    const patch = Object.assign({ submitError: message }, extraPatch)
    if (message.includes('球馆')) selector = '#publish-venue'
    else if (message.includes('时间') || message.includes('小时') || message.includes('分钟')) selector = '#publish-schedule'
    else if (message.includes('费用')) {
      selector = '#publish-more'
      patch.showMoreOptions = true
    } else if (message.includes('协议') || message.includes('隐私')) selector = '#publish-terms'
    else if (message.includes('人数') || message.includes('怎么练') || message.includes('练习')) selector = '#publish-play'
    this.setData(patch, () => {
      if (selector && wx.pageScrollTo) wx.pageScrollTo({ selector, duration: 220 })
    })
  },

  async submit() {
    if (this.data.submitting) return
    const existingAttempt = this.data.publishOutcomeUnknown ? this.publishAttempt : null
    if (!existingAttempt) {
      const validationError = this.validate()
      if (validationError) {
        this.showValidationError(validationError)
        return
      }
    }
    this.setData({ submitting: true, submitError: '' })
    const payload = existingAttempt ? existingAttempt.payload : {
      venueId: this.data.venueId,
      date: this.data.date,
      startTime: this.data.startTime,
      endTime: this.data.endTime,
      courtStatus: this.data.courtStatus,
      capacity: this.data.capacity,
      expectedBallAge: BALL_AGES[this.data.ballAgeIndex],
      practiceIntent: this.data.practiceIntent,
      joinMode: this.data.joinMode,
      feePerPerson: this.data.feePerPerson === '' ? 0 : Number(this.data.feePerPerson),
      termsAccepted: true,
      termsVersion: cloudConfig.termsVersion
    }
    const attempt = existingAttempt || {
      requestId: this.publishRequestId || api.createRequestId(),
      payload
    }
    this.publishAttempt = attempt
    this.publishRequestId = attempt.requestId
    try {
      let result
      try {
        result = await api.matches.create(attempt.payload, { requestId: attempt.requestId, retry: false })
      } catch (error) {
        if (!isOutcomeUnknown(error)) throw error
        // The match ID is derived from this request ID on the server. Retrying
        // the exact same mutation therefore acts as a safe result lookup: it
        // returns the prior match if the first response was lost, or creates it
        // once if the first request never arrived.
        try {
          result = await api.matches.create(attempt.payload, { requestId: attempt.requestId, retry: false })
        } catch (retryError) {
          // Once the first response is unknown, a later transport/server error
          // cannot prove that no match exists. Preserve that uncertainty so a
          // future tap keeps the same request ID and payload.
          retryError.details = Object.assign({}, retryError.details, { outcomeUnknown: true })
          throw retryError
        }
      }
      const publishedMatch = present.match(result.match)
      clientState.clearPublishDraft()
      this.publishAttempt = null
      this.publishRequestId = ''
      this.setData({ publishedMatch, submitting: false, publishOutcomeUnknown: false })
      wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    } catch (error) {
      if (isOutcomeUnknown(error)) {
        this.setData({
          submitError: '网络中断，发布结果待确认。点击“确认发布结果”会安全对账，不会重复发布。',
          submitting: false,
          publishOutcomeUnknown: true
        }, () => this.persistDraft())
        return
      }
      this.publishAttempt = null
      this.publishRequestId = ''
      this.showValidationError(errors.message(error), { submitting: false, publishOutcomeUnknown: false })
    }
  },

  openPublishedMatch() {
    wx.navigateTo({ url: `/pages/match-detail/match-detail?id=${this.data.publishedMatch.id}` })
  },

  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' })
  },

  resetForm() {
    clientState.clearPublishDraft()
    this.publishAttempt = null
    this.publishRequestId = ''
    const schedule = initialSchedule()
    this.setData(Object.assign({}, schedule, {
      publishedMatch: null,
      venueId: '',
      selectedVenue: null,
      venueIndex: 0,
      courtStatus: 'unbooked',
      capacity: matchOptions.DEFAULT_CAPACITY,
      ballAgeIndex: 0,
      practiceIntent: matchOptions.DEFAULT_PRACTICE_INTENT,
      joinMode: 'direct',
      feePerPerson: '',
      showMoreOptions: false,
      termsAccepted: false,
      publishOutcomeUnknown: false,
      title: '',
      note: '',
      courtBookingNote: '',
      rebookMode: false,
      rebookTimeConfirmed: true,
      rebookVenueUnavailable: false,
      rebookNotice: '',
      prefillNotice: '',
      dateLabel: dateUtil.displayDate(schedule.date)
    }))
  }
})
