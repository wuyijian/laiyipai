const { COLLECTIONS } = require('./constants')
const { assert, ApiError } = require('./errors')
const validate = require('./validate')
const { getDocument } = require('./database')
const { writeAudit } = require('./audit')

function present(document) {
  return {
    id: document._id,
    status: document.status,
    rejectionReason: document.status === 'rejected' ? document.rejectionReason || '内容未通过审核' : '',
    createdAt: document.createdAt
  }
}

async function list(context) {
  const result = await context.db.collection(COLLECTIONS.userVideos)
    .where({ userId: context.openid, deleted: context.command.neq(true) })
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get()
  return { items: result.data.map(present) }
}

// Keep a tombstone response for older clients; existing videos are untouched.
async function register() {
  throw new ApiError('FEATURE_DISABLED', '比赛视频上传已停用')
}

async function remove(context, payload) {
  const videoId = validate.id(payload.videoId, '视频 ID')
  const ref = context.db.collection(COLLECTIONS.userVideos).doc(videoId)
  const video = await getDocument(ref)
  assert(video && video.userId === context.openid, 'NOT_FOUND', '视频不存在')
  if (video.deleted && video.deletionRequestId === context.requestId) return { videoId, deleted: true, idempotent: true }
  assert(!video.deleted, 'NOT_FOUND', '视频不存在')
  await ref.update({ data: {
    deleted: true,
    status: 'deleted',
    deletionRequestId: context.requestId,
    deletedAt: context.serverDate(),
    updatedAt: context.serverDate()
  } })
  try {
    await context.cloud.deleteFile({ fileList: [video.fileId] })
  } catch (error) {
    console.error('VIDEO_FILE_DELETE_FAILED', context.requestId, error)
  }
  await writeAudit(context, 'videos.remove', 'video', videoId, {})
  return { videoId, deleted: true, idempotent: false }
}

module.exports = { list, register, remove }
