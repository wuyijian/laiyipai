const api = require('../../utils/api')
const errors = require('../../utils/error')

const PAGE_SIZE = 30
const DISTRICTS = ['全部区域', '滨江区', '萧山区', '上城区', '西湖区', '拱墅区', '余杭区', '临平区', '钱塘区', '富阳区', '临安区']
const EDIT_DISTRICTS = ['暂不选择'].concat(DISTRICTS.slice(1))
const VERIFICATION_OPTIONS = [
  { label: '未认证 · 已下架', status: 'pending', active: false, certified: false },
  { label: '已认证 · 公开可用', status: 'verified', active: true, certified: true },
  { label: '已认证 · 已下架', status: 'verified', active: false, certified: true },
  { label: '未认证 · 公开可用', status: 'verified', active: true, certified: false }
]

function point(raw = {}) {
  const location = raw.location || {}
  const coordinates = Array.isArray(location.coordinates) ? location.coordinates : []
  return {
    longitude: String(coordinates[0] !== undefined ? coordinates[0] : location.longitude !== undefined ? location.longitude : ''),
    latitude: String(coordinates[1] !== undefined ? coordinates[1] : location.latitude !== undefined ? location.latitude : '')
  }
}

function venueItem(raw = {}) {
  const nameOnly = raw.nameOnly === true || raw.listingMode === 'name_only'
  const coordinates = point(raw)
  const verificationStatus = raw.verificationStatus || (raw.verified ? 'verified' : 'pending')
  const certified = !nameOnly && (raw.verified === undefined ? verificationStatus === 'verified' && !raw.userContributed : raw.verified === true)
  return {
    id: raw.id || raw._id || '',
    name: raw.name || '未命名球馆',
    subtitle: nameOnly ? '名称记录 · 杭州' : (raw.district || raw.address || '杭州'),
    statusLabel: `${certified ? '已认证' : '未认证'} · ${raw.active === false ? '已下架' : '公开可用'}`,
    active: raw.active !== false,
    verified: certified,
    avatarSeed: raw.id || raw.name || 'venue',
    district: raw.district || '', address: raw.address || '', longitude: coordinates.longitude, latitude: coordinates.latitude,
    verificationStatus, verificationDate: raw.verificationDate || '', sourceUrls: raw.sourceUrls || [],
    phone: raw.phone || '', openingHours: raw.openingHours || '', bookingTip: raw.bookingTip || '',
    tags: raw.tags || [], activityTags: raw.activityTags || [], facilityTags: raw.facilityTags || [],
    coverFileIds: raw.coverFileIds || [], featuredRank: Number(raw.featuredRank === undefined ? 9999 : raw.featuredRank)
  }
}

function coachItem(raw = {}) {
  const specialties = Array.isArray(raw.specialty) ? raw.specialty.filter(Boolean) : []
  const venueCount = Array.isArray(raw.venueIds) ? raw.venueIds.length : 0
  return {
    id: raw.id || raw._id || '',
    name: raw.name || '未命名教练',
    subtitle: specialties.length ? specialties.slice(0, 3).join(' · ') : `${venueCount} 家授课球馆`,
    statusLabel: raw.active === true ? '上架中' : '未上架',
    active: raw.active === true,
    avatarFileId: raw.avatarFileId || '',
    avatarSeed: raw.id || raw.name || 'coach'
  }
}

function isOutcomeUnknown(error) {
  return Boolean(error && error.details && error.details.outcomeUnknown) ||
    ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INTERNAL', 'INVALID_SERVER_RESPONSE'].includes(error && error.code)
}

