const { COLLECTIONS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')

async function blockedAvatarOwnerIds(context, avatarDocuments) {
  if (!context.openid) return new Set()
  const ownerIds = Array.from(new Set((avatarDocuments || [])
    .map((item) => item && item._id)
    .filter((userId) => userId && userId !== context.openid)))
  if (!ownerIds.length) return new Set()
  const [outgoing, incoming] = await Promise.all([
    context.db.collection(COLLECTIONS.userBlocks).where({
      userId: context.openid,
      active: true
    }).limit(100).get(),
    context.db.collection(COLLECTIONS.userBlocks).where({
      targetUserId: context.openid,
      active: true
    }).limit(100).get()
  ])
  const relevant = new Set(ownerIds)
  return new Set((outgoing.data || []).map((item) => item.targetUserId)
    .concat((incoming.data || []).map((item) => item.userId))
    .filter((userId) => relevant.has(userId)))
}

async function resolve(context, payload) {
  assert(Array.isArray(payload.fileIds), 'INVALID_ARGUMENT', 'fileIds 格式不正确')
  const fileIds = Array.from(new Set(payload.fileIds.map((item) => validate.text(item, '文件 ID', { min: 10, max: 500 }))))
  assert(fileIds.length > 0 && fileIds.length <= 20, 'INVALID_ARGUMENT', '每次可解析 1—20 个文件')
  fileIds.forEach((fileId) => assert(/^cloud:\/\//.test(fileId), 'INVALID_ARGUMENT', '文件 ID 格式不正确'))
  const candidate = context.command.in(fileIds)
  const ownMedia = context.openid && !context.publicRead
    ? context.db.collection(COLLECTIONS.userMedia).where({ userId: context.openid, status: 'passed', deleted: context.command.neq(true), fileId: candidate }).limit(20).get()
    : Promise.resolve({ data: [] })
  const [venueResult, coachResult, avatarResult, ownMediaResult, venuePhotoResult] = await Promise.all([
    context.db.collection(COLLECTIONS.venues).where({ active: true, verificationStatus: 'verified', coverFileIds: candidate }).limit(20).get(),
    context.db.collection(COLLECTIONS.coaches).where({ active: true, verificationStatus: 'verified', avatarFileId: candidate }).limit(20).get(),
    context.db.collection(COLLECTIONS.users).where({ status: 'active', 'profile.avatarFileId': candidate }).limit(20).get(),
    ownMedia,
    context.db.collection(COLLECTIONS.venues).where({ active: true, verificationStatus: 'verified', photoFileIds: candidate }).limit(20).get()
  ])
  const blockedAvatarOwners = await blockedAvatarOwnerIds(context, avatarResult.data)
  const allowed = new Set()
  venueResult.data.forEach((item) => (item.coverFileIds || []).forEach((fileId) => allowed.add(fileId)))
  venuePhotoResult.data.forEach((item) => (item.photoFileIds || []).forEach((fileId) => allowed.add(fileId)))
  coachResult.data.forEach((item) => allowed.add(item.avatarFileId))
  avatarResult.data
    .filter((item) => !blockedAvatarOwners.has(item._id))
    .forEach((item) => allowed.add(item.profile && item.profile.avatarFileId))
  ownMediaResult.data.forEach((item) => allowed.add(item.fileId))
  const authorized = fileIds.filter((fileId) => allowed.has(fileId))
  if (!authorized.length) return { urls: {}, unresolved: fileIds }
  const result = await context.cloud.getTempFileURL({ fileList: authorized })
  const urls = {}
  ;(result.fileList || []).forEach((item) => {
    if (!item.status && item.tempFileURL) urls[item.fileID] = item.tempFileURL
  })
  return { urls, unresolved: fileIds.filter((fileId) => !urls[fileId]) }
}

module.exports = { resolve }
