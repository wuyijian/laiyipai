const { COLLECTIONS } = require('./constants')
const validate = require('./validate')
const presenters = require('./presenters')
const { writeAudit } = require('./audit')
const { checkText } = require('./moderation')
const { getDocument } = require('./database')
const { assert } = require('./errors')

async function get(context) {
  return presenters.userProfile(context.user)
}

async function update(context, payload) {
  const patch = validate.profilePatch(payload)
  await checkText(context, [patch.nickname, patch.city, patch.district, patch.ballAge, patch.availability && patch.availability.note].concat(patch.skills || []), 1)
  const saved = await context.db.runTransaction(async transaction => {
    const ref = transaction.collection(COLLECTIONS.users).doc(context.openid)
    const user = await getDocument(ref)
    assert(user && user.status !== 'deleted', 'ACCOUNT_DELETED', '账号已注销')
    assert(user.status === 'active', 'ACCOUNT_SUSPENDED', '账号已暂停使用')
    const changes = Object.assign({}, patch)
    if (changes.availability) changes.availability = await require('./availability').prepare(
      Object.assign({}, context, { db: transaction }), changes.availability)
    // Authentication may predate another edit or location opt-out. Merge only
    // the submitted fields against the latest transaction snapshot.
    const previous = user.profile || {}
    const profile = Object.assign({}, previous, changes)
    if (profile.ratingPlatform === '未填写' && profile.ratingValue) {
      changes.ratingValue = profile.ratingValue = ''
    }
    assert(!profile.ratingPlatform || profile.ratingPlatform === '未填写' || profile.ratingValue,
      'INVALID_ARGUMENT', '选择积分平台后请填写积分')
    if (profile.ratingValue !== previous.ratingValue || profile.ratingPlatform !== previous.ratingPlatform) {
      changes.ratingUpdatedAt = profile.ratingUpdatedAt = context.serverDate()
    }
    const data = { updatedAt: context.serverDate() }
    Object.entries(changes).forEach(([key, value]) => {
      // Replace nested settings, so disabling a status removes its old plan
      // and disabling discovery cannot retain an old coordinate subfield.
      data['profile.' + key] = value && typeof value === 'object' && !Array.isArray(value) && key !== 'ratingUpdatedAt'
        ? context.command.set(value) : value
    })
    await ref.update({ data })
    return Object.assign({}, user, { profile })
  })
  await writeAudit(context, 'profile.update', 'user', 'self', { fields: Object.keys(patch) })
  return presenters.userProfile(saved)
}

module.exports = { get, update }
