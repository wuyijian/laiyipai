const assert = require('assert')
const { PUBLIC_READ_ACTIONS, isPublicRead } = require('../lib/action-policy')
const auth = require('../lib/auth')
const files = require('../lib/files')
const matches = require('../lib/matches')
const players = require('../lib/players')

const tests = []
const test = (name, run) => tests.push({ name, run })

function queryReturning(data) {
  const query = {
    where() { return query },
    orderBy() { return query },
    skip() { return query },
    limit() { return query },
    async get() { return { data } }
  }
  return query
}

function publicMatch() {
  const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  return {
    _id: 'match_public_reader',
    title: '公开球局',
    city: '杭州',
    venueId: 'venue_public',
    venueSnapshot: { id: 'venue_public', name: '公开球馆' },
    startAt,
    endAt: new Date(startAt.getTime() + 60 * 60 * 1000),
    capacity: 2,
    participantCount: 1,
    participants: [{ playerId: 'player_host', displayName: '发起人' }],
    hostSnapshot: { playerId: 'player_host', displayName: '发起人' },
    hostId: 'host_openid',
    status: 'recruiting',
    scheduleVersion: 1,
    version: 1
  }
}

test('公开读取使用显式白名单，写操作和个人读取不在白名单', () => {
  const expected = [
    'venues.list', 'venues.nearby', 'venues.get', 'venueReviews.list',
    'matches.list', 'matches.get',
    'coaches.list', 'coaches.get',
    'players.get', 'files.resolve'
  ]
  assert.deepStrictEqual(PUBLIC_READ_ACTIONS, expected)
  expected.forEach((action) => assert.strictEqual(isPublicRead(action), true, action))
  ;[
    'bootstrap', 'matches.create', 'matches.join', 'profile.update',
    'favorites.set', 'messages.send', 'files.prepareUpload',
    'profile.get', 'appointments.list', 'admin.venues.upsert',
    'admin.coachApplications.pending', 'admin.coachApplications.get', 'admin.coachApplications.review'
  ].forEach((action) => assert.strictEqual(isPublicRead(action), false, action))
})
test('公开身份仅绑定可信 OPENID，不访问或创建 users，也不要求隐私同意', () => {
  const context = {
    openid: 'forged_openid',
    wxContext: { OPENID: 'trusted_public_openid', APPID: 'wx_public' },
    db: {
      collection() { throw new Error('public identity must not access database') }
    }
  }
  assert.strictEqual(auth.attachPublicIdentity(context), 'trusted_public_openid')
  assert.strictEqual(context.openid, 'trusted_public_openid')
  assert.strictEqual(context.publicRead, true)
  assert.strictEqual(context.user, undefined)
  assert.throws(
    () => auth.attachPublicIdentity({ wxContext: { OPENID: '' } }),
    (error) => error.code === 'UNAUTHENTICATED'
  )
})

