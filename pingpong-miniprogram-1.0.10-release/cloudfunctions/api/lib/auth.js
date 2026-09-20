const { COLLECTIONS } = require('./constants')
const { ApiError, assert } = require('./errors')
const { getDocument } = require('./database')
const { randomId } = require('./database')
const presenters = require('./presenters')

const DEFAULT_PRIVACY_VERSION = '2026-09-13'
const DEFAULT_COMPAT_PRIVACY_VERSIONS = ['2026-09-04']

function privacyVersion() {
  return String(process.env.LAIYIPAI_PRIVACY_POLICY_VERSION || DEFAULT_PRIVACY_VERSION)
}

function compatiblePrivacyVersions() {
  const explicitlyConfigured = Object.prototype.hasOwnProperty.call(process.env, 'LAIYIPAI_COMPAT_PRIVACY_VERSIONS')
  const source = explicitlyConfigured
    ? String(process.env.LAIYIPAI_COMPAT_PRIVACY_VERSIONS || '').split(',')
    : DEFAULT_COMPAT_PRIVACY_VERSIONS
  const current = privacyVersion()
  return Array.from(new Set(source
    .map((item) => String(item).trim())
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item) && item !== current)))
}

function acceptsPrivacyVersion(value) {
  return value === privacyVersion() || compatiblePrivacyVersions().includes(value)
}

function newUserDocument(wxContext, now, consentVersion) {
  return {
    publicId: randomId('player'),
    appId: wxContext.APPID || '',
    role: 'player',
    status: 'active',
    profile: {
      nickname: '新球友',
      avatarFileId: '',
      city: '杭州',
      district: '',
      ballAge: '未填写',
      skills: [],
      ratingPlatform: '未填写',
      ratingValue: ''
    },
    completedMatches: 0,
    punctualityRate: 100,
    consentVersion,
    consentAcceptedAt: now,
    loginProvider: 'wechat',
    createdAt: now,
    updatedAt: now
  }
}

// A public reader still has a trusted, app-scoped WeChat OPENID. Bind it for
// rate limiting, but deliberately do not read, create or update a users
// document and do not inspect consent.
function attachPublicIdentity(context) {
  const openid = context.wxContext && context.wxContext.OPENID
  assert(openid, 'UNAUTHENTICATED', '登录状态无效，请重新进入小程序')
  context.openid = openid
  // Public routes deliberately keep guest semantics even when this OPENID
  // already owns an account. Callers cannot opt themselves into private data.
  context.publicRead = true
  return openid
}

async function requireIdentity(context, options = {}) {
  const openid = context.wxContext && context.wxContext.OPENID
  assert(openid, 'UNAUTHENTICATED', '登录状态无效，请重新进入小程序')
  context.openid = openid

  const ref = context.db.collection(COLLECTIONS.users).doc(openid)
  let user = await getDocument(ref)
  if (!user) {
    assert(options.allowCreate, 'BOOTSTRAP_REQUIRED', '请先完成登录初始化')
    assert(options.consentAccepted === true, 'CONSENT_REQUIRED', '请先阅读并同意隐私保护指引')
    assert(acceptsPrivacyVersion(options.consentVersion), 'CONSENT_VERSION_MISMATCH', '当前小程序版本过旧，请更新后重新登录', {
      requiredVersion: privacyVersion()
    })
    // Two devices or a retry must never overwrite an existing account/profile.
    user = await context.db.runTransaction(async transaction => {
      const userRef = transaction.collection(COLLECTIONS.users).doc(openid)
      const existing = await getDocument(userRef)
      if (existing) return existing
      const document = newUserDocument(context.wxContext, context.serverDate(), options.consentVersion)
      await userRef.set({ data: document })
      return document
    })
  }
  if (!user) throw new ApiError('INTERNAL', '用户初始化失败')
  assert(!user.appId || user.appId === context.wxContext.APPID, 'UNAUTHENTICATED', '微信账号所属小程序不匹配，请检查环境绑定')
  if (!options.allowClosed) {
    assert(user.status !== 'suspended', 'ACCOUNT_SUSPENDED', '账号已暂停使用')
    assert(user.status !== 'deleted', 'ACCOUNT_DELETED', '账号已注销')
  }
  if (!options.allowCreate && !options.skipConsentCheck) {
    assert(acceptsPrivacyVersion(user.consentVersion), 'CONSENT_REQUIRED', '隐私保护指引已更新，请重新确认', {
      requiredVersion: privacyVersion()
    })
  }
  if (!user.publicId) {
    user.publicId = randomId('player')
    await ref.update({ data: { publicId: user.publicId, updatedAt: context.serverDate() } })
  }
  context.user = Object.assign({ _id: openid }, user)
  return context.user
}

async function bootstrap(context, payload) {
  const consentVersion = typeof payload.consentVersion === 'string' ? payload.consentVersion.slice(0, 40) : ''
  if (consentVersion || !acceptsPrivacyVersion(context.user.consentVersion)) {
    assert(payload.consentAccepted === true, 'CONSENT_REQUIRED', '请先阅读并同意最新隐私保护指引')
    assert(acceptsPrivacyVersion(consentVersion), 'CONSENT_VERSION_MISMATCH', '当前小程序版本过旧，请更新后重新登录', {
      requiredVersion: privacyVersion()
    })
  }
  const patch = { updatedAt: context.serverDate(), lastLoginAt: context.serverDate(), loginProvider: 'wechat' }
  if (consentVersion &&
      context.user.consentVersion !== consentVersion &&
      context.user.consentVersion !== privacyVersion()) {
    patch.consentVersion = consentVersion
    patch.consentAcceptedAt = context.serverDate()
  }
  await context.db.collection(COLLECTIONS.users).doc(context.openid).update({ data: patch })
  return {
    authentication: { provider: 'wechat', authenticated: true },
    profile: presenters.userProfile(Object.assign({}, context.user, patch)),
    capabilities: {
      cloudStorage: true,
      videoUpload: false,
      venuePhotoUpload: false,
      matchChat: true,
      coachBooking: true,
      payments: false,
      // This is only an entry-point hint for the current signed-in user. Every
      // admin route still calls requireAdmin and must never trust this value
      // when it comes back from a client.
      adminVenueReview: isAdmin(context),
      adminCoachReview: isAdmin(context)
    },
    policies: {
      coachCancellationHours: Number(process.env.LAIYIPAI_COACH_CANCEL_HOURS || 12),
      matchCancellationText: '不能到场请尽早取消；退出后名额会立即释放，频繁临时取消可能影响守约记录。',
      chatCloseAfterHours: 24
    },
    serverTime: new Date().toISOString()
  }
}

function adminAllowlist() {
  return String(process.env.LAIYIPAI_ADMIN_OPENIDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function isAdmin(context, user = context && context.user) {
  if (!context || !context.openid) return false
  return Boolean(user && user.role === 'admin') || adminAllowlist().includes(context.openid)
}

function requireAdmin(context, user) {
  assert(isAdmin(context, user), 'FORBIDDEN', '需要运营管理员权限')
}

module.exports = {
  attachPublicIdentity,
  requireIdentity,
  bootstrap,
  requireAdmin,
  isAdmin,
  privacyVersion,
  compatiblePrivacyVersions,
  acceptsPrivacyVersion
}
