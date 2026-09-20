const { assert } = require('./errors')

const DEFAULT_TERMS_VERSION = '2026-09-13'
const DEFAULT_COMPAT_TERMS_VERSIONS = ['2026-09-01']

function currentVersion() {
  return String(process.env.LAIYIPAI_TERMS_VERSION || DEFAULT_TERMS_VERSION)
}

function compatibleVersions() {
  const explicitlyConfigured = Object.prototype.hasOwnProperty.call(process.env, 'LAIYIPAI_COMPAT_TERMS_VERSIONS')
  const source = explicitlyConfigured
    ? String(process.env.LAIYIPAI_COMPAT_TERMS_VERSIONS || '').split(',')
    : DEFAULT_COMPAT_TERMS_VERSIONS
  const current = currentVersion()
  return Array.from(new Set(source
    .map((item) => String(item).trim())
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item) && item !== current)))
}

function acceptsVersion(value) {
  return value === currentVersion() || compatibleVersions().includes(value)
}

function requireAcceptance(payload) {
  assert(payload.termsAccepted === true, 'TERMS_REQUIRED', '请先阅读并同意用户协议')
  assert(acceptsVersion(payload.termsVersion), 'TERMS_VERSION_MISMATCH', '用户协议已更新，请重新阅读并同意', {
    requiredVersion: currentVersion()
  })
  return payload.termsVersion
}

module.exports = { currentVersion, compatibleVersions, acceptsVersion, requireAcceptance }
