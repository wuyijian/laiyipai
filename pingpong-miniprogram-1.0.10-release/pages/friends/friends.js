const api = require('../../utils/api')
const errors = require('../../utils/error')

const PAGE_SIZE = 20

function presentFriend(raw = {}, avatarUrl = '') {
  const player = raw.player || {}
  const skills = Array.isArray(player.skills) ? player.skills.slice(0, 3) : []
  const locationText = [player.city || '杭州', player.district].filter(Boolean).join(' · ')
  const ballAge = player.ballAge && player.ballAge !== '未填写' ? player.ballAge : ''
  const matchCount = Math.max(1, Number(raw.matchCount || 1))
  return {
    playerId: player.playerId || '',
    displayName: player.displayName || '球友',
    avatarFileId: player.avatarFileId || '',
    avatarUrl,
    metaText: [locationText, ballAge].filter(Boolean).join(' · '),
    skills,
    matchCount,
    relationshipText: matchCount > 1 ? `一起打过 ${matchCount} 场` : '因共同球局成为球友'
  }
}

Page({
  data: {
    state: 'loading',
    errorMessage: '',
    items: [],
    page: 0,
    hasMore: false,
    loadingMore: false
  },

  onLoad() { this.active = true },

  onShow() {
    this.active = true
    return this.loadFriends({ reset: true, keepContent: this.data.state === 'ready' })
  },

  onHide() {
    this.active = false
    this.loadSequence = Number(this.loadSequence || 0) + 1
  },

  onUnload() { this.onHide() },

  onPullDownRefresh() {
    return Promise.resolve(this.loadFriends({ reset: true, keepContent: true, fresh: true, interactive: true }))
      .finally(() => wx.stopPullDownRefresh())
  },

  async resolveAvatars(records) {
    const fileIds = Array.from(new Set(records.map(item => item && item.avatarFileId).filter(Boolean)))
    if (!fileIds.length) return {}
    try { return (await api.files.resolve(fileIds)).urls || {} } catch (_) { return {} }
  },

  async loadFriends(options = {}) {
    const reset = options.reset !== false
    if (this.loading && !options.fresh) return this.loading
    const page = reset ? 1 : this.data.page + 1
    const sequence = this.loadSequence = Number(this.loadSequence || 0) + 1
    if (options.fresh && api.invalidateReads) api.invalidateReads()
    this.setData(reset
      ? options.keepContent
        ? { errorMessage: '', loadingMore: false }
        : { state: 'loading', errorMessage: '', items: [], loadingMore: false }
      : { loadingMore: true, errorMessage: '' })
    const task = (async () => {
      try {
        await getApp().ensureSession({ interactive: options.interactive === true })
        const result = await api.friends.list({ page, pageSize: PAGE_SIZE })
        const rawItems = result.items || []
        const urls = await this.resolveAvatars(rawItems.map(item => item.player || {}))
        if (!this.active || sequence !== this.loadSequence) return false
        const incoming = rawItems.map(item => presentFriend(item, urls[item.player && item.player.avatarFileId] || ''))
        this.setData({
          state: 'ready',
          items: reset ? incoming : this.data.items.concat(incoming),
          page: Number(result.page || page),
          hasMore: result.hasMore === true,
          loadingMore: false,
          errorMessage: ''
        })
        return true
      } catch (error) {
        if (!this.active || sequence !== this.loadSequence) return false
        const message = errors.message(error, '球友列表暂未更新')
        if ((!reset || options.keepContent) && this.data.items.length) {
          this.setData({ state: 'ready', loadingMore: false, errorMessage: message })
        } else {
          this.setData({ state: 'error', loadingMore: false, errorMessage: message })
        }
        return false
      }
    })()
    this.loading = task
    try { return await task } finally { if (this.loading === task) this.loading = null }
  },

  loadMore() {
    if (!this.data.loadingMore && this.data.hasMore) return this.loadFriends({ reset: false })
    return false
  },

  retry() { return this.loadFriends({ reset: true, interactive: true }) },

  openPlayer(event) {
    const playerId = event.currentTarget.dataset.id
    if (playerId) wx.navigateTo({ url: `/pages/player-detail/player-detail?id=${encodeURIComponent(playerId)}` })
  },

  goHome() { wx.switchTab({ url: '/pages/home/home' }) }
})

module.exports = { presentFriend }
