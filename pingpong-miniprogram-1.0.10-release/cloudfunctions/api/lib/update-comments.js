const { COLLECTIONS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const presenters = require('./presenters')
const { stableId, getDocument } = require('./database')
const { checkText } = require('./moderation')
const friendUpdates = require('./friend-updates')
const { writeAudit } = require('./audit')

function commentId(userId, requestId) {
  return stableId('player-update-comment', userId, requestId)
}

function presentComment(document, actorId) {
  const author = document.authorSnapshot || {}
  return {
    id: document._id || '',
    updateId: document.updateId || '',
    author: {
      playerId: author.playerId || '',
      displayName: author.displayName || '球友',
      avatarFileId: author.avatarFileId || ''
    },
    content: document.content || '',
    mine: Boolean(actorId && document.userId === actorId),
    createdAt: document.createdAt
  }
}

async function list(context, payload) {
  const updateId = validate.id(payload.updateId, '动态 ID')
  const update = await friendUpdates.get(context, { updateId })
  const paging = validate.pagination(payload)
  const [result, blocked] = await Promise.all([
    context.db.collection(COLLECTIONS.updateComments)
      .where({ updateId, deleted: false })
      .orderBy('createdAt', 'asc')
      .skip((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize + 1)
      .get(),
    friendUpdates._private.blockedUserIds(context)
  ])
  const visible = (result.data || []).filter(item => !blocked.has(item.userId))
  return {
    update,
    items: visible.slice(0, paging.pageSize).map(item => presentComment(item, context.openid)),
    page: paging.page,
    pageSize: paging.pageSize,
    hasMore: (result.data || []).length > paging.pageSize
  }
}

async function send(context, payload) {
  const updateId = validate.id(payload.updateId, '动态 ID')
  const content = validate.text(payload.content, '回复内容', { min: 1, max: 300 })
  await checkText(context, [content], 2)
  await friendUpdates.get(context, { updateId })
  const id = commentId(context.openid, validate.id(context.requestId, '请求 ID'))
  const profile = presenters.userProfile(context.user)
  let idempotent = false
  let saved = null
  await context.db.runTransaction(async transaction => {
    const commentRef = transaction.collection(COLLECTIONS.updateComments).doc(id)
    const existing = await getDocument(commentRef)
    if (existing) {
      idempotent = true
      saved = Object.assign({ _id: id }, existing)
      return
    }
    const updateRef = transaction.collection(COLLECTIONS.playerUpdates).doc(updateId)
    const update = await getDocument(updateRef)
    assert(friendUpdates._private.visibleActive(update), 'NOT_FOUND', '动态不存在或已撤下')
    saved = {
      _id: id,
      updateId,
      updateOwnerId: update.userId,
      userId: context.openid,
      authorSnapshot: {
        playerId: profile.playerId,
        displayName: profile.nickname,
        avatarFileId: profile.avatarFileId
      },
      content,
      deleted: false,
      requestId: context.requestId,
      createdAt: context.serverDate(),
      updatedAt: context.serverDate()
    }
    const stored = Object.assign({}, saved)
    delete stored._id
    await commentRef.set({ data: stored })
    await updateRef.update({ data: {
      commentCount: Number(update.commentCount || 0) + 1,
      updatedAt: context.serverDate()
    } })
  })
  if (!idempotent) await writeAudit(context, 'updateComments.send', 'player_update', updateId, { commentId: id })
  return Object.assign(presentComment(saved, context.openid), { idempotent })
}

module.exports = { list, send, _private: { commentId, presentComment } }
