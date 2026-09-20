const { COLLECTIONS } = require('./constants')
const validate = require('./validate')
const presenters = require('./presenters')
const { writeAudit } = require('./audit')
const { checkText } = require('./moderation')

async function get(context) {
  return presenters.userProfile(context.user)
}

async function update(context, payload) {
  const patch = validate.profilePatch(payload)
  await checkText(context, [patch.nickname, patch.city, patch.district, patch.ballAge].concat(patch.skills || []), 1)
  const profile = Object.assign({}, context.user.profile || {}, patch)
  if (profile.ratingPlatform !== '未填写' && !profile.ratingValue) {
    const { ApiError } = require('./errors')
    throw new ApiError('INVALID_ARGUMENT', '选择积分平台后请填写积分')
  }
  await context.db.collection(COLLECTIONS.users).doc(context.openid).update({
    data: { profile, updatedAt: context.serverDate() }
  })
  await writeAudit(context, 'profile.update', 'user', 'self', { fields: Object.keys(patch) })
  return presenters.userProfile(Object.assign({}, context.user, { profile }))
}

module.exports = { get, update }
