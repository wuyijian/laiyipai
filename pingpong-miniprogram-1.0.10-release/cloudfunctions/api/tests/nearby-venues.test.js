const assert = require('assert')
const venues = require('../lib/venues')

function fixture(id, changes = {}) {
  return Object.assign({
    _id: id, name: id, city: '杭州', district: '滨江区', address: '已核验球馆地址',
    listingMode: 'full', active: true, verificationStatus: 'verified', adminVerified: true,
    location: { longitude: 120, latitude: 30.01 }, userId: 'private-owner'
  }, changes)
}

function context(rows = []) {
  const trace = { queries: 0 }
  const db = {
    Geo: { Point: class Point { constructor(longitude, latitude) { this.longitude = longitude; this.latitude = latitude } } },
    collection(name) {
      assert.strictEqual(name, 'venues')
      trace.queries += 1
      let condition, limit, fields
      const query = {
        where(value) { condition = value; trace.condition = value; return query },
        limit(value) { limit = value; trace.limit = value; return query },
        field(value) { fields = value; trace.fields = value; return query },
        async get() {
          // This is a query-contract fixture, not a replacement for a real
          // CloudBase geo-index integration test. Only eligible rows reach the presenter.
          const eligible = rows.filter(row => row.active === condition.active &&
            row.verificationStatus === condition.verificationStatus && row.location)
          return { data: eligible.slice(0, limit).map(row => Object.fromEntries(
            Object.entries(row).filter(([key]) => !fields || fields[key])
          )) }
        }
      }
      return query
    }
  }
  return { db, command: { geoNear(value) { trace.geo = value; return { $geoNear: value } } }, trace }
}

async function run() {
  const state = context([
    fixture('near'),
    fixture('coordinates', { location: { coordinates: [120, 30.02] } }),
    fixture('inactive', { active: false }),
    fixture('pending', { verificationStatus: 'pending' }),
    fixture('rejected', { verificationStatus: 'rejected' }),
    fixture('missing', { location: null })
  ])
  const result = await venues.nearby(state, { latitude: 30, longitude: 120, radiusMeters: 3000, pageSize: 50 })
  assert.strictEqual(state.trace.condition.active, true, 'nearby must not expose inactive venues')
  assert.strictEqual(state.trace.condition.verificationStatus, 'verified', 'nearby must not expose unapproved venues')
  assert.strictEqual(state.trace.geo.geometry.longitude, 120, 'Geo.Point is longitude first')
  assert.strictEqual(state.trace.geo.geometry.latitude, 30)
  assert.strictEqual(state.trace.geo.minDistance, 0)
  assert.strictEqual(state.trace.geo.maxDistance, 3000, 'radius is enforced by the geo query, not only displayed in UI')
  assert.strictEqual(state.trace.limit, 50)
  assert.strictEqual(state.trace.fields.location, true, 'projection must retain the coordinate used to calculate distance')
  assert.deepStrictEqual(result.items.map(item => item.id), ['near', 'coordinates'])
  assert(Math.abs(result.items[0].distanceMeters - 1112) <= 1)
  assert(Math.abs(result.items[1].distanceMeters - 2224) <= 1)
  assert(result.items.every(item => !Object.hasOwn(item, 'userId')))
  assert.strictEqual(result.radiusMeters, 3000)

  const defaults = context()
  assert.deepStrictEqual(await venues.nearby(defaults, { latitude: 30, longitude: 120 }), { items: [], radiusMeters: 20000 })
  assert.strictEqual(defaults.trace.limit, 30)
  assert.strictEqual(defaults.trace.geo.maxDistance, 20000)
  const limited = context(Array.from({ length: 60 }, (_, index) => fixture('venue_' + index)))
  const limitedResult = await venues.nearby(limited, { latitude: 30, longitude: 120, pageSize: 50, radiusMeters: 50000 })
  assert.strictEqual(limitedResult.items.length, 50)
  assert.strictEqual(limited.trace.geo.maxDistance, 50000)

  for (const key of ['latitude', 'longitude']) {
    for (const invalid of [undefined, null, '', ' ', '30', false, true, [], {}, NaN, Infinity, -Infinity]) {
      const invalidState = context()
      await assert.rejects(venues.nearby(invalidState, { latitude: 30, longitude: 120, [key]: invalid }),
        error => error.code === 'INVALID_ARGUMENT', key + ' must be a finite number')
      assert.strictEqual(invalidState.trace.queries, 0, 'invalid coordinates must fail before querying storage')
    }
  }
  for (const patch of [{ latitude: -90.01 }, { latitude: 90.01 }, { longitude: -180.01 }, { longitude: 180.01 },
    { radiusMeters: 499 }, { radiusMeters: 50001 }, { radiusMeters: 500.5 },
    { pageSize: 0 }, { pageSize: 51 }, { pageSize: 1.5 }]) {
    const invalidState = context()
    await assert.rejects(venues.nearby(invalidState, Object.assign({ latitude: 30, longitude: 120 }, patch)),
      error => error.code === 'INVALID_ARGUMENT')
    assert.strictEqual(invalidState.trace.queries, 0)
  }
  const zero = context()
  await venues.nearby(zero, { latitude: 0, longitude: 0, radiusMeters: 500, pageSize: 1 })
  assert.strictEqual(zero.trace.geo.geometry.latitude, 0, 'numeric zero is a valid coordinate, unlike null or empty text')
  assert.strictEqual(zero.trace.geo.geometry.longitude, 0)
  assert.strictEqual(zero.trace.geo.maxDistance, 500)
  assert.strictEqual(zero.trace.limit, 1)
  console.log('nearby venues: strict coordinates, public visibility, distance, radius and limit contracts passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
