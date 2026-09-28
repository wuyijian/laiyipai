const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const structureOnly = process.argv.includes('--structure-only')
const failures = []
const blockers = []

function fail(message) { failures.push(message) }
function block(message) { blockers.push(message) }
function exists(relativePath) { return fs.existsSync(path.join(root, relativePath)) }
function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), 'utf8') }

function json(relativePath) {
  try {
    return JSON.parse(read(relativePath))
  } catch (error) {
    fail(`${relativePath} 不是有效 JSON：${error.message}`)
    return {}
  }
}

function walk(relativePath) {
  const absolutePath = path.join(root, relativePath)
  if (!fs.existsSync(absolutePath)) return []
  return fs.readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relativePath, entry.name)
    return entry.isDirectory() ? walk(child) : [child]
  })
}

function normalizedRecord(value) {
  return Object.fromEntries(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right)))
}

function sameRecord(left, right) {
  return JSON.stringify(normalizedRecord(left)) === JSON.stringify(normalizedRecord(right))
}

const requiredFiles = [
  'app.js',
  'app.json',
  'sitemap.json',
  'utils/api.js',
  'utils/cloud.js',
  'utils/privacy.js',
  'utils/login-consent.js',
  'utils/share.js',
  'cloudfunctions/api/index.js',
  'cloudfunctions/api/package-lock.json',
  'cloudfunctions/api/lib/terms.js',
  'cloudfunctions/api/lib/venue-entry.js',
  'cloudfunctions/api/lib/coach-applications.js',
  'cloudfunctions/api/lib/friends.js',
  'pages/admin-coach-review/admin-coach-review.js',
  'pages/admin-coach-review/admin-coach-review.json',
  'pages/admin-coach-review/admin-coach-review.wxml',
  'pages/admin-coach-review/admin-coach-review.wxss',
  'pages/friends/friends.js',
  'pages/friends/friends.json',
  'pages/friends/friends.wxml',
  'pages/friends/friends.wxss',
  'cloudfunctions/mediaCallback/index.js',
  'cloudfunctions/mediaCallback/handler.js',
  'cloudfunctions/mediaCallback/message-push.subscription.json',
  'cloudfunctions/mediaCallback/tests/handler.test.js',
  'cloudfunctions/mediaCallback/package-lock.json',
  'cloudfunctions/accountCleanup/index.js',
  'cloudfunctions/accountCleanup/package-lock.json',
  'database/indexes.json',
  'database/security-rules/database-deny-client.json',
  'database/security-rules/storage-owner-only.json',
  'docs/PRIVACY_DATA_MAP.md',
  'docs/AVATAR_MODERATION.md',
  'docs/OPERATIONS_RUNBOOK.md'
]

requiredFiles.forEach((relativePath) => {
  if (!exists(relativePath)) fail(`缺少发布必需文件：${relativePath}`)
})

const databaseIndexes = json('database/indexes.json')
const requiredIndexNames = {
  venues: [
    'city_name_key',
    'city_name',
    'active_verified_city_featured_name',
    'active_verified_city_district_featured_name',
    'active_verified_cover',
    'active_verified_photos',
    'active_verified_location'
  ],
  matches: [
    'city_status_start',
    'city_district_status_start',
    'city_status_date_start',
    'city_status_ball_age_start',
    'city_status_date_ball_age_start',
    'city_district_status_date_start',
    'city_district_status_ball_age_start',
    'city_district_status_date_ball_age_start',
    'venue_status_start',
    'venue_status_date_start',
    'venue_status_ball_age_start',
    'venue_status_date_ball_age_start'
  ],
  coaches: [
    'user_updated',
    'active_verified_city_featured',
    'active_verified_city_district_featured',
    'active_verified_city_venue_featured',
    'active_verified_city_district_venue_featured'
  ],
  venue_submissions: ['status_submitted', 'user_updated', 'target_status_submitted', 'reviewer_updated'],
  coach_slots: ['coach_status_start'],
  match_members: ['user_updated', 'match_status_created'],
  player_friends: ['user_updated', 'friend_updated'],
  player_updates: ['active_created', 'user_created'],
  player_update_comments: ['update_deleted_created', 'user_created', 'owner_created'],
  coach_bookings: ['user_updated'],
  coach_applications: ['status_submitted', 'user_updated', 'reviewer_updated'],
  venue_favorites: ['user_created'],
  venue_reviews: ['venue_status_updated', 'user_venue'],
  match_messages: ['match_deleted_created'],
  message_inboxes: ['user_unread_updated'],
  user_videos: ['user_deleted_created', 'moderation_trace_status', 'public_file', 'owner_file', 'public_owner_created', 'review_queue'],
  user_media: ['user_purpose_deleted_created', 'moderation_trace_status', 'owner_file', 'owner_purpose_status_deleted', 'venue_photo_owner_created', 'venue_photo_review_queue'],
  user_blocks: ['user_active', 'user_active_updated', 'target_active'],
  account_deletion_jobs: ['status_requested'],
  upload_tickets: ['expires_asc'],
  rate_limits: ['expires_asc']
}

