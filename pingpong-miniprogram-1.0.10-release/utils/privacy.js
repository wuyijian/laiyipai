function authorize() {
  if (typeof wx.requirePrivacyAuthorize !== 'function') return Promise.resolve()
  return new Promise((resolve, reject) => {
    wx.requirePrivacyAuthorize({
      success: resolve,
      fail: () => reject(new Error('需要同意隐私保护指引后才能使用此功能'))
    })
  })
}

function openContract() {
  if (typeof wx.openPrivacyContract !== 'function') {
    wx.showToast({ title: '请在微信客户端中查看隐私保护指引', icon: 'none' })
    return
  }
  wx.openPrivacyContract({
    fail: () => wx.showToast({ title: '暂时无法打开隐私保护指引', icon: 'none' })
  })
}

module.exports = { authorize, openContract }
