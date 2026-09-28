const privacy = require('./privacy')
const geo = require('./geo')

// Call only from an explicit user action; the search caller keeps it in memory; sharing requires a separate explicit save.
async function locate(isActive = () => true) {
  if (typeof wx.getFuzzyLocation !== 'function' || (typeof wx.canIUse === 'function' && !wx.canIUse('getFuzzyLocation'))) {
    throw Object.assign(new Error('当前微信版本不支持模糊定位，请升级微信，或继续浏览球友列表'), { code: 'LOCATION_UNSUPPORTED' })
  }
  await privacy.authorize()
  if (!isActive()) throw Object.assign(new Error('已取消查找'), { code: 'LOCATION_CANCELLED' })
  return new Promise((resolve, reject) => {
    wx.getFuzzyLocation({
      type: 'gcj02',
      success(value) {
        const point = geo.normalizePoint(value)
        if (point) resolve(point)
        else reject(new Error('未能获取有效位置，请重新定位'))
      },
      fail(error) {
        const message = error.errMsg || ''
        const systemDenied = /system permission|system.*denied/i.test(message)
        const denied = !systemDenied && /auth deny|auth denied|authorize.*deny|permission denied/i.test(message)
        reject(Object.assign(new Error(denied
          ? '尚未允许模糊定位，可前往设置开启，或继续浏览球友列表'
          : systemDenied ? '手机未允许微信使用位置，请在系统设置中开启微信的位置权限'
          : '模糊定位失败，请检查手机定位服务与网络后重试'), { code: denied ? 'LOCATION_DENIED' : 'LOCATION_FAILED' }))
      }
    })
  })
}

function fuzzyDistanceText(distanceMeters) {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return ''
  return distanceMeters < 1000 ? '约 1 公里内' : `约 ${Math.round(distanceMeters / 1000)} 公里`
}

module.exports = { locate, fuzzyDistanceText }
