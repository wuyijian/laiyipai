Page({
  onPullDownRefresh() {
    const panel = this.selectComponent('#directory-panel')
    return Promise.resolve(panel && panel.refresh()).finally(() => wx.stopPullDownRefresh())
  }
})
