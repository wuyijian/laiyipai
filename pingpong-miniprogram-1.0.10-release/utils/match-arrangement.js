function text(match = {}) {
  return [
    '搭拍子 · 约球安排',
    match.title ? `球局：${match.title}` : '',
    match.district ? `行政区：${match.district}` : '',
    `时间：${match.date || match.dateLabel || '待确认'} ${match.startTime || ''}—${match.endTime || ''}`,
    `球馆：${match.venueName || '待确认'}`,
    `地址：${match.address || '未填写，请与发起人确认'}`,
    `预计每人：${match.feeText || '待确认'}`,
    `球台：${match.courtStatusText || '请与发起人确认'}`,
    match.courtBookingNote ? `球台说明：${match.courtBookingNote}` : '',
    match.note ? `见面备注：${match.note}` : '',
    '加入球局不等于预订球台；以小程序内最新安排为准。'
  ].filter(Boolean).join('\n')
}

module.exports = { text }