test('matches.list 游客仍按可信 OPENID 隐藏双向屏蔽用户的球局', async () => {
  const match = publicMatch()
  const blockQueries = []
  const result = await matches.list({
    openid: 'trusted_public_openid',
    publicRead: true,
    command: {
      in: (value) => ({ in: value }),
      gte: (value) => ({ gte: value })
    },
    db: {
      collection(name) {
        if (name === 'matches') return queryReturning([match])
        if (name === 'user_blocks') return {
          where(condition) {
            blockQueries.push(condition)
            return queryReturning(condition.userId
              ? [{ userId: 'trusted_public_openid', targetUserId: match.hostId, active: true }]
              : [])
          }
        }
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }, { city: '杭州', page: 1, pageSize: 20 })
  assert.strictEqual(result.items.length, 0)
  assert.strictEqual(blockQueries.length, 2)
})

test('matches.get 游客被发起人双向屏蔽时返回 NOT_FOUND 且不读取成员身份', async () => {
  const match = publicMatch()
  const context = {
    openid: 'trusted_public_openid',
    publicRead: true,
    command: { in: (value) => ({ in: value }) },
    db: {
      collection(name) {
        if (name === 'matches') {
          return { doc: () => ({ get: async () => ({ data: match }) }) }
        }
        if (name === 'user_blocks') return {
          where(condition) {
            return queryReturning(condition.userId
              ? []
              : [{ userId: match.hostId, targetUserId: 'trusted_public_openid', active: true }])
          }
        }
        if (name === 'match_members') {
          throw new Error('public get must not read membership')
        }
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }
  await assert.rejects(
    () => matches.get(context, { matchId: match._id }),
    (error) => error && error.code === 'NOT_FOUND'
  )
})

test('matches.get 未屏蔽游客只返回进行中的公开详情，不读取成员身份状态', async () => {
  const match = publicMatch()
  const context = {
    openid: 'trusted_public_openid',
    publicRead: true,
    command: { in: (value) => ({ in: value }) },
    db: {
      collection(name) {
        if (name === 'matches') return { doc: () => ({ get: async () => ({ data: match }) }) }
        if (name === 'user_blocks') return { where: () => queryReturning([]) }
        if (name === 'match_members') throw new Error('public get must not read membership')
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }
  const result = await matches.get(context, { matchId: match._id })
  assert.strictEqual(result.match.id, match._id)
  assert.strictEqual(result.membership, undefined)
  assert.strictEqual(result.confirmedCount, undefined)
})

test('players.get 游客被目标用户双向屏蔽时返回 NOT_FOUND', async () => {
  const target = {
    _id: 'target_openid',
    publicId: 'player_public',
    status: 'active',
    profile: { nickname: '公开球友', city: '杭州', ballAge: '球龄 2 年', skills: ['正手攻球'] }
  }
  await assert.rejects(() => players.get({
    openid: 'trusted_public_openid',
    publicRead: true,
    db: {
      collection(name) {
        if (name === 'users') return queryReturning([target])
        if (name === 'user_blocks') return { doc: () => ({ get: async () => ({ data: { active: true } }) }) }
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }, { playerId: 'player_public' }), (error) => error && error.code === 'NOT_FOUND')
})

test('players.get 未屏蔽游客返回公开资料但不返回本人状态', async () => {
  const result = await players.get({
    openid: 'trusted_public_openid',
    publicRead: true,
    db: {
      collection(name) {
        if (name === 'users') return queryReturning([{
          _id: 'target_openid',
          publicId: 'player_public',
          status: 'active',
          profile: { nickname: '公开球友', city: '杭州', ballAge: '球龄 2 年', skills: ['正手攻球'] }
        }])
        if (name === 'user_blocks') return { doc: () => ({ get: async () => ({ data: null }) }) }
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }, { playerId: 'player_public' })
  assert.strictEqual(result.player.displayName, '公开球友')
  assert.strictEqual(result.isSelf, false)
})

test('files.resolve 游客仅解析公开引用，不读取本人媒体', async () => {
  const fileId = 'cloud://bucket/public-avatar.png'
  const result = await files.resolve({
    openid: 'trusted_public_openid',
    publicRead: true,
    command: { in: (value) => ({ in: value }) },
    cloud: {
      getTempFileURL: async () => ({
        fileList: [{ fileID: fileId, status: 0, tempFileURL: 'https://example.test/public-avatar.png' }]
      })
    },
    db: {
      collection(name) {
        if (name === 'users') return queryReturning([{
          _id: 'avatar_owner_openid',
          status: 'active', profile: { avatarFileId: fileId }
        }])
        if (name === 'venues' || name === 'coaches') return queryReturning([])
        if (name === 'user_blocks') return { where: () => queryReturning([]) }
        if (name === 'user_media') throw new Error('public file resolve must not access own media')
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }, { fileIds: [fileId] })
  assert.strictEqual(result.urls[fileId], 'https://example.test/public-avatar.png')
  assert.deepStrictEqual(result.unresolved, [])
})

test('files.resolve 不为双向屏蔽用户续签头像 URL，但场馆和教练公开媒体仍可解析', async () => {
  const blockedAvatar = 'cloud://bucket/blocked-avatar.png'
  const venueCover = 'cloud://bucket/public-venue.png'
  const coachAvatar = 'cloud://bucket/public-coach.png'
  const requested = [blockedAvatar, venueCover, coachAvatar]
  const result = await files.resolve({
    openid: 'trusted_public_openid',
    publicRead: true,
    command: { in: (value) => ({ in: value }) },
    cloud: {
      getTempFileURL: async ({ fileList }) => ({
        fileList: fileList.map((fileID) => ({
          fileID,
          status: 0,
          tempFileURL: `https://example.test/${fileID === venueCover ? 'venue' : 'coach'}.png`
        }))
      })
    },
    db: {
      collection(name) {
        if (name === 'venues') return {
          where(condition) {
            if (condition.coverFileIds) return queryReturning([{ coverFileIds: [venueCover] }])
            return queryReturning([])
          }
        }
        if (name === 'coaches') return queryReturning([{ avatarFileId: coachAvatar }])
        if (name === 'users') return queryReturning([{
          _id: 'blocked_owner_openid',
          status: 'active',
          profile: { avatarFileId: blockedAvatar }
        }])
        if (name === 'user_blocks') return {
          where(condition) {
            return queryReturning(condition.userId
              ? [{ userId: 'trusted_public_openid', targetUserId: 'blocked_owner_openid', active: true }]
              : [])
          }
        }
        if (name === 'user_media') throw new Error('public file resolve must not access own media')
        throw new Error(`unexpected collection ${name}`)
      }
    }
  }, { fileIds: requested })
  assert.strictEqual(result.urls[blockedAvatar], undefined)
  assert.strictEqual(result.urls[venueCover], 'https://example.test/venue.png')
  assert.strictEqual(result.urls[coachAvatar], 'https://example.test/coach.png')
  assert.deepStrictEqual(result.unresolved, [blockedAvatar])
})

;(async () => {
  for (const item of tests) {
    await item.run()
    console.log('PASS ' + item.name)
  }
  console.log(tests.length + ' public read cloud checks passed')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
