const MENUS = ['shareAppMessage', 'shareTimeline']

function callMenu(method) {
  if (typeof wx === 'undefined' || typeof wx[method] !== 'function') return
  try {
    wx[method]({
      menus: MENUS,
      fail() {
        // 低版本或不支持朋友圈的终端保留微信默认行为，不打断页面使用。
      }
    })
  } catch (_) {}
}

function enable() {
  callMenu('showShareMenu')
}

function disable() {
  callMenu('hideShareMenu')
}

function cleanTitle(value, fallback = '搭拍子', limit = 32) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim() || fallback
  return Array.from(normalized).slice(0, limit).join('')
}

function query(params = {}) {
  return Object.keys(params).sort().filter((key) => {
    const value = params[key]
    return value !== undefined && value !== null && String(value).length > 0
  }).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`).join('&')
}

function approvedImageUrl(value) {
  const imageUrl = String(value || '').trim()
  return /^https:\/\//i.test(imageUrl) ? imageUrl : ''
}

function timeline({ title, params, imageUrl, titleLimit = 32 } = {}) {
  const payload = { title: cleanTitle(title, '搭拍子', titleLimit) }
  const encodedQuery = query(params)
  const approvedImage = approvedImageUrl(imageUrl)
  if (encodedQuery) payload.query = encodedQuery
  if (approvedImage) payload.imageUrl = approvedImage
  return payload
}

function appMessage({ title, path, imageUrl, titleLimit = 32 } = {}) {
  const payload = { title: cleanTitle(title, '搭拍子', titleLimit) }
  if (typeof path === 'string' && /^\/pages\//.test(path)) payload.path = path
  const approvedImage = approvedImageUrl(imageUrl) || (/^(?:wxfile:\/\/|http:\/\/tmp\/|\/tmp\/)/.test(String(imageUrl || '')) ? imageUrl : '')
  if (approvedImage) payload.imageUrl = approvedImage
  return payload
}

module.exports = { MENUS, enable, disable, query, timeline, appMessage }
