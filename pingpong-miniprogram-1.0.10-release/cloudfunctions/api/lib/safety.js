const { COLLECTIONS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const { stableId, getDocument } = require('./database')
const { checkText } = require('./moderation')
const { writeAudit } = require('./audit')

async function userByPublicId(context, playerId) {
  const result = await context.db.collection(COLLECTIONS.users).where({ publicId: playerId }).limit(1).get()
  return result.data[0] || null
}

async function setBlock(context, payload) {
  const playerId = validate.id(payload.playerId, '球友 ID')
  const blocked = validate.boolean(payload.blocked, '拉黑状态')
  const target = await userByPublicId(context, playerId)
  assert(target && target.status !== 'deleted', 'NOT_FOUND', '球友不存在')
  assert(target._id !== context.openid, 'INVALID_ARGUMENT', '不能拉黑自己')
  const id = stableId('user-block', context.openid, target._id)
  const ref = context.db.collection(COLLECTIONS.userBlocks).doc(id)
  const existing = await getDocument(ref)
  if (!existing) {
    await ref.set({ data: {
      userId: context.openid,
      targetUserId: target._id,
      targetPublicId: playerId,
      active: blocked,
      createdAt: context.serverDate(),
      updatedAt: context.serverDate()
    } })
  } else {
    await ref.update({ data: { active: blocked, updatedAt: context.serverDate() } })
  }
  await writeAudit(context, 'safety.block', 'user', playerId, { blocked })
  return { playerId, blocked }
}

async function listBlocks(context) {
  const result = await context.db.collection(COLLECTIONS.userBlocks)
    .where({ userId: context.openid, active: true })
    .orderBy('updatedAt', 'desc')
    .limit(100)
    .get()
  const ids = result.data.map((item) => item.targetUserId)
  let users = []
  if (ids.length) {
    const groups = []
    for (let index = 0; index < ids.length; index += 20) groups.push(ids.slice(index, index + 20))
    const results = await Promise.all(groups.map((group) => context.db.collection(COLLECTIONS.users).where({ _id: context.command.in(group) }).get()))
    users = results.flatMap((item) => item.data)
  }
  const byId = Object.fromEntries(users.map((item) => [item._id, item]))
  return {
    items: result.data.map((block) => {
      const user = byId[block.targetUserId]
      return {
        playerId: block.targetPublicId,
        nickname: user && user.profile && user.profile.nickname || '球友',
        avatarFileId: user && user.profile && user.profile.avatarFileId || '',
        blockedAt: block.updatedAt
      }
    })
  }
}

async function report(context, payload) {
  const targetType = validate.oneOf(payload.targetType, ['player', 'match', 'message', 'venue', 'coach'], '举报对象')
  const targetId = validate.id(payload.targetId, '举报对象 ID')
  const category = validate.oneOf(payload.category, ['harassment', 'fraud', 'unsafe_content', 'no_show', 'false_information', 'other'], '举报类型')
  const details = validate.text(payload.details || '', '补充说明', { required: category !== 'other', max: 300 })
  await checkText(context, [details], 2)
  const reportId = stableId('report', context.openid, validate.id(context.requestId, '请求 ID'))
  const ref = context.db.collection(COLLECTIONS.reports).doc(reportId)
  const existing = await getDocument(ref)
  if (!existing) {
    await ref.set({ data: {
      reporterId: context.openid,
      targetType,
      targetId,
      category,
      details,
      status: 'open',
      requestId: context.requestId,
      createdAt: context.serverDate(),
      updatedAt: context.serverDate()
    } })
  }
  await writeAudit(context, 'safety.report', targetType, targetId, { category })
  return { reportId, status: 'open', idempotent: Boolean(existing) }
}

async function deleteAccount(context, payload) {
  assert(payload.confirmation === '注销账号', 'INVALID_ARGUMENT', '请输入“注销账号”确认')
  const jobId = stableId('account-deletion', context.openid)
  const existingJob = await getDocument(context.db.collection(COLLECTIONS.accountDeletionJobs).doc(jobId))
  if (context.user.status === 'deleted' && existingJob) {
    return { status: 'deleted', cleanupJobId: jobId, idempotent: true }
  }
  let idempotent = false
  await context.db.runTransaction(async (transaction) => {
    const userRef = transaction.collection(COLLECTIONS.users).doc(context.openid)
    const user = await getDocument(userRef)
    assert(user, 'ACCOUNT_CLOSED', '账号当前无法注销')
    if (user.status === 'deleted') {
      idempotent = true
      return
    }
    assert(['active', 'suspended'].includes(user.status), 'ACCOUNT_CLOSED', '账号当前无法注销')
    const legacyVideoFileIds = Array.isArray(user.profile && user.profile.videoFileIds)
      ? user.profile.videoFileIds.filter((fileId) => typeof fileId === 'string' && /^cloud:\/\//.test(fileId)).slice(0, 100)
      : []
    await transaction.collection(COLLECTIONS.accountDeletionJobs).doc(jobId).set({ data: {
      userId: context.openid,
      legacyVideoFileIds,
      status: 'pending',
      attempts: 0,
      requestedAt: context.serverDate(),
      updatedAt: context.serverDate()
    } })
    await userRef.update({ data: {
      status: 'deleted',
      publicId: `deleted_${stableId(context.openid).slice(0, 20)}`,
      profile: {
        nickname: '已注销用户', avatarFileId: '', city: '', district: '', ballAge: '', skills: [],
        ratingPlatform: '未填写', ratingValue: '', videoFileIds: []
      },
      unionId: '',
      deletedAt: context.serverDate(),
      updatedAt: context.serverDate()
    } })
  })
  await writeAudit(context, 'account.delete', 'user', 'self', {})
  return { status: 'deleted', cleanupJobId: jobId, idempotent }
}

module.exports = { listBlocks, setBlock, report, deleteAccount }
