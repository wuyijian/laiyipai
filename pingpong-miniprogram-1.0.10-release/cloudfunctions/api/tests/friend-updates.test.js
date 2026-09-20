const assert = require('assert')
const friendUpdates = require('../lib/friend-updates')

function query(source, condition = null) {
  let rows = source().slice()
  if (condition) rows = rows.filter(item => Object.entries(condition).every(([key, expected]) => item[key] === expected))
  const chain = {
    where(next) { return query(source, next) },
    orderBy(field, direction) { rows.sort((a, b) => (new Date(a[field]).getTime() - new Date(b[field]).getTime()) * (direction === 'desc' ? -1 : 1)); return chain },
    skip(count) { rows = rows.slice(count); return chain },
    limit(count) { rows = rows.slice(0, count); return chain },
    async get() { return { data: rows } }
  }
  return chain
}

function createContext(store, values = {}) {
  const playerCollection = () => {
    const source = () => Array.from(store, ([id, value]) => Object.assign({ _id: id }, value))
    const chain = query(source)
    chain.doc = id => ({
      async get() { return { data: store.has(id) ? Object.assign({ _id: id }, store.get(id)) : null } },
      async set({ data }) { store.set(id, Object.assign({}, data)) },
      async update({ data }) { store.set(id, Object.assign({}, store.get(id), data)) }
    })
    return chain
  }
  const blocks = values.blocks || []
  return {
    openid: values.openid || 'owner-openid',
    apiVersion: values.apiVersion === undefined ? 2 : values.apiVersion,
    requestId: values.requestId || 'request_player_update_001',
    user: values.user || { publicId: 'player-public', profile: { nickname: '林小拍', avatarFileId: 'cloud://avatar.jpg', district: '滨江区', ratingPlatform: '开球网', ratingValue: '1650' } },
    serverDate: () => new Date(values.now || '2030-01-01T00:00:00.000Z'),
    cloud: { openapi: { security: { msgSecCheck: async () => ({ errCode: 0, result: { suggest: 'pass' } }) } } },
    db: {
      collection(name) {
        if (name === 'player_updates') return playerCollection()
        if (name === 'user_blocks') return query(() => blocks)
        if (name === 'audit_logs') return { add: async () => ({}) }
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }
}

async function run() {
  const originalNow = Date.now
  Date.now = () => new Date('2030-01-01T00:00:00.000Z').getTime()
  try {
    const store = new Map()
    const context = createContext(store)
    const first = await friendUpdates.publish(context, {
      kind: 'availability', district: '滨江区', availabilityText: '本周工作日晚间',
      timeNote: '19 点以后都行', venueName: '萧潮乒乓球馆', content: '想练接发球',
      ratingPlatform: '开球网', ratingValue: '1680'
    })
    assert.strictEqual(first.mine, true)
    assert.strictEqual(first.availabilityText, '本周工作日晚间')
    assert.strictEqual(first.ratingValue, '1680')
    assert.strictEqual(store.size, 1)
    const broadRecord = store.get(first.id)
    assert.strictEqual(broadRecord.date, undefined, '宽泛可约动态不应保存精确日期')
    assert.strictEqual(broadRecord.startTime, undefined, '宽泛可约动态不应保存精确开始时间')
    assert.strictEqual(broadRecord.endTime, undefined, '宽泛可约动态不应保存精确结束时间')

    const replay = await friendUpdates.publish(context, {
      kind: 'availability', district: '滨江区', availabilityText: '本周工作日晚间',
      ratingPlatform: '开球网', ratingValue: '1680'
    })
    assert.strictEqual(replay.id, first.id)
    assert.strictEqual(store.size, 1, '相同请求必须幂等')

    const tipContext = createContext(store, { requestId: 'request_player_update_002', now: '2030-01-01T01:00:00.000Z' })
    const tip = await friendUpdates.publish(tipContext, {
      kind: 'tip', district: '萧山区', content: '接发球先盯住对方触球瞬间。', ratingPlatform: '未填写'
    })
    assert.strictEqual(tip.kind, 'tip')
    assert.strictEqual(tip.district, '', '心得动态不应要求或展示地区')
    assert.strictEqual(tip.date, '', '心得动态不应要求精确日期')
    assert.strictEqual(store.get(tip.id).date, undefined, '心得动态不得落库精确日期字段')
    assert.strictEqual(store.size, 2, '每条动态应为独立记录')

    const legacyStore = new Map()
    const legacyContext = createContext(legacyStore, {
      apiVersion: 1, requestId: 'request_legacy_update_001', now: '2030-01-01T02:00:00.000Z'
    })
    const legacy = await friendUpdates.publish(legacyContext, {
      district: '上城区', date: '2030-01-02', startTime: '19:00', endTime: '20:30',
      ratingPlatform: '未填写'
    })
    assert.strictEqual(legacy.availabilityText, '1月2日 19:00—20:30', '旧客户端精确时段应在滚动升级时兼容为可读文案')
    assert.strictEqual(legacy.date, '2030-01-02')

    const listed = await friendUpdates.list(context, { page: 1, pageSize: 20 })
    assert.strictEqual(listed.items.length, 2)
    assert(listed.items.every(item => item.mine))
    assert(!JSON.stringify(listed).includes('owner-openid'), '响应不得返回内部用户 ID')

    const detail = await friendUpdates.get(context, { updateId: tip.id })
    assert.strictEqual(detail.content, '接发球先盯住对方触球瞬间。')
    await friendUpdates.remove(context, { updateId: first.id })
    assert.strictEqual(store.get(first.id).active, false)

    await assert.rejects(() => friendUpdates.publish(createContext(store, { requestId: 'request_player_update_003' }), {
      kind: 'tip', district: '滨江区', content: '', ratingPlatform: '未填写'
    }), error => error.code === 'INVALID_ARGUMENT')

    const blockedId = friendUpdates._private.updateId('blocked-openid', 'request_blocked_update')
    store.set(blockedId, {
      userId: 'blocked-openid', active: true, kind: 'tip', content: '不应显示', createdAt: new Date(),
      district: '上城区', authorSnapshot: { playerId: 'blocked-player', displayName: '已屏蔽用户' }
    })
    const blockedContext = createContext(store, { blocks: [{ userId: 'owner-openid', targetUserId: 'blocked-openid', active: true }] })
    const filtered = await friendUpdates.list(blockedContext, { page: 1, pageSize: 20 })
    assert(!JSON.stringify(filtered).includes('已屏蔽用户'))
  } finally {
    Date.now = originalNow
  }
  console.log('friend updates cloud tests passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