Object.entries(requiredIndexNames).forEach(([collection, names]) => {
  const definedNames = new Set((databaseIndexes.collections?.[collection] || []).map((index) => index.name))
  names.forEach((name) => {
    if (!definedNames.has(name)) fail(`database/indexes.json 缺少关键索引：${collection}.${name}`)
  })
})

const venueNameKeyIndex = (databaseIndexes.collections?.venues || []).find((index) => index.name === 'city_name_key')
if (!venueNameKeyIndex || venueNameKeyIndex.unique !== true) {
  fail('venues.city_name_key 必须是唯一组合索引；上线前先补齐旧 nameKey 并清理 city + nameKey 重复项')
}

;['upload_tickets', 'rate_limits'].forEach((collection) => {
  const index = (databaseIndexes.collections?.[collection] || []).find((item) => item.name === 'expires_asc')
  const fields = index && index.fields
  if (!index || index.type || Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds') ||
      !Array.isArray(fields) || fields.length !== 1 || fields[0].field !== 'expiresAt' || fields[0].order !== 'asc') {
    fail(`${collection}.expires_asc 必须是 expiresAt 单字段升序普通索引，不得声明为 TTL 索引`)
  }
})

;['api', 'mediaCallback', 'accountCleanup'].forEach((directory) => {
  const packagePath = `cloudfunctions/${directory}/package.json`
  const lockPath = `cloudfunctions/${directory}/package-lock.json`
  const packageJson = json(packagePath)
  const packageLock = json(lockPath)
  const lockRoot = packageLock.packages?.['']
  if (!lockRoot) {
    fail(`${lockPath} 缺少根包记录`)
  } else if (!sameRecord(packageJson.dependencies, lockRoot.dependencies)) {
    fail(`${lockPath} 根 dependencies 与 ${packagePath} 不一致`)
  }
})

const project = json('project.config.json')
const app = json('app.json')
const sitemap = json('sitemap.json')
const cloudConfigSource = read('utils/cloud-config.js')
const cloudConfig = require(path.join(root, 'utils', 'cloud-config.js'))

if (project.cloudfunctionRoot !== 'cloudfunctions/') {
  fail('project.config.json 必须声明 cloudfunctionRoot 为 cloudfunctions/')
}
const uploadIgnoreFolders = new Set((project.packOptions?.ignore || [])
  .filter((item) => item && item.type === 'folder')
  .map((item) => item.value))
if (!uploadIgnoreFolders.has('release-assets')) {
  fail('release-assets 仅用于提审截图，必须从微信小程序上传包排除，避免主包超过 2MB')
}
const uploadIncludeFolders = new Set((project.packOptions?.include || [])
  .filter((item) => item && item.type === 'folder')
  .map((item) => item.value))
