const { variant } = require('../../utils/avatar')

Component({
  properties: {
    src: { type: String, value: '' },
    seed: { type: String, value: '' },
    size: { type: Number, value: 80 },
    label: { type: String, value: '球友头像' }
  },
  data: { palette: variant(''), imageFailed: false },
  observers: {
    seed(seed) { this.setData({ palette: variant(seed) }) },
    src() { this.setData({ imageFailed: false }) }
  },
  methods: {
    onImageError() { this.setData({ imageFailed: true }) }
  }
})
