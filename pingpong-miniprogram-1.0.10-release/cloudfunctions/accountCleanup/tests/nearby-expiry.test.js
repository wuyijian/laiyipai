const assert = require('assert')
const cleanup = require('../nearby-expiry')
async function run() {
  const now = Date.now()
  const rows = [
    { _id: 'expired', profile: { nearbyDiscovery: { enabled: true, expiresAt: now - 1, point: { latitude: 30, longitude: 120 } } } },
    { _id: 'refreshed', profile: { nearbyDiscovery: { enabled: true, expiresAt: now + 1000, point: { latitude: 30, longitude: 120 } } } },
    { _id: 'disabled', profile: { nearbyDiscovery: { enabled: false, expiresAt: now - 1, point: null } } }
  ]
  let limit
  const db = {
    command: { lt: value => value },
    collection() { return { where() { return this }, orderBy() { return this }, limit(value) { limit = value; return this }, field() { return this }, get: async () => ({ data: rows.map(row => ({ _id: row._id })) }) } },
    async runTransaction(callback) { return callback({ collection: () => ({ doc: id => ({
      get: async () => ({ data: rows.find(row => row._id === id) }),
      update: async ({ data }) => { rows.find(row => row._id === id).profile.nearbyDiscovery = data['profile.nearbyDiscovery'] }
    }) }) }) }
  }
  const result = await cleanup(db, now)
  assert.strictEqual(limit, 100)
  assert.strictEqual(result.cleared, 1)
  assert.strictEqual(rows[0].profile.nearbyDiscovery.point, null)
  assert.strictEqual(rows[1].profile.nearbyDiscovery.point.latitude, 30, 'concurrently renewed location survives cleanup')
  console.log('nearby expiry: bounded cleanup clears expired coordinates and preserves renewed sharing')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
