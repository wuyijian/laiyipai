const assert = require('assert')
const fs = require('fs')
const path = require('path')
const api = require('../utils/api')

let definition
global.Page = value => { definition = value }
global.getApp = () => ({ globalData: { session: { profile: { playerId: 'player_1' } } }, ensureSession: async () => ({}) })
global.wx = { showToast() {} }
const pagePath = require.resolve('../pages/venue-detail/venue-detail')
delete require.cache[pagePath]
require(pagePath)

function createPage() {
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  page.setData = patch => Object.entries(patch).forEach(([key, value]) => {
    const parts = key.split('.')
    let target = page.data
    while (parts.length > 1) { const part = parts.shift(); target = target[part] || (target[part] = {}) }
    target[parts[0]] = value
  })
  page.data.id = 'venue_1'
  page.data.venue = { id: 'venue_1' }
  page.data.loggedIn = true
  page.venueLoadVersion = 1
  return page
}

async function run() {
  let writes = 0
  api.venueReviews.list = async () => ({
    summary: { count: 1, average: 4, tags: [{ tag: '干净整洁', count: 1 }] },
    items: [{ id: 'review_1', rating: 4, tags: ['干净整洁'], customText: '球台不错', author: { displayName: '球友' } }],
    mine: null
  })
  api.venueReviews.upsert = async payload => { writes++; assert.strictEqual(payload.rating, 5); return { review: Object.assign({ id: 'review_1', author: { displayName: '我' } }, payload), summary: { count: 1, average: 5 } } }
  const page = createPage()
  await page.loadVenueReviews({ publicRead: true })
  assert.strictEqual(page.data.reviewSummary.averageText, '4.0')
  assert.strictEqual(page.data.reviews[0].ratingText, '★★★★☆')
  await page.openReviewEditor()
  page.selectReviewRating({ currentTarget: { dataset: { rating: 5 } } })
  page.toggleReviewTag({ currentTarget: { dataset: { tag: '高手多' } } })
  page.onReviewText({ detail: { value: '空间宽敞' } })
  await page.submitReview()
  assert.strictEqual(writes, 1)
  assert.strictEqual(page.data.reviewEditorVisible, false)
  const template = fs.readFileSync(path.join(__dirname, '../pages/venue-detail/venue-detail.wxml'), 'utf8')
  assert(template.includes('球友评分') && template.includes('补充一点真实体验'))
  console.log('venue-review-client-tests-ok')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
