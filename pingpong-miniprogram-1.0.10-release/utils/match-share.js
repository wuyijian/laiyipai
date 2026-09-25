// Recruitment cards use public arrangement fields only, never chat/user data.
function details(match = {}) {
  return {
    title: String(match.title || '').trim() || '一起打球',
    district: String(match.district || '').trim(),
    city: String(match.city || '').trim() || '杭州',
    date: match.date || match.dateLabel || '日期待确认',
    time: [match.startTime, match.endTime].filter(Boolean).join(' — ') || '时间待确认',
    venue: match.venueName || '球馆待确认',
    address: String(match.address || '').trim() || '地址待确认，请与发起人确认',
    footer: Number(match.seats) > 0 ? `还差 ${match.seats} 人 · 查看球局` : '查看球局与名额'
  }
}

function title(match = {}) {
  const info = details(match)
  return `${info.district || info.city}｜${info.title}｜${info.date} ${info.time}｜${info.venue}｜${info.address}`
}

function lines(context, text, width, limit) {
  const result = []
  let line = ''
  for (const character of Array.from(String(text))) {
    if (line && context.measureText(line + character).width > width) {
      result.push(line)
      line = ''
    }
    line += character
  }
  if (line) result.push(line)
  if (result.length > limit) {
    let last = result[limit - 1]
    while (last && context.measureText(last + '…').width > width) last = Array.from(last).slice(0, -1).join('')
    result[limit - 1] = last + '…'
  }
  return result.slice(0, limit)
}

function draw(canvas, match) {
  canvas.width = 1000
  canvas.height = 800
  const ctx = canvas.getContext('2d')
  ctx.scale(2, 2)
  const info = details(match)
  ctx.fillStyle = '#f5f7f3'
  ctx.fillRect(0, 0, 500, 400)
  ctx.fillStyle = '#125c48'
  ctx.fillRect(0, 0, 500, 8)
  ctx.font = '22px sans-serif'
  ctx.fillText(info.district ? `${info.city} · ${info.district}` : `${info.city} · 行政区待确认`, 28, 44)
  ctx.textAlign = 'right'
  ctx.font = '20px sans-serif'
  ctx.fillText('搭拍子', 472, 44)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#14251e'
  ctx.font = 'bold 30px sans-serif'
  lines(ctx, info.title, 444, 2).forEach((line, index) => ctx.fillText(line, 28, 91 + index * 37))
  ctx.fillStyle = '#125c48'
  ctx.font = '21px sans-serif'
  ctx.fillText(info.date, 28, 166)
  ctx.font = 'bold 32px sans-serif'
  ctx.fillText(info.time, 28, 205)
  ctx.fillStyle = '#14251e'
  ctx.font = 'bold 24px sans-serif'
  lines(ctx, info.venue, 444, 1).forEach((line) => ctx.fillText(line, 28, 251))
  ctx.fillStyle = '#58645f'
  ctx.font = '21px sans-serif'
  lines(ctx, info.address, 444, 2).forEach((line, index) => ctx.fillText(line, 28, 287 + index * 27))
  ctx.fillStyle = '#125c48'
  ctx.fillRect(0, 346, 500, 54)
  ctx.fillStyle = '#ffffff'
  ctx.font = '23px sans-serif'
  ctx.fillText(info.footer, 28, 381)
}

function render(page, match) {
  if (typeof wx.createSelectorQuery !== 'function' || typeof wx.canvasToTempFilePath !== 'function') return Promise.resolve('')
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value || '') } }
    const timer = setTimeout(() => finish(''), 2000)
    try {
      wx.createSelectorQuery().in(page).select('#match-share-canvas').fields({ node: true, size: true }).exec((result) => {
        if (settled) return
        const canvas = result && result[0] && result[0].node
        if (!canvas) return finish('')
        try {
          draw(canvas, match)
          wx.canvasToTempFilePath({ canvas, fileType: 'png', success: (value) => finish(value.tempFilePath), fail: () => finish('') }, page)
        } catch (_) { finish('') }
      })
    } catch (_) { finish('') }
  })
}

module.exports = { details, title, lines, draw, render }
