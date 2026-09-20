const assert = require('assert')
const comments = require('../lib/update-comments')

async function run() {
  const context = {
    db: new Proxy({}, { get() { throw new Error('禁用后不应读写数据库') } }),
    openid: 'compat-107-user',
    apiVersion: 2
  }
  await assert.rejects(
    () => comments.list(context, { updateId: 'legacy-update', page: 1, pageSize: 20 }),
    error => error && error.code === 'FEATURE_UNAVAILABLE'
  )
  await assert.rejects(
    () => comments.send(context, { updateId: 'legacy-update', content: '继续交流' }),
    error => error && error.code === 'FEATURE_UNAVAILABLE'
  )
  console.log('update comments disabled compatibility tests passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
