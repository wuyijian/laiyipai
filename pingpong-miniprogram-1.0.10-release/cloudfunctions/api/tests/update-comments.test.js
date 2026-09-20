const assert = require('assert')
const comments = require('../lib/update-comments')

function createContext() {
  const stores = {
    player_updates: new Map([['update_one', {
      _id: 'update_one', userId: 'author-openid', active: true, kind: 'tip', district: '滨江区',
      content: '接发球先盯触球瞬间', commentCount: 0, createdAt: new Date('2030-01-01T00:00:00Z'),
      authorSnapshot: { playerId: 'author-public', displayName: '原作者' }
    }]]),
    player_update_comments: new Map(),
    audit_logs: []
  }
  function collection(name) {
    if (name === 'audit_logs') return { add: async ({ data }) => { stores.audit_logs.push(data) } }
    const store = stores[name]
    if (!store) {
      if (name === 'user_blocks') return query([], {})
      throw new Error(`unexpected collection ${name}`)
    }
    return {
      doc(id) {
        return {
          async get() { return { data: store.has(id) ? Object.assign({ _id: id }, store.get(id)) : null } },
          async set({ data }) { store.set(id, Object.assign({}, data)) },
          async update({ data }) { store.set(id, Object.assign({}, store.get(id), data)) }
        }
      },
      where(condition) { return query(Array.from(store, ([id, value]) => Object.assign({ _id: id }, value)), condition) }
    }
  }
  function query(values, condition) {
    let rows = values.filter(item => Object.entries(condition || {}).every(([key, expected]) => item[key] === expected))
    return {
      where(next) { return query(rows, next) },
      orderBy(field, direction) { rows.sort((a, b) => (new Date(a[field]).getTime() - new Date(b[field]).getTime()) * (direction === 'desc' ? -1 : 1)); return this },
      skip(count) { rows = rows.slice(count); return this },
      limit(count) { rows = rows.slice(0, count); return this },
      async get() { return { data: rows } }
    }
  }
  const db = { collection, runTransaction: task => task({ collection }) }
  return {
    stores,
    context: {
      openid: 'reply-openid', requestId: 'request_update_reply_001', db,
      user: { publicId: 'reply-public', profile: { nickname: '回复球友', district: '萧山区' } },
      serverDate: () => new Date('2030-01-01T01:00:00Z'),
      cloud: { openapi: { security: { msgSecCheck: async () => ({ errCode: 0, result: { suggest: 'pass' } }) } } }
    }
  }
}

async function run() {
  const { stores, context } = createContext()
  const sent = await comments.send(context, { updateId: 'update_one', content: '这个细节很实用，感谢分享。' })
  assert.strictEqual(sent.content, '这个细节很实用，感谢分享。')
  assert.strictEqual(sent.mine, true)
  assert.strictEqual(stores.player_updates.get('update_one').commentCount, 1)

  const replay = await comments.send(context, { updateId: 'update_one', content: '这个细节很实用，感谢分享。' })
  assert.strictEqual(replay.idempotent, true)
  assert.strictEqual(stores.player_updates.get('update_one').commentCount, 1, '幂等重试不能重复增加回复数')

  const listed = await comments.list(context, { updateId: 'update_one', page: 1, pageSize: 20 })
  assert.strictEqual(listed.items.length, 1)
  assert(!JSON.stringify(listed).includes('reply-openid'))
  console.log('update comments cloud tests passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
