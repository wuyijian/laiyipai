# 数据模型

## 核心关系

### 球友目录扩展

`users.profile.playingProfile` 保存结构化器材、技术标签及能力自评（0/缺失为未评估）。`ratingUpdatedAt` 仅在自报积分/平台变化时由服务端写入，等级不存客户端可写值，公开标记始终为 self_reported。

`users.profile.availability` 为 `{available,note?}` 或 `{available:true,date,startTime,endTime,venueId,venueName,district,note,endAt}`。endAt 为服务端按北京时间计算的毫秒数，venueName/district 来自公开球馆。到期后读取时只呈现不可约，无需定时写库。旧客户端不传则保留；关闭时整体替换并删除旧安排；注销随 profile 清除。

球友目录只查询 active 用户，使用 public_id_status / status_district_public_id 索引按 publicId 游标分页，派生等级及状态筛选，双向屏蔽逐批校验。数据库权限不变，客户端不可直接查询 users。

附近展示可选保存于 users.profile.nearbyDiscovery：enabled、point（0.01 度栅格的 gcj02 latitude/longitude）、expiresAt（服务端数字毫秒，24 小时）。仅本人明确开启时保存，公开接口不返回 point；期限结束停止匹配。关闭写 point:null，注销随 profile 删除。accountCleanup 按 nearby_enabled_expiry 索引每次最多处理 100 条，在事务内重新核对期限后清除过期位置，避免误清理刚续期的数据。

- `users/{OPENID}`：私有身份、角色、账号状态和资料。`publicId` 是对外球友 ID，接口不返回 OPENID。
- `venues/{venueId}`：球馆目录支持两种展示模式。既有完整记录默认为 `listingMode:full`，要求地址与 GeoPoint，并用 `verificationDate/sourceUrls` 保留资料可追溯性；`listingMode:name_only` 只保存名称与 `activityTags`，不保存地址、坐标、电话、图片或设施信息，公开响应固定为 `verified:false`、`partnerVerified:false`。`activityTags` 仅可为 `教学/比赛/训练/切磋`，与完整场馆的通用 `tags`、设施类 `facilityTags` 分开。
- `venue_submissions/{hash(OPENID,city,nameKey)}`：用户标记新球馆的私有录入留痕。新记录以 `publicationMode:instant/status:approved` 创建；仍兼容旧版 `reviewing/rejected/withdrawn` 审核记录。包含服务端写入的 `userId`、对外申请人快照、目标球馆 ID、标准化名称键、活动标签、对象版本及历史审核留痕。普通用户只能通过 API 查看本人记录；运营历史待审队列不返回 OPENID。
- `matches/{matchId}`：球局聚合根，含场馆快照、发起人快照、人数、价格、日程、约球目的 `practiceIntent`（`随便练练/切磋球技`）、协议版本和对象版本。完整球馆的场馆快照包含地址、GCJ-02 坐标和展示模式，保证球馆列表较慢时仍可导航；名称型球馆快照固定不含地址与坐标。历史记录缺少 `practiceIntent` 时按 `随便练练` 展示，旧 `skills` 字段仅用于兼容。
- `match_members/{hash(matchId,userId)}`：每人一条成员记录，状态为 `host/joined/pending/waitlisted/rejected/cancelled`；`confirmedScheduleVersion` 支持逐人确认改期，`termsVersion/termsAcceptedAt` 保存加入时的协议留痕。
- `player_friends/{hash(userId,friendId)}`：用户确认同场后生成的私有双向球友关系，只记录双方内部 ID、首次及最近同场球局和共同球局数；候补、待批准和被拒绝申请不生成关系。公开资料始终从当前用户记录脱敏读取，拉黑时关系继续留存但双方不可见，账号注销时双向删除。
- `player_updates/{hash(userId,requestId)}`：历史球友动态，功能已下线。保留原数据和账号注销清理，客户端不可直读直写，业务路由统一返回 `FEATURE_REMOVED`。
- `player_update_comments/{hash(userId,requestId)}`：历史公开回复，功能已下线。与历史动态同样禁用公开读取和新增，保留账号注销清理。
- `coaches/{coachId}`、`coach_slots/{slotId}`、`coach_bookings/{bookingId}`：教练、可售时段和用户预约。教练核验记录只供运营使用；时段库存与预约在同一事务内变化。
- `coach_applications/{hash(OPENID)}`：用户的教练认证申请，记录真实姓名、手机号、执教年限、擅长方向、执教球馆名称、介绍和资历说明，以及状态、对象版本和绑定审核意图的请求留痕。手机号和审核信息仅本人与运营可见；审核通过后事务生成关联 `userId` 的教练档案，但保持 `active:false` 直到运营补齐时段。审核可关联任何已上架的球馆目录记录；`listingMode:name_only` 只表达授课地点，不表达场馆资料核验或合作关系。
- `venue_favorites/{hash(userId,venueId)}`：用户收藏。
- `venue_reviews/{hash(userId,venueId)}`：球友对已上架球馆的评分与反馈。每个用户每个球馆只有一条可更新记录，包含 1—5 分、平台预设标签和通过内容安全检查的自定义文字；球馆文档同步维护 `ratingCount/ratingTotal/ratingAverage/ratingTagCounts` 聚合字段，公开响应不返回 OPENID。
- `match_messages/{messageId}`：球局群聊；服务端验证成员状态后才允许读写。
- `message_inboxes/{hash(matchId,userId)}`：球局消息未读指针；仅保存接收用户、球局、最新消息 ID 和未读数。站内弹窗读取时再次校验成员资格、球局有效期和屏蔽关系，进入对话后按最新消息 ID 原子清零。
- `user_videos`、`user_media`：云存储文件的审核状态。头像记录包含 `moderationTraceId/moderationRequestId/moderationAttempt/moderationRequestedAt/moderationDeadlineAt`，真实状态可为 `reviewing/passed/rejected/failed/replaced/deleted`；`timed_out` 是 API 根据审核期限计算的恢复态，不直接写入数据库。`user_videos` 是不再前台展示的历史兼容数据，仅供删除、运营处置和注销清理；`user_media` 仍服务头像及历史场地照片。两类内容都不再接收视频或场馆照片新增上传；场地照片为 `purpose:venue_photo`，配额记录为 `purpose:venue_photo_quota`，详情见 `docs/VENUE_PHOTOS.md`。
- `upload_tickets`：当前仅发放头像用途的 15 分钟有效一次性上传凭证，绑定用户、用途与云路径，防止把他人的 fileID 注册到自己资料；过期凭证由每小时 `accountCleanup` 按 `expiresAt` 普通升序索引分批删除。
- `user_blocks`、`reports`：拉黑与举报。
- `account_deletion_jobs`：注销后的异步去标识化任务。任务处理期间暂存原始 `userId` 以定位待清理记录；完成时必须将 `userId`（及兼容旧数据可能存在的 `openid`）替换为稳定的 `deleted_{sha256}` 引用，并清空遗留文件列表，避免清理任务本身继续保存原始账号标识。
- `rate_limits`：短时限流桶；读请求按接口使用独立 `scope`，避免首页并发读取争抢同一事务文档，写操作仍共享对应安全分组额度。不依赖 TTL 索引，由每小时 `accountCleanup` 按 `expiresAt` 普通升序索引分批删除。
- `audit_logs`：关键写操作的服务端审计记录。

