const assert = require('assert')
const location = require('../utils/location')
async function run() {
  let privacyCalls = 0, locationCalls = 0
  global.wx = { canIUse: () => true, requirePrivacyAuthorize: ({ success }) => { privacyCalls++; success() },
    getFuzzyLocation: options => { locationCalls++; assert.strictEqual(options.type, 'gcj02'); options.success({ latitude: 30.25, longitude: 120.15 }) } }
  assert.strictEqual(locationCalls, 0)
  assert.deepStrictEqual(await location.locate(), { latitude: 30.25, longitude: 120.15 })
  assert.strictEqual(privacyCalls, 1)
  await assert.rejects(location.locate(() => false), error => error.code === 'LOCATION_CANCELLED')
  assert.strictEqual(locationCalls, 1)
  wx.getFuzzyLocation = ({ fail }) => fail({ errMsg: 'getFuzzyLocation:fail auth deny' })
  await assert.rejects(location.locate(), error => error.code === 'LOCATION_DENIED')
  wx.getFuzzyLocation = ({ success }) => success({ latitude: 100, longitude: 120 })
  await assert.rejects(location.locate(), /有效位置/)
  delete wx.getFuzzyLocation
  await assert.rejects(location.locate(), error => error.code === 'LOCATION_UNSUPPORTED')
  console.log('fuzzy location: explicit consent, cancellation, denied access, invalid coordinates and unsupported clients passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
