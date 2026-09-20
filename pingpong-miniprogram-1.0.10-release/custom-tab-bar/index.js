const { TAB_ITEMS, indexForRoute } = require('../utils/tab-bar')
const messageNotifier = require('../utils/message-notifier')

Component({
  data: {
    selected: -1,
    list: TAB_ITEMS,
    messageUnreadCount: 0,
    messageBadgeText: ''
  },

  lifetimes: {
    attached() {
      this.unsubscribeMessages = messageNotifier.subscribe((state) => {
        const count = Math.max(0, Number(state && state.unreadCount || 0))
        this.setData({ messageUnreadCount: count, messageBadgeText: count > 99 ? '99+' : String(count || '') })
      })
      this.syncSelected()
    },

    ready() {
      this.syncSelected()
    },

    detached() {
      if (this.unsubscribeMessages) this.unsubscribeMessages()
      this.unsubscribeMessages = null
    }
  },

  pageLifetimes: {
    show() {
      this.syncSelected()
    }
  },

  methods: {
    syncSelected() {
      const pages = getCurrentPages()
      const page = pages[pages.length - 1]

      if (!page) return

      const route = page.route || page.__route__ || ''
      const selected = indexForRoute(route)

      if (selected >= 0 && selected !== this.data.selected) {
        this.setData({ selected })
      }
    },

    onTabTap(event) {
      const index = Number(event.currentTarget.dataset.index)
      const item = TAB_ITEMS[index]

      if (!item || this._switching) return

      if (index === this.data.selected) {
        wx.pageScrollTo({
          scrollTop: 0,
          duration: 220
        })
        return
      }

      const previous = this.data.selected
      this._switching = true
      this.setData({ selected: index })

      wx.switchTab({
        url: `/${item.pagePath}`,
        fail: () => {
          this.setData({ selected: previous })
        },
        complete: () => {
          this._switching = false
        }
      })
    }
  }
})