## 球友录入扩展

`venues.create` 在一个事务中把杭州球馆名称写入公开 `venues` 和私有 `venue_submissions`，新记录立即为 `approved` 并可用于约球。`nameKey` 为 NFKC 标准化、移除空白并转小写的名称；`venues` 以 `city + nameKey` 唯一组合索引作为最终同名约束。同一用户与名称的提交 ID 稳定，用于超时重试幂等；不同用户的同名并发录入指向同一稳定目标球馆 ID。

新录入在事务中创建或复用 `source:community`、`listingMode:name_only` 的公开 `venues` 记录；同名待审或停用的运营记录会阻止自动上架，避免误恢复。运营审核继续支持旧记录的 `reviewing → approved/rejected`；旧驳回记录仅原申请人可重提，重提成功后直接公开。申请人注销时，历史待审单由清理任务转为终态 `withdrawn`。

通过后的名称型球馆内部使用 `verificationStatus:verified`表示目录可用，不代表实地核验；公开白名单仍固定输出 `verified:false`、`partnerVerified:false`、`userContributed:true`。申请人 OPENID 只保存于私有审核集合和审计日志，不写入公开球馆。

## 场地照片数据

名称型球馆保持不采集地址、定位及联系方式，保留历史场地实拍，但不再接受用户上传。仅审核通过的照片写入 `venues.photoFileIds`，与既有官方 `coverFileIds` 分开维护；公开返回时合并，后台修改球馆基础资料不会擦除已审核照片。名称型球馆不会因为有照片而被标记为认证/合作球馆。历史审核展示、删除关联与配额释放通过事务处理。

## 球局状态

`recruiting → full`；发起人改期进入 `changed`；发起人取消进入 `cancelled`。结束态可由后续定时任务根据 `endAt` 归档为 `completed`。

申请制球局先创建 `pending` 成员，发起人调用 `matches.respondJoin` 后转为 `joined/rejected`。满员时用户可明确选择 `allowWaitlist: true`，状态为 `waitlisted`。只有 `host/joined` 成员能访问群聊。

## 隐私与保留

公开响应均采用字段白名单；用户 OPENID、内部备注、审核细节、取消原因和举报内容不出现在公开球局响应。注销先立即冻结身份，再由小时任务取消尚未开始且仍为 `confirmed` 的教练预约、释放对应未来时段名额、删除媒体并将历史快照去标识化；已经发生的 `confirmed` 预约保留历史状态但移除用户身份。注销用户关联的教练申请会清除姓名、手机号、头像、介绍与资历等资料，待审申请转为终态；关联教练档案会去标识并强制下架。清理完成后，注销任务自身也只保留不可逆的稳定删除引用。审计与举报数据的最终保留周期应在正式隐私政策和内部数据制度中明确。

球馆 `sourceUrls/partnershipReference` 与教练 `verificationReference` 不进入公开 presenter。待核验或已拒绝的球馆、教练即使误设 `active`，公开查询、收藏、媒体解析、发起球局和教练预约仍会在服务端拒绝。

管理员删除球馆或教练时不物理删除文档，而写入 `active:false`、`deleted:true`、`deletionReason`、`deleteRequestId`、`deletedBy`、`deletedAt`。管理列表排除 `deleted:true`；历史业务记录继续使用创建时保存的脱敏快照，避免关联断裂。删除人和删除原因不进入公开 presenter。
