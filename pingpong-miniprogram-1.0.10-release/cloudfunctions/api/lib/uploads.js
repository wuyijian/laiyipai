const { COLLECTIONS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const { stableId, getDocument } = require('./database')

const EXTENSIONS = {
  avatar: ['jpg', 'jpeg', 'png']
}

async function prepare(context, payload) {
  assert(!['video', 'venue_photo'].includes(payload.purpose), 'FEATURE_DISABLED', '比赛视频和场馆照片上传已停用')
  const purpose = validate.oneOf(payload.purpose, ['avatar'], '上传用途')
  const venueId = ''
  const extension = validate.oneOf(String(payload.extension || '').toLowerCase(), EXTENSIONS[purpose], '文件扩展名')
  const token = stableId('upload-ticket', context.openid, purpose, context.requestId)
  const directory = 'user-avatars'
  const cloudPath = `${directory}/${new Date().toISOString().slice(0, 10)}/${token}.${extension}`
  const ref = context.db.collection(COLLECTIONS.uploadTickets).doc(token)
  const existing = await getDocument(ref)
  assert(!existing || (existing.venueId || '') === venueId, 'UPLOAD_TICKET_INVALID', '上传凭证与球馆不匹配')
  const expiresAt = existing && existing.expiresAt || new Date(Date.now() + 15 * 60 * 1000)
  if (!existing) {
    await ref.set({ data: {
      userId: context.openid,
      purpose,
      venueId,
      cloudPath,
      consumed: false,
      requestId: context.requestId,
      expiresAt,
      createdAt: context.serverDate()
    } })
  }
  return { uploadToken: token, cloudPath, expiresAt: new Date(expiresAt).toISOString() }
}

async function claim(context, uploadToken, purpose, fileId, venueId = '') {
  const token = validate.id(uploadToken, '上传凭证')
  await context.db.runTransaction(async (transaction) => {
    const ref = transaction.collection(COLLECTIONS.uploadTickets).doc(token)
    const ticket = await getDocument(ref)
    assert(ticket && ticket.userId === context.openid, 'UPLOAD_TICKET_INVALID', '上传凭证无效')
    assert(ticket.purpose === purpose, 'UPLOAD_TICKET_INVALID', '上传凭证用途不匹配')
    assert((ticket.venueId || '') === venueId, 'UPLOAD_TICKET_INVALID', '上传凭证与球馆不匹配')
    assert(new Date(ticket.expiresAt).getTime() > Date.now(), 'UPLOAD_TICKET_EXPIRED', '上传凭证已过期，请重新上传')
    assert(String(fileId).endsWith(`/${ticket.cloudPath}`), 'UPLOAD_TICKET_INVALID', '文件路径与上传凭证不匹配')
    if (ticket.consumed) {
      assert(ticket.consumedRequestId === context.requestId, 'UPLOAD_TICKET_USED', '上传凭证已使用')
      return
    }
    await ref.update({ data: {
      consumed: true,
      consumedRequestId: context.requestId,
      consumedAt: context.serverDate()
    } })
  })
  return token
}

module.exports = { prepare, claim }
