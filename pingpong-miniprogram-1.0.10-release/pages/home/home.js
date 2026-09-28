const api = require('../../utils/api')
const clientState = require('../../utils/client-state')
const dateUtil = require('../../utils/date')
const present = require('../../utils/present')
const errors = require('../../utils/error')
const share = require('../../utils/share')
const diagnostics = require('../../utils/diagnostics')
const mapHelper = require('../../utils/map')
const tabBar = require('../../utils/tab-bar')

const DISTRICTS = ['全杭州', '西湖区', '拱墅区', '上城区', '滨江区', '余杭区', '萧山区']
const BALL_AGES = ['不限球龄', '新手友好', '球龄 1 年以内', '球龄 2—5 年', '球龄 5 年以上']
const MEDIA_BATCH_SIZE = 20
const MATCH_PAGE_SIZE = 50
const COACH_PAGE_SIZE = 30
const RECOVERABLE_ERRORS = new Set(['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE'])
const SESSION_ERRORS = new Set(['BOOTSTRAP_REQUIRED', 'UNAUTHENTICATED', 'CONSENT_REQUIRED', 'CONSENT_VERSION_MISMATCH'])
const ACCESS_ERRORS = new Set(['LOGIN_REQUIRED', ...SESSION_ERRORS, 'ACCOUNT_DELETED', 'ACCOUNT_SUSPENDED', 'FORBIDDEN'])

function dateSelection(value = '') {
  const minimumDate = dateUtil.today()
  const dateOptions = dateUtil.dateTabs(7)
  const selectedDate = value === '' ? '' : dateUtil.dateTab(value) && value >= minimumDate ? value : minimumDate
  const customDateLabel = selectedDate && !dateOptions.some((item) => item.value === selectedDate)
    ? dateUtil.displayDate(selectedDate) : ''
  return { dateOptions, selectedDate, minimumDate, customDateLabel }
}

function mergeById(current, incoming) {
  const merged = new Map()
  ;(current || []).concat(incoming || []).forEach((item) => {
    if (item && item.id) merged.set(item.id, item)
  })
  return Array.from(merged.values())
}

async function resolveMediaUrls(fileIds, options = {}) {
  const unique = Array.from(new Set((fileIds || []).filter(Boolean)))
  const batches = []
  for (let index = 0; index < unique.length; index += MEDIA_BATCH_SIZE) {
    batches.push(unique.slice(index, index + MEDIA_BATCH_SIZE))
  }
  const results = await Promise.all(batches.map(async (batch) => {
    try {
      return await api.files.resolve(batch, options)
    } catch (_) {
      return { urls: {} }
    }
  }))
  return results.reduce((urls, result) => Object.assign(urls, result.urls || {}), {})
}

