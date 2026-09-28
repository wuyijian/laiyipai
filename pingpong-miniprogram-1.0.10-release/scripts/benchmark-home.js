// Reproducible bridge-payload comparison; does not measure device frame time.
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { execFileSync } = require('child_process')
const root = path.resolve(__dirname, '..')
const filename = path.join(root, 'pages/home/home.js')
const relative = path.relative(path.resolve(root, '..'), filename).split(path.sep).join('/')
const baselineRef = process.argv[2] || 'master'
const baseline = execFileSync('git', ['show', `${baselineRef}:${relative}`], { cwd: root, encoding: 'utf8' })
const current = fs.readFileSync(filename, 'utf8')
const venues = Array.from({ length: 30 }, (_, i) => ({
  id: `venue_${i}`, name: `球馆 ${i}`, address: `体育路 ${i} 号`, district: '西湖区',
  location: { longitude: 120 + i / 100, latitude: 30 }, coverFileIds: []
}))

async function measure(source) {
  let definition
  const samples = []
  const api = {
    venues: { list: async () => ({ items: venues }) },
    favorites: { status: async () => ({ markedIds: [] }) },
    matches: { list: async ({ page }) => ({
      items: Array.from({ length: 50 }, (_, i) => ({
        id: `match_${page}_${i}`, title: `一起练球 ${i}`, venueId: venues[i % 30].id,
        venue: { name: venues[i % 30].name }, participantCount: 1, capacity: 4
      })), hasMore: true
    }) },
    coaches: { list: async () => ({ items: [] }) },
    files: { resolve: async () => ({ urls: {} }) }
  }
  vm.runInNewContext(source, {
    Page(value) { definition = value }, setTimeout, clearTimeout,
    getApp: () => ({ globalData: { session: { profile: { playerId: 'benchmark' } } } }),
    wx: { showShareMenu() {}, hideShareMenu() {} },
    require(name) {
      if (name === '../../utils/api') return api
      if (name === '../../utils/client-state') return {
        getHomeFilters: () => ({}), getHomeSnapshot: () => null, saveHomeSnapshot() {}
      }
      return require(path.resolve(path.dirname(filename), name))
    }
  }, { filename })
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  const patches = []
  page.setData = (patch, callback) => {
    patches.push({ bytes: Buffer.byteLength(JSON.stringify(patch)), matches: Boolean(patch.matches) })
    Object.assign(page.data, patch)
    if (callback) callback()
  }
  // Avoid lifecycle-only setup; both revisions start with identical page data.
  for (const [scenario, options] of [['cold', {}], ['unchanged refresh', {}], ['next page', { append: true }]]) {
    patches.length = 0
    await page.loadContent(options)
    samples.push({ scenario, calls: patches.length, bytes: patches.reduce((sum, item) => sum + item.bytes, 0), listWrites: patches.filter(item => item.matches).length })
  }
  return samples
}
;(async () => {
  const before = await measure(baseline)
  const after = await measure(current)
  console.log(JSON.stringify({ baseline: baselineRef, fixture: '50 matches/page, 30 venues, no media', before, after }, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })
