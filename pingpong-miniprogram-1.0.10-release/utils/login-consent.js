const storage = require('./storage')
const config = require('./cloud-config')
const KEY = 'laiyipai_wechat_login_consent_v1'

function scope() {
  let appId = ''
  try { appId = wx.getAccountInfoSync().miniProgram.appId || '' } catch (_) {}
  return { appId, privacyVersion: config.privacyPolicyVersion, termsVersion: config.termsVersion }
}

// A convenience preference, never proof of identity; every cloud request is authenticated.
function accepted() {
  const saved = storage.read(KEY, null), current = scope()
  return Boolean(saved && Object.keys(current).every(key => saved[key] === current[key]))
}
function remember() { storage.write(KEY, scope()) }
function forget() { storage.remove(KEY) }
module.exports = { accepted, remember, forget }
