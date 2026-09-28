const { definition } = require('../../utils/player-directory')
const { data, onShow, onHide, onUnload, onPullDownRefresh, ...methods } = definition

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { compact: { type: Boolean, value: false } },
  data,
  lifetimes: {
    attached() { this.activate() },
    detached() { onHide.call(this) }
  },
  pageLifetimes: {
    show() { this.activate() },
    hide() { onHide.call(this) }
  },
  methods: Object.assign({}, methods, {
    activate() {
      if (this.active) return
      return onShow.call(this)
    },
    refresh() {
      if (!this.active) return this.activate()
      return this.load(false)
    }
  })
})