Page({
  data: {
    type: 'venues',
    state: 'loading',
    errorMessage: '',
    items: [],
    page: 1,
    hasMore: false,
    loadingMore: false,
    refreshing: false,
    removingId: '',
    removalError: '',
    skeletonRows: [1, 2, 3]
    ,districts: DISTRICTS, districtIndex: 0,
    editorVisible: false, editingId: '', editForm: {}, editDistricts: EDIT_DISTRICTS, editDistrictIndex: 0, editMore: false,
    verificationOptions: VERIFICATION_OPTIONS, verificationIndex: 0, saving: false, saveError: ''
  },

  onLoad() {
    this.active = true
    this.removeAttempts = Object.create(null)
    if (wx.hideShareMenu) wx.hideShareMenu()
  },

  onShow() {
    this.active = true
    if (!this.loadedOnce || this.reloadOnShow) {
      this.reloadOnShow = false
      return this.load({ preserve: this.data.items.length > 0 })
    }
  },

  onHide() {
    this.active = false
    this.run = Number(this.run || 0) + 1
    this.loading = null
  },

  onUnload() {
    this.destroyed = true
    this.onHide()
  },

  onPullDownRefresh() {
    this.setData({ refreshing: true })
    return this.load({ preserve: true, force: true }).finally(() => {
      if (!this.destroyed) {
        this.setData({ refreshing: false })
        wx.stopPullDownRefresh()
      }
    })
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.load({ append: true })
  },

  switchType(event) {
    const type = event.currentTarget.dataset.type
    if (!['venues', 'coaches'].includes(type) || type === this.data.type || this.data.removingId) return
    this.run = Number(this.run || 0) + 1
    this.loading = null
    this.loadedOnce = false
    this.setData({
      type,
      state: 'loading',
      errorMessage: '',
      removalError: '',
      items: [],
      page: 1,
      hasMore: false,
      loadingMore: false
      ,districtIndex: 0
    })
    return this.load()
  },

  changeDistrictFilter(event) {
    const districtIndex = Number(event.detail.value)
    if (districtIndex === this.data.districtIndex || this.data.removingId) return
    this.loadedOnce = false
    this.setData({ districtIndex, items: [], state: 'loading', errorMessage: '', page: 1, hasMore: false })
    return this.load({ force: true })
  },

  retry() {
    return this.load({ preserve: this.data.items.length > 0, force: true, interactive: true })
  },

  load(options = {}) {
    const append = options.append === true
    if (append && (!this.data.hasMore || this.data.loadingMore)) return Promise.resolve()
    if (!append && this.loading && options.force !== true) return this.loading
    const type = this.data.type
    const page = append ? Number(this.data.page || 1) + 1 : 1
    const run = Number(this.run || 0) + 1
    this.run = run
    this.setData(append
      ? { loadingMore: true, errorMessage: '' }
      : options.preserve && this.data.items.length
        ? { errorMessage: '' }
        : { state: 'loading', errorMessage: '', items: [] })

    const task = (async () => {
      try {
        await getApp().ensureSession({ interactive: options.interactive === true })
        if (run !== this.run || this.active === false) return
        const request = type === 'venues' ? api.admin.listVenues : api.admin.listCoaches
        const payload = { page, pageSize: PAGE_SIZE }
        if (type === 'venues' && this.data.districtIndex > 0) payload.district = DISTRICTS[this.data.districtIndex]
        const result = await request(payload)
        if (run !== this.run || this.active === false || type !== this.data.type) return
        const format = type === 'venues' ? venueItem : coachItem
        const incoming = (result.items || []).map(format).filter((item) => item.id)
        const byId = new Map((append ? this.data.items : []).map((item) => [item.id, item]))
        incoming.forEach((item) => byId.set(item.id, item))
        this.loadedOnce = true
        this.setData({
          state: 'ready',
          items: Array.from(byId.values()),
          page: Number(result.page || page),
          hasMore: result.hasMore === true,
          loadingMore: false,
          errorMessage: ''
        })
      } catch (error) {
        if (run !== this.run || this.active === false) return
        const forbidden = error && error.code === 'FORBIDDEN'
        this.setData({
          state: forbidden ? 'forbidden' : (this.data.items.length ? 'ready' : 'error'),
          errorMessage: forbidden ? '当前账号没有内容管理权限。' : errors.message(error, '列表暂时无法加载'),
          loadingMore: false,
          hasMore: forbidden ? false : this.data.hasMore
        })
      }
    })()
    if (!append) this.loading = task
    return task.finally(() => {
      if (!append && this.loading === task) this.loading = null
      if (!this.destroyed && run === this.run) this.setData({ loadingMore: false })
    })
  },

  openVenueEditor(event) {
    if (this.data.type !== 'venues' || this.data.removingId) return
    const item = this.data.items.find(candidate => candidate.id === event.currentTarget.dataset.id)
    if (!item) return
    const verificationIndex = item.verified ? (item.active ? 1 : 2) : item.active ? 3 : 0
    this.setData({
      editorVisible: true, editingId: item.id, saving: false, saveError: '', editMore: false,
      editDistrictIndex: Math.max(0, EDIT_DISTRICTS.indexOf(item.district)),
      verificationIndex,
      editForm: {
        name: item.name, address: item.address, longitude: item.longitude, latitude: item.latitude,
        verificationDate: item.verificationDate, sourceUrl: (item.sourceUrls || [])[0] || '', sourceUrls: item.sourceUrls,
        phone: item.phone, openingHours: item.openingHours, bookingTip: item.bookingTip,
        tags: item.tags, activityTags: item.activityTags, facilityTags: item.facilityTags,
        coverFileIds: item.coverFileIds, featuredRank: item.featuredRank
      }
    })
  },

  closeVenueEditor() { if (!this.data.saving) this.setData({ editorVisible: false, saveError: '' }) },
  toggleEditMore() { if (!this.data.saving) this.setData({ editMore: !this.data.editMore }) },
  noop() {},
  changeEditField(event) {
    if (this.data.saving) return
    const field = event.currentTarget.dataset.field
    if (!['name', 'address', 'longitude', 'latitude', 'verificationDate', 'sourceUrl', 'phone', 'openingHours', 'bookingTip'].includes(field)) return
    const value = String(event.detail.value || '')
    const editForm = Object.assign({}, this.data.editForm, { [field]: value })
    if (field === 'address' && value !== this.data.editForm.address) Object.assign(editForm, { longitude: '', latitude: '' })
    this.setData({ editForm, saveError: '' })
  },
  changeEditDistrict(event) { if (!this.data.saving) this.setData({ editDistrictIndex: Number(event.detail.value), saveError: '' }) },
  changeVerification(event) { if (!this.data.saving) this.setData({ verificationIndex: Number(event.detail.value), saveError: '' }) },

  async saveVenue() {
    if (this.data.saving) return
    const form = this.data.editForm || {}
    const verification = VERIFICATION_OPTIONS[this.data.verificationIndex]
    if (!verification) return
    const address = String(form.address || '').trim()
    const hasLongitude = String(form.longitude || '').trim() !== ''
    const hasLatitude = String(form.latitude || '').trim() !== ''
    const longitude = Number(form.longitude)
    const latitude = Number(form.latitude)
    if (!String(form.name || '').trim()) return this.setData({ saveError: '请填写球馆名称' })
    if (verification.certified && address.length < 4) return this.setData({ saveError: '认证前请补充完整球馆地址（至少 4 个字）' })
    if (address && (address.length < 4 || address.length > 120)) return this.setData({ saveError: '请填写 4—120 个字的完整地址' })
    if (hasLongitude !== hasLatitude || (hasLongitude && (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90))) return this.setData({ saveError: '经纬度请正确填写一对，或都留空' })
    const sourceUrl = String(form.sourceUrl || '').trim()
    if (sourceUrl && !/^https:\/\//i.test(sourceUrl)) return this.setData({ saveError: '选填的资料来源需以 https:// 开头' })
    this.setData({ saving: true, saveError: '' })
    try {
      await api.admin.upsertVenue({
        venueId: this.data.editingId, listingMode: address ? 'full' : 'name_only', name: form.name.trim(), city: '杭州',
        district: this.data.editDistrictIndex > 0 ? EDIT_DISTRICTS[this.data.editDistrictIndex] : '', address,
        longitude: hasLongitude ? longitude : undefined, latitude: hasLatitude ? latitude : undefined,
        phone: form.phone || '', openingHours: form.openingHours || '', bookingTip: form.bookingTip || '',
        tags: form.tags || [], activityTags: form.activityTags || [], facilityTags: form.facilityTags || [],
        coverFileIds: form.coverFileIds || [], featuredRank: Number(form.featuredRank === undefined ? 9999 : form.featuredRank),
        verificationStatus: verification.status, active: verification.active,
        adminVerified: verification.certified,
        verificationDate: verification.certified ? form.verificationDate : '',
        sourceUrls: (sourceUrl ? [sourceUrl] : []).concat((form.sourceUrls || []).slice(1))
      }, { retry: false })
      this.setData({ editorVisible: false, saving: false })
      await this.load({ preserve: true, force: true })
      wx.showToast({ title: '球馆资料已更新', icon: 'success' })
    } catch (error) {
      this.setData({ saving: false, saveError: errors.message(error, '保存失败，请重试') })
    }
  },

  requestRemove(event) {
    if (this.data.removingId) return Promise.resolve(false)
    const id = event.currentTarget.dataset.id
    const item = this.data.items.find((candidate) => candidate.id === id)
    if (!item) return Promise.resolve(false)
    const isVenue = this.data.type === 'venues'
    return new Promise((resolve) => {
      wx.showModal({
        title: `删除${isVenue ? '球馆' : '教练'}？`,
        content: isVenue
          ? `「${item.name}」将立即从球馆列表下架，不能再用于新球局或新预约；历史记录保留。`
          : `「${item.name}」将立即停止展示和接受新预约；历史预约保留。`,
        confirmText: '确认删除',
        confirmColor: '#b24336',
        success: (result) => {
          if (!result.confirm) return resolve(false)
          Promise.resolve(this.performRemove(item)).then(resolve, () => resolve(false))
        },
        fail: () => resolve(false)
      })
    })
  },

  async performRemove(item) {
    const type = this.data.type
    const key = `${type}:${item.id}`
    const attempt = this.removeAttempts[key] || {
      type,
      id: item.id,
      requestId: api.createRequestId()
    }
    this.removeAttempts[key] = attempt
    this.setData({ removingId: item.id, removalError: '' })
    try {
      const payload = type === 'venues'
        ? { venueId: item.id, reason: '管理员在内容管理页删除' }
        : { coachId: item.id, reason: '管理员在内容管理页删除' }
      const request = type === 'venues' ? api.admin.removeVenue : api.admin.removeCoach
      await request(payload, { requestId: attempt.requestId, retry: false })
      delete this.removeAttempts[key]
      if (this.destroyed) return true
      if (type === this.data.type) {
        this.setData({ items: this.data.items.filter((candidate) => candidate.id !== item.id), removalError: '' })
      } else {
        this.reloadOnShow = true
      }
      wx.showToast({ title: '已删除', icon: 'success' })
      return true
    } catch (error) {
      if (this.destroyed) return false
      const unknown = isOutcomeUnknown(error)
      if (!unknown) delete this.removeAttempts[key]
      this.setData({
        removalError: unknown
          ? '删除结果尚未确认，请再次点击同一条记录安全重试。'
          : errors.message(error, '删除失败，请重试')
      })
      return false
    } finally {
      if (!this.destroyed && this.data.removingId === item.id) this.setData({ removingId: '' })
    }
  }
})
