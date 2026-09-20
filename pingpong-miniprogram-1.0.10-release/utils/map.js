const geo = require('./geo')

const LABELS = {
  noLocation: '暂无地图位置，请在聊天中确认',
  noLocationVenue: '该球馆暂无可导航位置',
  openLocationFailed: '地图暂时无法打开，请稍后重试'
}

function normalizeAddress(name, address) {
  const source = [name, address].filter(Boolean).join(' ')
  return source.trim()
}

function copyAddress(address, fallback) {
  const target = String(address || '').trim()
  if (!target) {
    wx.showToast({ title: fallback || LABELS.noLocation, icon: 'none' })
    return
  }
  wx.setClipboardData({
    data: target,
    success: () => wx.showToast({ title: '已复制到粘贴板', icon: 'none' }),
    fail: () => wx.showToast({ title: fallback || LABELS.noLocation, icon: 'none' })
  })
}

function openLocation(name = '', address = '', location = null, hasLocation = false, options = {}) {
  const failMessage = String(options.failMessage || LABELS.openLocationFailed)
  const noLocationMessage = String(options.noLocationMessage || LABELS.noLocation)
  const copyHint = !!options.copyHint
  const copyTarget = String(address || '').trim() || ''
  const point = geo.normalizePoint(location)

  if (!hasLocation || !point) {
    if (copyHint) copyAddress(copyTarget, noLocationMessage)
    else wx.showToast({ title: noLocationMessage, icon: 'none' })
    return
  }
  wx.openLocation({
    latitude: point.latitude,
    longitude: point.longitude,
    name: name || '球馆',
    address,
    scale: 16,
    fail: () => {
      if (copyHint) {
        copyAddress(copyTarget, failMessage)
      } else {
        wx.showToast({ title: failMessage, icon: 'none' })
      }
    }
  })
}

module.exports = { openLocation, copyAddress, normalizeAddress }
