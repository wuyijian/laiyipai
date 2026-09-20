const assert = require('assert')
const path = require('path')

const configPath = path.resolve(__dirname, '..', 'utils', 'cloud-config.js')

function resolveWith(mockWx) {
  const previous = global.wx
  global.wx = mockWx
  delete require.cache[require.resolve(configPath)]
  const config = require(configPath)
  const value = config.resolveCloudEnvId()
  global.wx = previous
  delete require.cache[require.resolve(configPath)]
  return value
}

assert.strictEqual(resolveWith({
  getDeviceInfo: () => ({ platform: 'devtools' }),
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } })
}), 'laiyipai-d2gks4fmq84ce6b44')

assert.strictEqual(resolveWith({
  getDeviceInfo: () => ({ platform: 'ios' }),
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } })
}), 'laiyipai-d2gks4fmq84ce6b44')

assert.strictEqual(resolveWith({
  getDeviceInfo: () => ({ platform: 'android' }),
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } })
}), 'laiyipai-d2gks4fmq84ce6b44')

console.log('cloud environment routing tests passed')