if (!uploadIncludeFolders.has('custom-tab-bar')) {
  fail('custom-tab-bar 必须显式加入微信小程序上传包，避免被无依赖文件过滤误删')
}
if (!/^wx[a-zA-Z0-9]{16}$/.test(project.appid || '')) {
  block('project.config.json 尚未填写正式小程序 AppID')
}
const productionCloudEnvId = String(cloudConfig.productionCloudEnvId || '').trim()
const testCloudEnvId = String(cloudConfig.testCloudEnvId || '').trim()
if (!productionCloudEnvId || /YOUR_.*_CLOUD_ENV_ID/.test(productionCloudEnvId)) {
  block('utils/cloud-config.js 尚未填写生产云环境 ID')
}
if (testCloudEnvId && /YOUR_.*_CLOUD_ENV_ID/.test(testCloudEnvId)) {
  block('utils/cloud-config.js 的测试云环境 ID 仍是占位值')
}
if (testCloudEnvId && productionCloudEnvId && testCloudEnvId === productionCloudEnvId) {
  block('测试与生产云环境 ID 必须不同')
}
if (String(cloudConfig.cloudEnvId || '').trim()) {
  block('真实构建必须清空 cloudEnvId 测试覆盖值')
}
if (!/termsVersion\s*:\s*['"]\d{4}-\d{2}-\d{2}['"]/.test(cloudConfigSource)) {
  fail('utils/cloud-config.js 必须声明可审计的用户协议版本')
}
if (app.__usePrivacyCheck__ !== true) fail('app.json 必须开启 __usePrivacyCheck__')
if (app.permission && app.permission['scope.record']) {
  fail('产品不提供录音功能，app.json 不得申请 scope.record')
}
if (app.permission && app.permission['scope.userLocation']) {
  fail('产品不获取用户地理位置，app.json 不得申请 scope.userLocation')
}
if (Array.isArray(app.requiredPrivateInfos) && app.requiredPrivateInfos.includes('getLocation')) {
  fail('产品不获取用户地理位置，app.json 不得声明 getLocation')
}
if (Object.prototype.hasOwnProperty.call(app, 'plugins')) {
  fail('当前产品不依赖小程序插件，app.json 不得声明 plugins')
}
if (app.tabBar?.custom !== true) {
  fail('app.json 必须启用无图片依赖的自定义 TabBar，避开开发者工具本地图片代理异常')
}
;(app.tabBar?.list || []).forEach((item) => {
  if (item.iconPath || item.selectedIconPath) {
    fail(`自定义 TabBar 不得继续引用本地图标：${item.pagePath || '未知页面'}`)
  }
})
;['index.js', 'index.json', 'index.wxml', 'index.wxss'].forEach((filename) => {
  if (!exists(`custom-tab-bar/${filename}`)) fail(`缺少自定义 TabBar 文件：custom-tab-bar/${filename}`)
})

const publishSource = read('pages/publish/publish.js')
const clientApiSource = read('utils/api.js')
const cloudApiSource = read('cloudfunctions/api/index.js')
const cloudApiPackage = json('cloudfunctions/api/package.json')
const mediaPushSubscription = json('cloudfunctions/mediaCallback/message-push.subscription.json')

if (mediaPushSubscription.msg_type !== 'event' ||
    !Array.isArray(mediaPushSubscription.event_types) ||
    !mediaPushSubscription.event_types.includes('wxa_media_check') ||
    mediaPushSubscription.function_name !== 'mediaCallback' ||
    mediaPushSubscription.enable !== true) {
  fail('头像审核消息推送清单必须启用 event/wxa_media_check → mediaCallback')
}
;['profile.avatar.status', 'profile.avatar.register', 'profile.avatar.retry', 'profile.avatar.remove'].forEach((route) => {
  if (!cloudApiSource.includes(`'${route}'`) && !cloudApiSource.includes(`"${route}"`)) {
    fail(`api 云函数缺少头像审核路由：${route}`)
  }
})
if (!clientApiSource.includes("'profile.avatar.retry'") && !clientApiSource.includes('"profile.avatar.retry"')) {
  fail('utils/api.js 缺少头像审核超时恢复能力')
}
if (!read('cloudfunctions/mediaCallback/handler.js').includes('wxa_media_check')) {
  fail('mediaCallback 缺少 wxa_media_check 事件处理')
}

const requiredVenueSubmissionCloudRoutes = [
  'venues.create',
  'venues.submissions.list',
  'venues.submissions.get',
  'venues.submissions.resubmit',
  'admin.venueSubmissions.pending',
  'admin.venueSubmissions.get',
  'admin.venueSubmissions.review'
]
requiredVenueSubmissionCloudRoutes.forEach((route) => {
  if (!cloudApiSource.includes(`'${route}'`) && !cloudApiSource.includes(`"${route}"`)) {
    fail(`api 云函数缺少新球馆审核路由：${route}`)
  }
})
;['venues.create', 'venues.submissions.list', 'venues.submissions.get', 'venues.submissions.resubmit'].forEach((route) => {
  if (!clientApiSource.includes(`'${route}'`) && !clientApiSource.includes(`"${route}"`)) {
    fail(`utils/api.js 缺少新球馆提交能力：${route}`)
  }
})
;['admin.venueSubmissions.pending', 'admin.venueSubmissions.get', 'admin.venueSubmissions.review'].forEach((route) => {
  if (!clientApiSource.includes(`'${route}'`) && !clientApiSource.includes(`"${route}"`)) {
    fail(`utils/api.js 缺少管理员球馆审核能力：${route}`)
  }
})
;['admin.coachApplications.pending', 'admin.coachApplications.get', 'admin.coachApplications.review'].forEach((route) => {
  if (!cloudApiSource.includes(`'${route}'`) && !cloudApiSource.includes(`"${route}"`)) {
    fail(`api 云函数缺少管理员教练认证审核能力：${route}`)
  }
  if (!clientApiSource.includes(`'${route}'`) && !clientApiSource.includes(`"${route}"`)) {
    fail(`utils/api.js 缺少管理员教练认证审核能力：${route}`)
  }
})
;['admin.venues.list', 'admin.venues.remove', 'admin.coaches.list', 'admin.coaches.remove'].forEach((route) => {
  if (!cloudApiSource.includes(`'${route}'`) && !cloudApiSource.includes(`"${route}"`)) {
    fail(`api 云函数缺少管理员内容管理能力：${route}`)
  }
  if (!clientApiSource.includes(`'${route}'`) && !clientApiSource.includes(`"${route}"`)) {
    fail(`utils/api.js 缺少管理员内容管理能力：${route}`)
  }
})

const venueCreateSource = read('pages/venue-create/venue-create.js')
const venueCreateTemplate = read('pages/venue-create/venue-create.wxml')
const publishTemplate = read('pages/publish/publish.wxml')
const profileSource = read('pages/profile/profile.js')
const adminVenueReviewSource = read('pages/admin-venue-review/admin-venue-review.js')
const adminVenueReviewTemplate = read('pages/admin-venue-review/admin-venue-review.wxml')
const adminCoachReviewSource = read('pages/admin-coach-review/admin-coach-review.js')
const adminCoachReviewTemplate = read('pages/admin-coach-review/admin-coach-review.wxml')
const adminCatalogSource = read('pages/admin-catalog/admin-catalog.js')
const adminCatalogTemplate = read('pages/admin-catalog/admin-catalog.wxml')
const adminApiSource = read('cloudfunctions/api/lib/admin.js')
const coachApplicationsSource = read('cloudfunctions/api/lib/coach-applications.js')
if (!/openVenueCreate\s*\(/.test(publishSource) || !publishSource.includes('/pages/venue-create/venue-create') || !/bindtap=["']openVenueCreate["']/.test(publishTemplate)) {
  fail('发布球局页必须保留“录入新球馆”审核入口')
}
if (!/api\.venues\.create\b/.test(venueCreateSource) || !/api\.venues\.submissions\.(?:get|resubmit)\b/.test(venueCreateSource)) {
  fail('新球馆页必须提交审核记录并支持查看/重新提交')
}
if (!/审核/.test(venueCreateTemplate)) {
  fail('新球馆页必须明示审核后才会公开')
}
if (!/api\.venues\.submissions\.list\b/.test(profileSource) || !profileSource.includes('/pages/venue-create/venue-create?submissionId=')) {
  fail('“我的”页必须提供本人球馆审核记录入口')
}
if (!profileSource.includes('session.capabilities.adminVenueReview === true') || !profileSource.includes('/pages/admin-venue-review/admin-venue-review')) {
  fail('“我的”页必须仅按服务端 capability 展示管理员球馆审核入口')
}
if (!/api\.admin\.pendingVenueSubmissions\b/.test(adminVenueReviewSource) ||
    !/api\.admin\.getVenueSubmission\b/.test(adminVenueReviewSource) ||
    !/api\.admin\.reviewVenueSubmission\b/.test(adminVenueReviewSource)) {
  fail('管理员球馆审核页必须支持队列、精确状态核对和审核写入')
}
if (!/expectedVersion/.test(adminVenueReviewSource) || !/requestId/.test(adminVenueReviewSource) || !/确认通过/.test(adminVenueReviewSource) ||
    !/bindtap=["']approveSubmission["']/.test(adminVenueReviewTemplate) || !/bindtap=["']rejectSubmission["']/.test(adminVenueReviewTemplate)) {
  fail('管理员球馆审核页必须保留版本控制、幂等请求和通过二次确认')
}
if (!profileSource.includes('capabilities.adminCoachReview === true') || !profileSource.includes('/pages/admin-coach-review/admin-coach-review')) {
  fail('“我的”页必须仅按服务端 adminCoachReview capability 展示教练认证审核入口')
}
if (!(project.packOptions?.include || []).some((item) => item && item.type === 'folder' && item.value === 'pages/admin-coach-review')) {
  fail('project.config.json 必须显式打包教练认证审核页面')
}
if (!/api\.admin\.pendingCoachApplications\b/.test(adminCoachReviewSource) ||
    !/api\.admin\.getCoachApplication\b/.test(adminCoachReviewSource) ||
    !/api\.admin\.reviewCoachApplication\b/.test(adminCoachReviewSource)) {
  fail('教练认证审核页必须支持分页队列、精确状态核对和审核写入')
}
if (!/expectedVersion/.test(adminCoachReviewSource) || !/requestId/.test(adminCoachReviewSource) ||
    !/retry\s*:\s*false/.test(adminCoachReviewSource) ||
    !/verificationDate/.test(adminCoachReviewSource) || !/automaticReviewReference/.test(coachApplicationsSource) ||
    /内部核验编号/.test(adminCoachReviewTemplate) ||
    !/确认通过/.test(adminCoachReviewSource) || !/确认驳回/.test(adminCoachReviewTemplate)) {
  fail('教练认证审核必须保留版本、幂等、自动审核留痕和明确确认，且不要求手填内部编号')
}
if (!/adminCoachReview\s*:\s*isAdmin\(context\)/.test(read('cloudfunctions/api/lib/auth.js'))) {
  fail('bootstrap 必须由服务端计算 adminCoachReview capability')
}
if (!profileSource.includes('/pages/admin-catalog/admin-catalog') || !/canManageCatalog/.test(profileSource) ||
    !/bindtap=["']openAdminCatalog["']/.test(read('pages/profile/profile.wxml'))) {
  fail('“我的”页必须仅向管理员提供球馆与教练管理入口')
}
if (!(project.packOptions?.include || []).some((item) => item && item.type === 'folder' && item.value === 'pages/admin-catalog')) {
  fail('project.config.json 必须显式打包球馆与教练管理页面')
}
if (!/api\.admin\.listVenues\b/.test(adminCatalogSource) || !/api\.admin\.listCoaches\b/.test(adminCatalogSource) ||
    !/api\.admin\.removeVenue\b/.test(adminCatalogSource) || !/api\.admin\.removeCoach\b/.test(adminCatalogSource) ||
    !/requestId/.test(adminCatalogSource) || !/retry\s*:\s*false/.test(adminCatalogSource) ||
    !/确认删除/.test(adminCatalogSource) || !/历史记录保留/.test(adminCatalogSource) ||
    !/bindtap=["']requestRemove["']/.test(adminCatalogTemplate)) {
  fail('管理员内容管理页必须支持球馆/教练分页、二次确认和幂等软删除')
}
if (!/runTransaction/.test(adminApiSource) || !/active\s*:\s*false/.test(adminApiSource) ||
    !/deleted\s*:\s*true/.test(adminApiSource) || !/deletedBy/.test(adminApiSource) ||
    !/deleteRequestId/.test(adminApiSource) || !/isAdmin\(context, user\)/.test(adminApiSource)) {
  fail('管理员删除必须在事务中复核权限并保留完整软删除审计字段')
}

const cleanupSource = read('cloudfunctions/accountCleanup/index.js')
if (!/collection\(['"]venue_submissions['"]\)\.where\(\{\s*userId\s*\}\)/.test(cleanupSource)) {
  fail('账号注销任务必须处理 venue_submissions 归属')
}
if (!/status\s*=\s*['"]withdrawn['"]/.test(cleanupSource) || !/submitterSnapshot\s*:/.test(cleanupSource)) {
  fail('账号注销时必须撤回待审球馆并匿名化提交人快照')
}
if (!/collection\(['"]venue_submissions['"]\)\.where\(\{\s*reviewedBy\s*:\s*userId\s*\}\)/.test(cleanupSource) || !/reviewedBy\s*:\s*reference/.test(cleanupSource)) {
  fail('账号注销任务必须匿名化 venue_submissions 中的审核员 OPENID')
}
if (!/collection\(['"]coach_applications['"]\)\.where\(\{\s*userId\s*\}\)/.test(cleanupSource) ||
    !/collection\(['"]coach_applications['"]\)\.where\(\{\s*reviewedBy\s*:\s*userId\s*\}\)/.test(cleanupSource) ||
    !/collection\(['"]coaches['"]\)\.where\(\{\s*userId\s*\}\)/.test(cleanupSource)) {
  fail('账号注销任务必须覆盖教练申请、申请审核员和关联教练档案')
}
if (!/const\s+futureConfirmed\s*=\s*current\.status\s*===\s*['"]confirmed['"]\s*&&\s*new Date\(current\.startAt\)\.getTime\(\)\s*>\s*Date\.now\(\)/.test(cleanupSource) ||
    !/status\s*:\s*futureConfirmed\s*\?\s*['"]cancelled['"]\s*:\s*current\.status/.test(cleanupSource)) {
  fail('账号注销只能取消未来 confirmed 教练预约，历史预约必须保留原状态')
}
if (!/userId\s*:\s*hasMore\s*\?\s*userId\s*:\s*reference/.test(cleanupSource) ||
    !cleanupSource.includes("if (/^deleted_[a-f0-9]{24}$/.test(value)) return value")) {
  fail('注销任务完成后必须以幂等的删除引用替换原始 userId')
}
if (!/EXPIRY_COLLECTIONS\s*=\s*\[['"]upload_tickets['"],\s*['"]rate_limits['"]\]/.test(cleanupSource) ||
    !/expiresAt\s*:\s*db\.command\.lt\(expiresBefore\)/.test(cleanupSource) ||
    !/orderBy\(['"]expiresAt['"],\s*['"]asc['"]\)/.test(cleanupSource)) {
  fail('accountCleanup 必须按 expiresAt 升序普通索引定时清理 upload_tickets 与 rate_limits')
}
if (!/\.limit\(EXPIRY_CLEANUP_BATCH\)\s*\.field\(\{\s*_id\s*:\s*true\s*\}\)\s*\.get\(\)/.test(cleanupSource) ||
    !/\.doc\(record\._id\)\.remove\(\)/.test(cleanupSource)) {
  fail('过期记录清理必须先限量读取文档 ID 再逐条删除；查询级 remove 会忽略 limit，不能用于此处')
}
if (!read('docs/PRIVACY_DATA_MAP.md').includes('venue_submissions')) {
  fail('隐私数据清单必须说明新球馆审核记录')
}

if (/wx\.getRecorderManager\s*\(/.test(publishSource)) {
  fail('发布页不得启动录音')
}
if (/['"]voice\.transcribe['"]/.test(clientApiSource) || /\bvoice\s*:\s*\{/.test(clientApiSource)) {
  fail('utils/api.js 不得暴露语音转写接口')
}
if (/['"]voice\.transcribe['"]/.test(cloudApiSource) || /\.\/lib\/voice/.test(cloudApiSource)) {
  fail('api 云函数不得注册语音转写路由')
}
if (exists('cloudfunctions/api/lib/voice.js')) {
  fail('已停用录音功能，不得保留 voice.js 云端实现')
}
if (cloudApiPackage.dependencies && cloudApiPackage.dependencies['tencentcloud-sdk-nodejs-asr']) {
  fail('已停用录音功能，api 云函数不得安装 ASR SDK')
}

const personalVideoClientFiles = [
  'pages/profile/profile.js',
  'pages/profile/profile.wxml',
  'pages/player-detail/player-detail.js',
  'pages/player-detail/player-detail.wxml',
  'pages/match-detail/match-detail.js',
  'pages/match-detail/match-detail.wxml',
  'utils/api.js',
  'utils/present.js'
]
personalVideoClientFiles.forEach((file) => {
  const source = read(file)
  if (/比赛视频|比赛片段|已有视频|videoItems|videosState|previewVideo|removeVideo|previewHostVideo|hostVideos|videoCount|\bvideos\s*:/.test(source)) {
    fail(`客户端不得保留个人视频内容或请求：${file}`)
  }
})

;['cloudfunctions/api/lib/players.js', 'cloudfunctions/api/lib/matches.js', 'cloudfunctions/api/lib/files.js'].forEach((file) => {
  if (/COLLECTIONS\.userVideos|['"]user_videos['"]/.test(read(file))) {
    fail(`公开读取链路不得查询个人视频集合：${file}`)
  }
})
if (!/videos\s*:\s*\[\]/.test(read('cloudfunctions/api/lib/players.js'))) {
  fail('players.get 必须为旧客户端返回空 videos 兼容字段')
}
if (!/hostVideos\s*:\s*\[\]/.test(read('cloudfunctions/api/lib/matches.js'))) {
  fail('matches.get 必须为旧客户端返回空 hostVideos 兼容字段')
}
if (/videoFileIds\s*:/.test(read('cloudfunctions/api/lib/presenters.js'))) {
  fail('公开个人资料不得返回历史 videoFileIds')
}
const legacyVideoApiSource = read('cloudfunctions/api/lib/videos.js')
if (/(?:fileId|title|durationSeconds|visibility)\s*:\s*document\./.test(legacyVideoApiSource)) {
  fail('历史视频兼容列表不得返回文件或展示元数据')
}
const storageRules = json('database/security-rules/storage-owner-only.json')
let storageReadAllowsLegacyVideo = true
try {
  const storageRead = new Function('auth', 'resource', 'return (' + String(storageRules.read || 'false') + ')')
  storageReadAllowsLegacyVideo = Boolean(storageRead(
    { openid: 'release-owner', uid: 'release-owner' },
    { openid: 'release-owner', path: 'user-videos/legacy.mp4', size: 1024 }
  ))
} catch (error) {
  fail('云存储读取规则语法无效')
}
if (storageReadAllowsLegacyVideo) {
  fail('云存储规则必须拒绝客户端直读历史个人视频')
}

const requiredPages = [
  'pages/home/home',
  'pages/publish/publish',
  'pages/orders/orders',
  'pages/profile/profile',
  'pages/admin-venue-review/admin-venue-review',
  'pages/admin-coach-review/admin-coach-review',
  'pages/venue-detail/venue-detail',
  'pages/venue-create/venue-create',
  'pages/match-detail/match-detail',
  'pages/chat/chat',
  'pages/coach-detail/coach-detail',
  'pages/coach-apply/coach-apply',
  'pages/player-detail/player-detail',
  'pages/friends/friends',
  'pages/settings/settings',
  'pages/login/login'
]
requiredPages.forEach((page) => {
  if (!(app.pages || []).includes(page)) fail(`app.json 缺少页面：${page}`)
})

const privatePages = ['pages/login/login', 'pages/publish/publish', 'pages/orders/orders', 'pages/profile/profile', 'pages/admin-venue-review/admin-venue-review', 'pages/admin-coach-review/admin-coach-review', 'pages/admin-catalog/admin-catalog', 'pages/chat/chat', 'pages/coach-apply/coach-apply', 'pages/player-detail/player-detail', 'pages/friends/friends', 'pages/settings/settings', 'pages/venue-create/venue-create']
const rules = Array.isArray(sitemap.rules) ? sitemap.rules : []
const denyAllIndex = rules.findIndex((rule) => rule.action === 'disallow' && rule.page === '*')
if (denyAllIndex < 0) fail('sitemap.json 必须默认禁止索引未明确公开的页面')
privatePages.forEach((page) => {
  const explicitlyAllowed = rules.some((rule, index) => rule.action === 'allow' && rule.page === page && (denyAllIndex < 0 || index < denyAllIndex))
  if (explicitlyAllowed) fail(`私有页面不可加入 sitemap：${page}`)
})

const timelinePages = ['pages/home/home', 'pages/match-detail/match-detail', 'pages/venue-detail/venue-detail', 'pages/coach-detail/coach-detail']
timelinePages.forEach((page) => {
  const source = read(`${page}.js`)
  if (!/onShareTimeline\s*\(\)/.test(source)) fail(`公开页面缺少朋友圈分享处理：${page}`)
})
privatePages.forEach((page) => {
  if (/onShareTimeline\s*\(\)/.test(read(`${page}.js`))) fail(`私有页面不可开放朋友圈分享：${page}`)
})
if (!/showShareMenu/.test(read('utils/share.js')) || !/shareTimeline/.test(read('utils/share.js'))) {
  fail('utils/share.js 必须通过微信原生菜单开放朋友圈分享')
}

if (exists('utils/data.js')) fail('生产工程仍包含 utils/data.js')
if (exists('utils/store.js')) fail('生产工程仍包含 utils/store.js')

const sourceFiles = ['app.js', ...walk('pages'), ...walk('utils')]
  .filter((file) => /\.(js|json|wxml|wxss)$/.test(file))
const bannedCopy = ['正式版将', '功能正在完善', '本机自动保存']

sourceFiles.forEach((file) => {
  const source = read(file)
  if (/wx\.cloud\.database\s*\(/.test(source)) fail(`客户端禁止直连数据库：${file}`)
  if (/wx\.getLocation\s*\(/.test(source)) fail(`客户端不得获取用户地理位置：${file}`)
  if (/\brequirePlugin\s*\(/.test(source)) {
    fail(`客户端不得依赖小程序语音插件：${file}`)
  }
  if (/require\s*\([^)]*(?:utils\/|\.\/|\.\.\/)(?:data|store)(?:\.js)?['"]?\s*\)/.test(source)) {
    fail(`客户端仍依赖本地业务存储：${file}`)
  }
  bannedCopy.forEach((copy) => {
    if (source.includes(copy)) fail(`生产文案包含占位提示“${copy}”：${file}`)
  })
})

console.log(`结构检查：${failures.length ? '失败' : '通过'}`)
console.log(`发布配置：${blockers.length ? '未完成' : '通过'}`)
failures.forEach((message) => console.error(`ERROR  ${message}`))
blockers.forEach((message) => console.error(`BLOCK  ${message}`))

if (failures.length || (!structureOnly && blockers.length)) process.exitCode = 1
