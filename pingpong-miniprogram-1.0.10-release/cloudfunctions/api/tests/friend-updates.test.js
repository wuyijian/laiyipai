const assert = require('assert')
const friendUpdates = require('../lib/friend-updates')

async function run() {
  const context = {
    db: new Proxy({}, { get() { throw new Error('禁用后不应读写数据库') } }),
    openid: 'compat-107-user',
    apiVersion: 2
  }

  const first = await friendUpdates.list(context, { page: 1, pageSize: 20 })
  assert.deepStrictEqual(first, {
    mine: null,
    items: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
    featureAvailable: false
  })

  const oldClient = await friendUpdates.list(Object.assign({}, context, { apiVersion: 1 }), { page: 2, pageSize: 10 })
  assert.deepStrictEqual(oldClient.items, [])
  assert.strictEqual(oldClient.page, 2)
  assert.strictEqual(oldClient.hasMore, false)

  for (const operation of [
    () => friendUpdates.get(context, { updateId: 'legacy-update' }),
    () => friendUpdates.publish(context, { kind: 'tip', content: '旧客户端内容' }),
    () => friendUpdates.remove(context, { updateId: 'legacy-update' })
  ]) {
    await assert.rejects(operation, error => error && error.code === 'FEATURE_UNAVAILABLE')
  }

  console.log('friend updates disabled compatibility tests passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
