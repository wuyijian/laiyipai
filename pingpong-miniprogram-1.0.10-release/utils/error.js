const DEFAULT_MESSAGE = '服务暂时不可用，请稍后重试'

function message(error, fallback = DEFAULT_MESSAGE) {
  if (!error) return fallback
  return error.userMessage || error.message || error.errMsg || fallback
}

function toast(error, fallback) {
  wx.showToast({ title: message(error, fallback), icon: 'none', duration: 2600 })
}

module.exports = { DEFAULT_MESSAGE, message, toast }
