Component({
  properties: { summary: { type: Object, value: null } },
  data: { expanded: false },
  methods: { toggle() { this.setData({ expanded: !this.data.expanded }) } }
})