Page({
  data: {
    state: 'loading',
    refreshing: false,
    manualRefreshing: false,
    primaryLoading: false,
    loadingSlow: false,
    loadingStage: 'session',
    refreshNotice: '',
    refreshError: '',
    errorMessage: '',
    loginRequired: false,
    loggedIn: false,
    mode: 'matches',
    districts: DISTRICTS,
    districtIndex: 0,
    districtLabel: '',
    dateOptions: [],
    selectedDate: '',
    minimumDate: '',
    customDateLabel: '',
    ballAgeOptions: BALL_AGES,
    ballAgeIndex: 0,
    friendsOnly: false,
    venueLoadFailed: false,
    venuesLoading: false,
    favoriteSavingById: {},
    venues: [],
    matches: [],
    coaches: [],
    matchesPage: 0,
    matchesHasMore: false,
    coachesPage: 0,
    coachesHasMore: false,
    loadingMore: false,
    paginationError: ''
  },

  onLoad(options = {}) {
    this.visible = true
    this.destroyed = false
    if (wx.onNetworkStatusChange && wx.offNetworkStatusChange) {
      this.networkListener = (status) => this.handleNetworkStatusChange(status)
      wx.onNetworkStatusChange(this.networkListener)
    }
    share.enable()
    const preferences = clientState.getHomeFilters()
    const districtIndex = Math.max(0, DISTRICTS.indexOf(preferences.district || '全杭州'))
    const ballAgeIndex = Math.max(0, BALL_AGES.indexOf(preferences.ballAge || '不限球龄'))
    const selection = dateSelection(preferences.date || '')
    const { dateOptions, selectedDate } = selection
    const requestedMode = ['matches', 'players', 'coaches'].includes(options.mode) ? options.mode : 'matches'
    const patch = {
      // 普通冷启动默认找球局；旧动态分享链接回到找球局，不再加载公开动态。
      mode: requestedMode,
      districtIndex,
      districtLabel: districtIndex ? DISTRICTS[districtIndex] : '',
      dateOptions,
      selectedDate,
      minimumDate: selection.minimumDate,
      customDateLabel: selection.customDateLabel,
      ballAgeIndex
    }
    if (requestedMode === 'matches') {
      const snapshot = clientState.getHomeSnapshot({
        district: districtIndex ? DISTRICTS[districtIndex] : '',
        date: selectedDate,
        ballAge: ballAgeIndex ? BALL_AGES[ballAgeIndex] : '',
        friendsOnly: false
      })
      if (snapshot) Object.assign(patch, {
        state: 'ready',
        matches: snapshot.matches,
        venues: snapshot.venues,
        matchesPage: 1,
        matchesHasMore: snapshot.matchesHasMore === true,
        venuesLoading: false
      })
    }
    this.setData(patch)
  },

  onShow() {
    tabBar.sync(this, 'pages/home/home')
    this.visible = true
    const app = getApp()
    // Returning from the login page without a session means the user cancelled
    // or chose to keep browsing. Drop the pending intent immediately so a later,
    // unrelated login can never mark a venue on their behalf.
    if (this.pendingFavoriteVenueId && !(app.globalData && app.globalData.session)) {
      this.pendingFavoriteVenueId = ''
    }
    const discoverVenues = clientState.consumeHomeDestination() === 'venues'
    if (discoverVenues) {
      this.setData({ mode: 'matches', districtIndex: 0, districtLabel: '' })
    }
    const selection = dateSelection(this.data.selectedDate)
    const { selectedDate } = selection
    const dateChanged = selectedDate !== this.data.selectedDate
    this.setData(selection)
    this.savePreferences()
    return this.loadContent({ showSkeleton: dateChanged || discoverVenues }).then(async (loaded) => {
      if (loaded && discoverVenues && this.data.mode === 'matches' && this.data.venues.length) {
        this.setData({}, () => wx.pageScrollTo({ selector: '#home-venues', duration: 200 }))
      }
      await this.resumePendingFavoriteIntent()
      return loaded
    })
  },

  onPullDownRefresh() {
    return this.refreshHome({ native: true })
  },

  onHide() {
    this.visible = false
    this.finishManualRefresh(false)
    clearTimeout(this.slowLoadingTimer)
  },

  onUnload() {
    this.onHide()
    this.destroyed = true
    this.pendingFavoriteVenueId = ''
    this.contentRequestSequence = Number(this.contentRequestSequence || 0) + 1
    if (this.networkListener) wx.offNetworkStatusChange(this.networkListener)
  },

  refreshHome(options = {}) {
    if (this.manualRefresh) {
      if (options.native === true) this.manualRefresh.native = true
      return this.manualRefresh.promise
    }
    const request = { native: options.native === true }
    request.promise = new Promise(resolve => { request.resolve = resolve })
    this.manualRefresh = request
    this.setData({ manualRefreshing: true, refreshNotice: '', refreshError: '' })
    // 每次主动刷新读取新状态；动画仅等待主列表，不等待球馆图片。
    const finish = () => {
      if (this.manualRefresh === request) this.finishManualRefresh(false)
    }
    this.loadContent({ manual: request, fresh: true }).then(finish, finish)
    return request.promise
  },

  finishManualRefresh(loaded) {
    const request = this.manualRefresh
    if (!request) return
    this.manualRefresh = null
    this.setData({ manualRefreshing: false })
    if (request.native) wx.stopPullDownRefresh()
    request.resolve(loaded)
  },

  finishPrimaryLoad(requestSequence, manual, loaded) {
    if (requestSequence !== this.contentRequestSequence) return
    clearTimeout(this.slowLoadingTimer)
    this.setData({ primaryLoading: false, loadingSlow: false })
    if (loaded) {
      this.retryOnReconnect = false
      this.pendingNetworkRecovery = false
      // Never let account bootstrap or inbox polling compete with the cold
      // start list request. Returning-user state is restored only after the
      // main feed has painted successfully.
      const app = getApp()
      if (app && typeof app.restoreSessionAfterPrimary === 'function') app.restoreSessionAfterPrimary()
      if (manual && this.manualRefresh === manual) {
        this.setData({ refreshNotice: this.data.mode === 'matches' ? '球局已更新' : '教练列表已更新' })
      }
    }
    if (manual && this.manualRefresh === manual) this.finishManualRefresh(loaded)
  },

  handleNetworkStatusChange(status) {
    if (!status.isConnected) { this.networkWasOffline = true; return }
    if (!this.networkWasOffline) return
    this.networkWasOffline = false
    if (!this.visible || this.destroyed) return
    if (this.data.primaryLoading) { this.pendingNetworkRecovery = true; return }
    if (this.retryOnReconnect) return this.refreshHome()
  },

  async loadContent(options = {}) {
    const append = options.append === true
    const startedAt = Date.now()
    const mode = this.data.mode
    if (mode === 'players') {
      // Invalidate in-flight match/coach reads when the shared directory mounts.
      const sequence = this.contentRequestSequence = Number(this.contentRequestSequence || 0) + 1
      clearTimeout(this.slowLoadingTimer)
      this.setData({ state: 'ready', primaryLoading: false, loadingSlow: false, refreshing: false, loadingMore: false, refreshError: '', refreshNotice: '' })
      if (options.fresh && api.invalidateReads) api.invalidateReads()
      const panel = this.selectComponent && this.selectComponent('#home-players')
      const loaded = options.manual && panel ? await panel.refresh() : true
      if (sequence !== this.contentRequestSequence) return false
      if (options.manual && this.manualRefresh === options.manual) {
        if (loaded) this.setData({ refreshNotice: '球友列表已更新' })
        this.finishManualRefresh(Boolean(loaded))
      }
      return loaded
    }
    const hasMore = mode === 'matches' ? this.data.matchesHasMore : this.data.coachesHasMore
    if (append && (this.data.state !== 'ready' || this.data.refreshing || this.data.loadingMore || !hasMore)) return false

    if (this.manualRefresh && this.manualRefresh !== options.manual) this.finishManualRefresh(false)
    clearTimeout(this.slowLoadingTimer)
    const requestSequence = Number(this.contentRequestSequence || 0) + 1
    const favoriteSnapshotVersion = Number(this.favoriteMutationClock || 0)
    this.contentRequestSequence = requestSequence
    const districtIndex = this.data.districtIndex
    const selectedDate = this.data.selectedDate
    const ballAgeIndex = this.data.ballAgeIndex
    const page = append
      ? (mode === 'matches' ? this.data.matchesPage : this.data.coachesPage) + 1
      : 1
    const showSkeleton = !append && (options.showSkeleton === true || this.data.state !== 'ready')
    if (append) {
      this.setData({ loadingMore: true, paginationError: '' })
    } else {
      this.setData({ primaryLoading: true, loadingSlow: false, loadingStage: 'session', refreshError: '', refreshNotice: '' })
      this.setData(showSkeleton
        ? { state: 'loading', refreshing: false, loadingMore: false, paginationError: '', errorMessage: '', venues: [] }
        : { refreshing: true, loadingMore: false, paginationError: '', errorMessage: '' })
      this.slowLoadingTimer = setTimeout(() => {
        if (requestSequence === this.contentRequestSequence && this.visible !== false && this.data.primaryLoading) {
          this.setData({ loadingSlow: true })
        }
      }, 3500)
    }

    try {
      if (options.fresh && api.invalidateReads) api.invalidateReads()
      // Discovery is public. Do not bootstrap an account or request privacy
      // authorization merely because the home page became visible.
      const app = getApp()
      const loggedIn = Boolean(app.globalData && app.globalData.session)
      const readOptions = { publicRead: !loggedIn }
      if (loggedIn !== this.data.loggedIn) this.setData({ loggedIn })
      if (requestSequence !== this.contentRequestSequence) return false
      if (!append) this.setData({ loadingStage: 'list' })

      const district = districtIndex ? DISTRICTS[districtIndex] : ''
      const venuePayload = { city: '杭州', page: 1, pageSize: 30 }
      if (district) venuePayload.district = district
      const reuseVenues = append && !this.data.venuesLoading && !this.data.venueLoadFailed
      if (!reuseVenues) this.setData({ venuesLoading: true, venueLoadFailed: false })
      const venuePromise = (reuseVenues
        ? Promise.resolve({ items: this.data.venues, reused: true })
        : api.venues.list(venuePayload, readOptions).catch(() => ({ items: [], loadFailed: true })))
        .then(result => {
          if (requestSequence !== this.contentRequestSequence || reuseVenues) return result
          if (result.loadFailed) this.setData({ venuesLoading: false, venueLoadFailed: true })
          else {
            const previous = Object.fromEntries(this.data.venues.map(item => [item.id, item]))
            this.setData({ venuesLoading: false, venues: (result.items || []).map(raw => {
              const venue = present.venue(raw)
              const old = previous[venue.id]
              const mutation = this.favoriteMutations && this.favoriteMutations[venue.id]
              return Object.assign(venue, {
                coverUrl: old && old.coverFileIds[0] === venue.coverFileIds[0] ? old.coverUrl : '',
                favorited: mutation ? mutation.marked : Boolean(old && old.favorited),
                favoriteKnown: Boolean(mutation || old && old.favoriteKnown)
              })
            }) })
          }
          return result
        })
      const favoritePromise = loggedIn && mode === 'matches' && !reuseVenues
        ? venuePromise.then((result) => {
          const venueIds = (result.items || []).map((item) => item.id).filter(Boolean)
          return venueIds.length ? api.favorites.status({ venueIds }) : { markedIds: [] }
        }).catch(() => ({ markedIds: [], loadFailed: true }))
        : Promise.resolve({ items: [], skipped: true })
      let matchPromise = Promise.resolve({ items: [] })
      let coachPromise = Promise.resolve({ items: [] })

      if (mode === 'matches') {
        const matchPayload = { city: '杭州', page, pageSize: MATCH_PAGE_SIZE }
        if (district) matchPayload.district = district
        if (selectedDate) matchPayload.date = selectedDate
        if (ballAgeIndex) matchPayload.expectedBallAge = BALL_AGES[ballAgeIndex]
        if (this.data.friendsOnly) matchPayload.friendsOnly = true
        matchPromise = api.matches.list(matchPayload, readOptions).then(result => {
          if (requestSequence !== this.contentRequestSequence) return result
          const incoming = (result.items || []).map(present.match)
          this.setData({ state: 'ready', refreshing: false, loadingMore: false,
            matches: append ? mergeById(this.data.matches, incoming) : incoming,
            matchesPage: page, matchesHasMore: result.hasMore === true })
          diagnostics.record({ action: 'page.home.ready', durationMs: Date.now() - startedAt })
          this.finishPrimaryLoad(requestSequence, options.manual, true)
          return result
        })
      } else {
        const coachPayload = { city: '杭州', page, pageSize: COACH_PAGE_SIZE }
        if (district) coachPayload.district = district
        coachPromise = api.coaches.list(coachPayload, readOptions).then(result => {
          if (requestSequence !== this.contentRequestSequence) return result
          const venueMap = Object.fromEntries(this.data.venues.map(item => [item.id, item]))
          const incoming = (result.items || []).map(item => Object.assign(present.coach(item, venueMap), { avatarUrl: '' }))
          this.setData({ state: 'ready', refreshing: false, loadingMore: false,
            coaches: append ? mergeById(this.data.coaches, incoming) : incoming,
            coachesPage: page, coachesHasMore: result.hasMore === true })
          diagnostics.record({ action: 'page.home.ready', durationMs: Date.now() - startedAt })
          this.finishPrimaryLoad(requestSequence, options.manual, true)
          return result
        })
      }

      const [venueResult, favoriteResult, matchResult, coachResult] = await Promise.all([
        venuePromise,
        favoritePromise,
        matchPromise,
        coachPromise
      ])
      if (requestSequence !== this.contentRequestSequence) return false

      const previousVenues = Object.fromEntries((this.data.venues || []).map((item) => [item.id, item]))
      const favoriteIds = !loggedIn || favoriteResult.loadFailed || favoriteResult.skipped
        ? null
        : new Set(favoriteResult.markedIds || [])
      const venueMap = {}
      const venueItems = (venueResult.items || []).map((item) => {
        const value = present.venue(item)
        venueMap[value.id] = value
        const mutation = this.favoriteMutations && this.favoriteMutations[value.id]
        const mutationApplies = Boolean(mutation && (
          !favoriteIds
          || !mutation.commitVersion
          || favoriteSnapshotVersion < mutation.commitVersion
        ))
        if (mutation && favoriteIds && !mutationApplies) delete this.favoriteMutations[value.id]
        return Object.assign(value, {
          coverUrl: previousVenues[value.id] && previousVenues[value.id].coverFileIds[0] === value.coverFileIds[0] ? previousVenues[value.id].coverUrl || '' : '',
          favoriteKnown: !loggedIn || mutationApplies || Boolean(favoriteIds) || Boolean(venueResult.reused && previousVenues[value.id] && previousVenues[value.id].favoriteKnown),
          favorited: mutationApplies
            ? mutation.marked
            : favoriteIds
              ? favoriteIds.has(value.id)
              : loggedIn && Boolean(previousVenues[value.id] && previousVenues[value.id].favorited)
        })
      })
      if (loggedIn && favoriteIds) {
        // Keep the server's featured order within each group, while putting
        // the user's marked venues first for faster publishing.
        venueItems.sort((left, right) => Number(Boolean(right.favorited)) - Number(Boolean(left.favorited)))
      }
      const matchVenueMap = Object.assign({}, previousVenues, venueMap)
      const incomingMatches = (matchResult.items || []).map((raw) => {
        const item = present.match(raw)
        const place = matchVenueMap[item.venueId]
        if (!place) return item
        return Object.assign(item, {
          venueName: place.name || item.venueName,
          address: place.address,
          venueLocationText: place.locationText,
          venueActivityTags: place.activityTags,
          location: place.location,
          hasLocation: place.hasLocation
        })
      })
      const previousCoaches = Object.fromEntries((this.data.coaches || []).map((item) => [item.id, item]))
      const incomingCoaches = (coachResult.items || []).map((item) => Object.assign(present.coach(item, venueMap), {
        avatarUrl: previousCoaches[item.id] && previousCoaches[item.id].avatarUrl || ''
      }))
      const matches = mode === 'matches' && append ? mergeById(this.data.matches, incomingMatches) : incomingMatches
      const coaches = mode === 'coaches' && append ? mergeById(this.data.coaches, incomingCoaches) : incomingCoaches
      const displayedVenues = venueResult.loadFailed && !showSkeleton ? this.data.venues : venueItems
      const patch = {
        state: 'ready',
        refreshing: false,
        loadingMore: false,
        paginationError: '',
        venueLoadFailed: venueResult.loadFailed === true,
        venuesLoading: false,
        venues: displayedVenues
      }
      if (mode === 'matches') {
        patch.matches = matches
        patch.matchesPage = page
        patch.matchesHasMore = matchResult.hasMore === true
      } else {
        patch.coaches = coaches
        patch.coachesPage = page
        patch.coachesHasMore = coachResult.hasMore === true
      }
      this.setData(patch)

      if (mode === 'matches' && !this.data.friendsOnly && !append && !venueResult.loadFailed) {
        clientState.saveHomeSnapshot({
          district,
          date: selectedDate,
          ballAge: ballAgeIndex ? BALL_AGES[ballAgeIndex] : '',
          friendsOnly: false
        }, {
          matches,
          venues: displayedVenues,
          matchesHasMore: matchResult.hasMore === true
        })
      }

      const mediaIds = []
      if (!venueResult.reused) venueItems.forEach((item) => {
        if (item.coverFileIds[0]) mediaIds.push(item.coverFileIds[0])
      })
      if (mode === 'coaches') {
        incomingCoaches.forEach((item) => {
          if (item.avatarFileId) mediaIds.push(item.avatarFileId)
        })
      }
      if (!mediaIds.length) return true

      // 文字结果先可操作，图片随后按云函数的 20 个上限分批补齐。
      const mediaUrls = await resolveMediaUrls(mediaIds, readOptions)
      if (requestSequence !== this.contentRequestSequence) return false
      const mediaPatch = {}
      if (!venueResult.loadFailed && !venueResult.reused) {
        const currentVenues = Object.fromEntries((this.data.venues || []).map((item) => [item.id, item]))
        mediaPatch.venues = venueItems.map((item) => Object.assign({}, item, {
          coverUrl: mediaUrls[item.coverFileIds[0]] || '',
          favorited: currentVenues[item.id]
            ? Boolean(currentVenues[item.id].favorited)
            : Boolean(item.favorited),
          favoriteKnown: currentVenues[item.id] ? currentVenues[item.id].favoriteKnown : item.favoriteKnown
        }))
      }
      if (mode === 'coaches') {
        mediaPatch.coaches = coaches.map((item) => Object.assign({}, item, {
          avatarUrl: mediaUrls[item.avatarFileId] || item.avatarUrl || ''
        }))
      }
      this.setData(mediaPatch)
      return true
    } catch (error) {
      if (requestSequence !== this.contentRequestSequence) return false
      this.retryOnReconnect = RECOVERABLE_ERRORS.has(error.code)
      const app = getApp()
      if (SESSION_ERRORS.has(error.code) && app.clearSession) app.clearSession()
      this.finishPrimaryLoad(requestSequence, options.manual, false)
      if (append) {
        this.setData({ loadingMore: false, paginationError: errors.message(error, '更多内容加载失败') })
        return false
      }
      if (!showSkeleton && this.data.state === 'ready' && !ACCESS_ERRORS.has(error.code)) {
        this.setData({ refreshing: false, refreshError: `未能更新，当前显示上次结果。${errors.message(error)}` })
        errors.toast(error, '刷新失败，请稍后重试')
      } else {
        this.setData({ state: 'error', refreshing: false, errorMessage: errors.message(error), loginRequired: error.code === 'LOGIN_REQUIRED' })
      }
      if (this.pendingNetworkRecovery && this.retryOnReconnect && this.visible !== false) {
        this.pendingNetworkRecovery = false
        return this.refreshHome()
      }
      this.pendingNetworkRecovery = false
      return false
    }
  },

  loadMore() {
    return this.loadContent({ append: true })
  },

  retryPagination() {
    return this.loadMore()
  },

  retry() {
    if (this.data.loginRequired) return getApp().openLogin()
    return this.refreshHome()
  },

  switchMode(event) {
    const mode = event.currentTarget.dataset.mode
    if (!['matches', 'players', 'coaches'].includes(mode)) return
    if (mode === this.data.mode) return
    this.finishManualRefresh(false)
    this.setData({ mode }, () => {
      this.savePreferences()
      this.loadContent({ showSkeleton: true })
    })
  },

  changeDistrict(event) {
    const districtIndex = Number(event.detail.value)
    this.setData({ districtIndex, districtLabel: districtIndex ? DISTRICTS[districtIndex] : '' }, () => {
      this.savePreferences()
      this.loadContent({ showSkeleton: true })
    })
  },

  selectDate(event) {
    const selectedDate = event.currentTarget.dataset.value || ''
    if (selectedDate === this.data.selectedDate) return
    this.setData(dateSelection(selectedDate), () => {
      this.savePreferences()
      this.loadContent({ showSkeleton: true })
    })
  },

  changeCustomDate(event) {
    const value = event.detail.value
    if (!dateUtil.dateTab(value) || value < dateUtil.today()) return
    return this.selectDate({ currentTarget: { dataset: { value } } })
  },

  changeBallAge(event) {
    this.setData({ ballAgeIndex: Number(event.detail.value) }, () => {
      this.savePreferences()
      this.loadContent({ showSkeleton: true })
    })
  },

  async toggleFriendsOnly() {
    const next = !this.data.friendsOnly
    if (next && !this.data.loggedIn) {
      try {
        await getApp().ensureSession({ interactive: true })
        if (this.destroyed) return false
        this.setData({ loggedIn: true })
      } catch (error) {
        if (error && error.code !== 'LOGIN_REQUIRED') errors.toast(error, '暂时无法登录，请稍后重试')
        return false
      }
    }
    this.setData({ friendsOnly: next })
    return this.loadContent({ showSkeleton: true })
  },

  expandMatchSearch() {
    // 先放宽日期和球龄，保留用户所在区域；再次放宽才查看全杭州。
    const patch = this.data.friendsOnly
      ? { friendsOnly: false }
      : this.data.selectedDate || this.data.ballAgeIndex
      ? { selectedDate: '', customDateLabel: '', ballAgeIndex: 0 }
      : { districtIndex: 0, districtLabel: '' }
    this.setData(patch)
    this.savePreferences()
    return this.loadContent({ showSkeleton: true })
  },

  expandCoachSearch() {
    this.setData({ districtIndex: 0, districtLabel: '' })
    this.savePreferences()
    return this.loadContent({ showSkeleton: true })
  },

  savePreferences() {
    clientState.saveHomeFilters({
      district: DISTRICTS[this.data.districtIndex],
      date: this.data.selectedDate,
      ballAge: BALL_AGES[this.data.ballAgeIndex]
    })
  },

  openMatch(event) {
    wx.navigateTo({ url: `/pages/match-detail/match-detail?id=${event.currentTarget.dataset.id}` })
  },

  openMatchMap(event) {
    const match = (this.data.matches || []).find((item) => item.id === event.currentTarget.dataset.id)
    if (!match) return false
    const venue = (this.data.venues || []).find((item) => item.id === match.venueId)
    const place = venue || match
    const address = place.address || match.address
    if (!place.hasLocation && !address) {
      wx.showToast({ title: '具体位置请进入球局确认', icon: 'none' })
      return false
    }
    mapHelper.openLocation(place.name || match.venueName, address, place.location || match.location, place.hasLocation || match.hasLocation, {
      copyHint: true,
      noLocationMessage: '暂无地图位置，已为你复制地址',
      failMessage: '地图暂时无法打开，已为你复制地址'
    })
    return true
  },

  openVenue(event) {
    wx.navigateTo({ url: `/pages/venue-detail/venue-detail?id=${event.currentTarget.dataset.id}` })
  },

  openVenueMap(event) {
    const venue = (this.data.venues || []).find((item) => item.id === event.currentTarget.dataset.id)
    if (!venue) return false
    mapHelper.openLocation(venue.name, venue.address, venue.location, venue.hasLocation, {
      copyHint: true,
      noLocationMessage: '该球馆暂无可导航位置',
      failMessage: '地图暂时无法打开，请稍后重试'
    })
    return true
  },

  openVenueCreate() {
    wx.navigateTo({ url: '/pages/venue-create/venue-create' })
  },

  async toggleVenueFavorite(event) {
    const venueId = event.currentTarget.dataset.id
    if (!venueId || this.data.favoriteSavingById[venueId]) return
    const venue = (this.data.venues || []).find((item) => item.id === venueId)
    if (!venue) return
    if (!this.data.loggedIn) {
      this.pendingFavoriteVenueId = venueId
      try {
        await getApp().ensureSession({ interactive: true })
        this.setData({ loggedIn: true })
        return this.resumePendingFavoriteIntent()
      } catch (error) {
        if (error && error.code !== 'LOGIN_REQUIRED') {
          if (this.pendingFavoriteVenueId === venueId) this.pendingFavoriteVenueId = ''
          errors.toast(error, '暂时无法登录，请稍后重试')
        }
        return
      }
    }
    if (venue.favoriteKnown === false) return this.refreshVenueFavorite(venueId)

    const marked = !venue.favorited
    const previousMarked = Boolean(venue.favorited)
    this.favoriteMutations = this.favoriteMutations || Object.create(null)
    const previousMutation = this.favoriteMutations[venueId]
    const token = Number(this.favoriteMutationClock || 0) + 1
    this.favoriteMutationClock = token
    this.favoriteMutations[venueId] = { token, marked, commitVersion: 0 }
    const favoriteSavingById = Object.assign({}, this.data.favoriteSavingById, { [venueId]: true })
    this.setData({
      favoriteSavingById,
      venues: this.data.venues.map((item) => item.id === venueId ? Object.assign({}, item, { favorited: marked }) : item)
    })

    try {
      await api.favorites.set({ venueId, marked })
      const mutation = this.favoriteMutations[venueId]
      if (!mutation || mutation.token !== token) return
      this.favoriteMutationClock = Number(this.favoriteMutationClock || 0) + 1
      mutation.commitVersion = this.favoriteMutationClock
      wx.showToast({ title: marked ? '已标记球馆' : '已取消标记', icon: 'none' })
    } catch (error) {
      const mutation = this.favoriteMutations[venueId]
      if (!mutation || mutation.token !== token) return
      if (previousMutation) this.favoriteMutations[venueId] = previousMutation
      else delete this.favoriteMutations[venueId]
      this.setData({ venues: this.data.venues.map((item) => (
        item.id === venueId ? Object.assign({}, item, { favorited: previousMarked }) : item
      )) })
      errors.toast(error, '标记失败，请重试')
    } finally {
      const mutation = this.favoriteMutations && this.favoriteMutations[venueId]
      if (!mutation || mutation.token === token || previousMutation === mutation) {
        const nextSaving = Object.assign({}, this.data.favoriteSavingById)
        delete nextSaving[venueId]
        this.setData({ favoriteSavingById: nextSaving })
      }
    }
  },

  async refreshVenueFavorite(venueId) {
    const revision = Number(this.favoriteMutationClock || 0)
    this.setData({ favoriteSavingById: Object.assign({}, this.data.favoriteSavingById, { [venueId]: true }) })
    try {
      const result = await api.favorites.status({ venueIds: [venueId] })
      if (revision !== Number(this.favoriteMutationClock || 0)) return { known: false }
      const marked = (result.markedIds || []).includes(venueId)
      const token = this.favoriteMutationClock = revision + 1
      this.favoriteMutations = this.favoriteMutations || Object.create(null)
      this.favoriteMutations[venueId] = { token, marked, commitVersion: token }
      this.setData({ venues: this.data.venues.map(item => item.id === venueId ? Object.assign({}, item, {
        favorited: marked, favoriteKnown: true
      }) : item) })
      return { known: true, marked }
    } catch (error) {
      errors.toast(error, '标记状态暂时无法确认')
      return { known: false }
    }
    finally {
      const saving = Object.assign({}, this.data.favoriteSavingById)
      delete saving[venueId]
      this.setData({ favoriteSavingById: saving })
    }
  },

  async resumePendingFavoriteIntent() {
    const venueId = this.pendingFavoriteVenueId
    if (!venueId) return false
    const app = getApp()
    if (!(app.globalData && app.globalData.session)) {
      this.pendingFavoriteVenueId = ''
      return false
    }

    // Consume before any request. A retry must always come from another user
    // tap, never from a stale intent surviving a timeout or page transition.
    this.pendingFavoriteVenueId = ''
    this.setData({ loggedIn: true })
    const status = await this.refreshVenueFavorite(venueId)
    if (!status || status.known !== true || status.marked) return Boolean(status && status.marked)

    const venue = (this.data.venues || []).find((item) => item.id === venueId)
    if (!venue || venue.favorited || this.data.favoriteSavingById[venueId]) return Boolean(venue && venue.favorited)
    await this.toggleVenueFavorite({ currentTarget: { dataset: { id: venueId } } })
    return true
  },

  openCoach(event) {
    wx.navigateTo({ url: `/pages/coach-detail/coach-detail?id=${event.currentTarget.dataset.id}` })
  },

  openPrimaryAction(event) {
    if (this.data.mode === 'players') {
      return wx.navigateTo({ url: '/pages/availability-edit/availability-edit' })
    }
    return this.openPublish(event)
  },

  openPublish(event = {}) {
    const venueId = event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.id || ''
      : ''
    const hasDraft = typeof clientState.hasPublishDraft === 'function' && clientState.hasPublishDraft()
    if (!venueId && hasDraft) {
      wx.switchTab({ url: '/pages/publish/publish' })
      return
    }
    const carriesMatchFilters = this.data.mode === 'matches' && !hasDraft
    const prefill = { source: 'home', venueId }
    if (carriesMatchFilters) {
      prefill.date = this.data.selectedDate || ''
      prefill.expectedBallAge = BALL_AGES[this.data.ballAgeIndex] || BALL_AGES[0]
    }
    if (!clientState.setPublishPrefill(prefill)) {
      wx.showToast({ title: '暂时无法准备发布内容，请稍后重试', icon: 'none' })
      return
    }
    wx.switchTab({ url: '/pages/publish/publish' })
  },

  onShareAppMessage() {
    const path = this.data.mode === 'matches' ? '/pages/home/home' : `/pages/home/home?mode=${this.data.mode}`
    return share.appMessage({
      title: this.data.mode === 'players' ? '杭州找球友｜搭拍子' : this.data.mode === 'coaches' ? '杭州乒乓球教练预约｜搭拍子' : '杭州乒乓球约球｜搭拍子',
      path
    })
  },

  onShareTimeline() {
    return share.timeline({
      title: this.data.mode === 'players' ? '杭州找球友｜搭拍子' : this.data.mode === 'coaches' ? '杭州乒乓球教练预约｜搭拍子' : '杭州乒乓球约球｜搭拍子',
      params: this.data.mode === 'matches' ? undefined : { mode: this.data.mode }
    })
  }
})
