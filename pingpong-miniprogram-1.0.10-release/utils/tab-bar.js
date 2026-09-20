const TAB_ITEMS = [
  { pagePath: 'pages/home/home', text: '首页', icon: 'home' },
  { pagePath: 'pages/publish/publish', text: '发起', icon: 'publish' },
  { pagePath: 'pages/orders/orders', text: '预约', icon: 'orders' },
  { pagePath: 'pages/profile/profile', text: '我的', icon: 'profile' }
]

function normalizeRoute(value) {
  return String(value || '').replace(/^\//, '').split(/[?#]/)[0]
}

function indexForRoute(route) {
  const normalized = normalizeRoute(route)
  return TAB_ITEMS.findIndex(item => item.pagePath === normalized)
}

function sync(page, route) {
  const selected = indexForRoute(route)
  if (selected < 0 || !page || typeof page.getTabBar !== 'function') return false
  const apply = () => {
    const component = page.getTabBar()
    if (!component || typeof component.setData !== 'function') return false
    if (!component.data || component.data.selected !== selected) component.setData({ selected })
    return true
  }
  if (apply()) return true
  if (typeof wx !== 'undefined' && wx && typeof wx.nextTick === 'function') wx.nextTick(apply)
  return false
}

module.exports = {
  TAB_ITEMS,
  indexForRoute,
  normalizeRoute,
  sync
}
