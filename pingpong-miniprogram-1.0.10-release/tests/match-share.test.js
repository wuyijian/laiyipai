const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const path = require('path')
const cards = require('../utils/match-share')
const share = require('../utils/share')

async function run() {
  assert.strictEqual(share.appMessage().title, '搭拍子')
  assert.strictEqual(share.timeline().title, '搭拍子')
  const fixture = { id: 'test_match', city: '杭州', district: '滨江区', title: '1500分左右，随便打打', date: '2030-01-02', startTime: '19:00', endTime: '21:00', venueName: '测试球馆', address: '测试地址，仅供自动化验证', seats: 2, shareable: true }
  const payload = share.appMessage({ title: cards.title(fixture), titleLimit: 128, path: '/pages/match-detail/match-detail?id=test_match', imageUrl: 'wxfile://tmp/card.png' })
  assert(payload.title.includes('2030-01-02 19:00 — 21:00'))
  assert(payload.title.includes(fixture.address))
  assert(payload.title.startsWith('滨江区｜1500分左右，随便打打｜'))
  const arrangement = require('../utils/match-arrangement').text(fixture)
  assert(arrangement.includes(`球局：${fixture.title}`) && arrangement.includes('行政区：滨江区'))
  assert.strictEqual(cards.details({}).district, '', '未知地区不猜测')
  assert(!cards.title({}).includes('分'), '不得推断或虚构积分')
  assert(share.appMessage({ title: cards.title(Object.assign({}, fixture, { address: '地址'.repeat(100) })), titleLimit: 128 }).title.startsWith(`滨江区｜${fixture.title}｜`), '长地址不能挤掉标题和行政区')
  assert.strictEqual(payload.imageUrl, 'wxfile://tmp/card.png')
  assert.strictEqual(share.appMessage({ imageUrl: 'http://example.com/untrusted.png' }).imageUrl, undefined)
  assert(cards.details({}).address.includes('地址待确认'))
  const texts = []
  const ctx = { scale() {}, fillRect() {}, measureText: (value) => ({ width: Array.from(value).length * 23 }), fillText: (value, x, y) => texts.push({ value, x, y }) }
  const canvas = { getContext: () => ctx }
  cards.draw(canvas, fixture)
  assert(texts.some((item) => item.value === '搭拍子'))
  assert(texts.some((item) => item.value === '杭州 · 滨江区'))
  assert(texts.some((item) => item.value === fixture.title))
  assert.strictEqual(canvas.width / canvas.height, 1.25)
  assert(texts.some((item) => item.value === '19:00 — 21:00'))
  assert(texts.some((item) => item.value === fixture.venueName))
  assert(texts.some((item) => item.value === fixture.address))
  const wrapped = cards.lines(ctx, '非常长的详细地址'.repeat(30), 444, 3)
  assert.strictEqual(wrapped.length, 3)
  assert(wrapped[2].endsWith('…'))
  assert(wrapped.every((line) => ctx.measureText(line).width <= 444))
  texts.length = 0
  cards.draw(canvas, Object.assign({}, fixture, { title: '长标题'.repeat(10), venueName: '球馆'.repeat(30), address: '地址'.repeat(60) }))
  assert(texts.filter((item) => item.y >= 91 && item.y <= 128).length <= 2)
  assert(texts.filter((item) => item.y >= 287 && item.y <= 314).length <= 2)
  assert(!texts.some((item) => item.y > 314 && item.y < 381), '正文不可覆盖底部人数栏')

  global.wx = {
    createSelectorQuery: () => ({ in() { return this }, select() { return this }, fields() { return this }, exec(callback) { callback([{ node: canvas }]) } }),
    canvasToTempFilePath(options) { options.success({ tempFilePath: 'wxfile://tmp/card.png' }) }
  }
  assert.strictEqual(await cards.render({}, fixture), 'wxfile://tmp/card.png')
  wx.canvasToTempFilePath = (options) => options.fail(new Error('canvas unavailable'))
  assert.strictEqual(await cards.render({}, fixture), '', '失败返回文字分享，不阻断分享流程')

  const root = path.resolve(__dirname, '..')
  const source = fs.readFileSync(path.join(root, 'pages/match-detail/match-detail.js'), 'utf8')
  let definition
  const renders = []
  const jobs = []
  const fakeCards = Object.assign({}, cards, { render: async (_, match) => {
    renders.push(match)
    return new Promise((resolve) => jobs.push(resolve))
  } })
  vm.runInNewContext(source, {
    Page: (value) => { definition = value },
    require: (name) => name.endsWith('/match-share') ? fakeCards : name.endsWith('/share') ? share : {},
    wx, getApp: () => ({})
  })
  const page = Object.assign({}, definition, { data: { id: fixture.id, match: fixture } })
  const earlyShare = page.onShareAppMessage()
  await Promise.resolve()
  assert(earlyShare.promise)
  assert(earlyShare.title.includes(fixture.address), '即刻点击也必须有文字安排')
  jobs[0]('wxfile://tmp/old.png')
  assert.strictEqual((await earlyShare.promise).imageUrl, 'wxfile://tmp/old.png')
  const updated = Object.assign({}, fixture, { address: '修改后的地址', startTime: '20:00' })
  page.data.match = updated
  const pending = page.prepareShareCard()
  assert.strictEqual(page.shareCardImage, '', '改期或换馆后立即作废旧图')
  await Promise.resolve()
  jobs[1]('wxfile://tmp/new.png')
  await pending
  const finalShare = page.onShareAppMessage()
  assert.strictEqual(finalShare.imageUrl, 'wxfile://tmp/new.png')
  assert(finalShare.title.includes('20:00'))
  assert(finalShare.title.includes('修改后的地址'))
  assert.strictEqual(renders.length, 2, '相同安排复用分享图，不重复绘制')
  for (const patch of [{ title: '开球网1800分左右切磋' }, { district: '萧山区' }]) {
    page.data.match = Object.assign({}, page.data.match, patch)
    const change = page.prepareShareCard()
    assert.strictEqual(page.shareCardImage, '', '仅标题或地区变化也应作废旧图')
    await Promise.resolve()
    jobs[jobs.length - 1]('wxfile://tmp/changed.png')
    await change
  }
  assert.strictEqual(renders.length, 4)
  assert(page.onShareTimeline().title.startsWith('萧山区｜开球网1800分左右切磋｜'))
  assert(page.onShareTimeline().title.includes('20:00'))
  console.log('match share card tests passed')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
