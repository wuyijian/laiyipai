# 来一拍云数据库部署清单

## 集合

1.0.10 只使用生产环境 `laiyipai-d2gks4fmq84ce6b44`。在该环境核对以下集合；仓库没有独立测试库，不得把自动化测试数据写入生产库：

`users`、`venues`、`venue_submissions`、`matches`、`match_members`、`player_friends`、`player_updates`、`player_update_comments`、`coaches`、`coach_applications`、`coach_slots`、`coach_bookings`、`venue_favorites`、`match_messages`、`message_inboxes`、`user_videos`、`user_media`、`upload_tickets`、`user_blocks`、`reports`、`account_deletion_jobs`、`rate_limits`、`audit_logs`。

其中 `player_updates`、`player_update_comments`、`user_videos`、`user_media` 与 `upload_tickets` 是升级前数据的兼容/清理集合，不表示 1.0.10 仍开放动态或用户媒体上传。

所有集合均切换到“自定义安全规则”，逐个粘贴 `security-rules/database-deny-client.json`；规则为 `read:false/write:false`。客户端不得直接查库或写库；公开球馆数据同样经 `api` 云函数返回，避免绕开封禁、字段脱敏和限流。

云存储粘贴 `security-rules/storage-owner-only.json`。尽管保留了旧文件名，1.0.10 的实际内容同样是全局 `read:false/write:false`：客户端不能直接上传或读取头像、视频、场馆照片及任何其他云文件。用户头像由客户端根据公开 `playerId` 生成稳定系统头像；允许展示的球馆封面、历史已通过场馆照片和已上架教练头像，只能经 `api.files.resolve` 鉴权后取得短时 URL。历史媒体删除通过鉴权云函数完成。

云函数权限粘贴 `security-rules/cloud-functions.json`。`api` 仅允许微信登录态调用；媒体回调和注销清理任务禁止客户端直接调用。

## 索引

按照 `indexes.json` 创建组合索引、地理索引和普通单字段索引。索引清单是评审用的跨环境源文件，控制台的索引导入格式可能随云开发版本变化，因此不要将它当作命令直接导入。

上线前必须等待全部索引状态变为“可用”。当前 CloudBase 数据库不依赖 TTL 索引：`upload_tickets.expires_asc` 与 `rate_limits.expires_asc` 都是可在控制台创建的 `expiresAt` 单字段升序普通索引，过期记录由每小时触发的 `accountCleanup` 分批删除。不要在控制台把它们配置为 TTL。

球友关系使用 `player_friends.user_updated` 展示我的球友，并用 `player_friends.friend_updated` 在账号注销时清除反向关系；两个索引都必须先于新版 `api` 上线。球友录入功能使用唯一组合索引 `venues.city_name_key` 与普通索引 `venues.city_name` 查重，并为 `venue_submissions` 建立 `user_updated`、`status_submitted`、`target_status_submitted`、`reviewer_updated` 组合索引。注销清理还依赖 `coaches.user_updated` 与 `coach_applications.reviewer_updated` 定位教练账号和历史审核员；唯一生产环境必须等待这些索引可用。历史审核队列继续依赖相应索引；不能为联调放开客户端直接读写。

球友动态与回复在 1.0.10 已停用。`friendUpdates.list` 只返回 `items:[]` 和 `featureAvailable:false`；动态详情、发布、删除以及回复列表/发送均返回 `FEATURE_UNAVAILABLE`，不会新增 `player_updates` 或 `player_update_comments`。相关集合和索引仅为旧客户端降级、历史清理与回滚安全暂时保留，不应作为新功能依赖。

站内消息提醒使用 `message_inboxes.user_unread_updated` 查询当前用户的未读球局。每个用户在每场球局只有一条稳定收件箱记录；它只保存 `lastMessageId`、`unread/unreadCount` 和读写时间，不复制消息正文。正文仍只存在 `match_messages`。`messages.inbox` 批量重新校验成员状态、球局有效期、最新消息与双向屏蔽关系，并返回全部有效扫描记录的总未读数；客户端以该数驱动“我的”页和第 4 个自定义 Tab 红点。`messages.read` 只有在传入的 `messageId` 仍是最新指针时才原子清零，避免旧页面误清新消息。

新建 `venues.city_name_key` 唯一索引前，必须先备份数据，为所有旧 `venues` 补齐与服务端相同规则生成的 `nameKey`（名称 NFKC 标准化、移除空白、英文转小写），并按 `city + nameKey` 人工合并重复项。CloudBase 唯一索引会把缺失字段视为 `null`，未补齐时直接建索引会因多条 `null` 记录失败。不得为了建索引盲目删除球馆。

## 初始业务数据

本目录不附带会自动写库的球馆、球局或教练。完整场馆的生产供给必须由运营核实地址、经纬度、电话、开放时间和授权图片后，通过管理员 action 写入：

- `admin.venues.upsert`
- `admin.coaches.upsert`
- `admin.coachSlots.upsert`

用户提交的教练认证资料进入 `coach_applications`。授权运营人员可在“小程序 → 我的 → 运营管理 → 教练认证审核”处理；页面通过 `admin.coachApplications.pending/get/review` 获取分页队列、精确核对状态并通过或退回。审核通过只创建下架的教练档案，不会自动生成或开放时段；关联球馆必须是已上架的球馆目录记录。名称型球馆可表达授课地点，但不代表场馆资料核验或合作关系。

运营人员可在“小程序 → 我的 → 球馆与教练管理”删除错误、重复或停止运营的记录。删除接口只做带审计留痕的软删除，设置 `active:false/deleted:true`，不物理删除球局、预约、聊天或快照；因此无需级联清库。被删除记录不再出现在公开查询中，也不能用于新球局或新教练预约。

`hangzhou-venue-candidates.pending.json` 仅是待回访数据，所有记录均为 `active:false`、`verificationStatus:pending`。不得直接批量改成已核验；回访后逐条填写核验日期与 HTTPS 来源，再通过管理员 action 上架。

`default-venues.name-only.json` 是两条名称型默认场馆的管理员 action 输入，不是数据库直接导入文件，也不会由代码自动灌库。名称型记录只承诺“名称可供发布球局时选择”，不提供地址、导航、电话或平台核验背书；其公开响应固定为 `verified:false`、`partnerVerified:false`。完整场馆仍按原核验流程上架。

`activityTags` 只描述用户选择该名称时的约球场景，值限定为 `教学`、`比赛`、`训练`、`切磋`；完整场馆的类别继续写入 `tags`，器材与环境写入 `facilityTags`。名称型记录的标签来自默认配置或球友选填，不表示平台已核验场馆服务能力。

球友通过 `venues.create` 在一个事务内创建或复用 `venues` 名称型记录，并写入 `status:approved/publicationMode:instant` 的私有录入留痕，提交后立即可用。`admin.venueSubmissions.pending/review` 仅用于兼容上线前遗留的待审记录；旧驳回记录可由原用户按版本重提并直接公开。详情见 `docs/VENUE_ENTRY.md`。

球局只允许真实用户通过 `matches.create` 创建，生产库不导入预制球局。

## 数据约束

- 所有用户归属字段由服务端依据 `OPENID` 写入，不接受客户端的 `userId/openid/hostId`。
- 新 `venue_submissions.status` 由服务端直接写为 `approved`；历史记录仍允许 `reviewing → approved/rejected`、`rejected → approved`，申请人注销时历史待审记录转为终态 `withdrawn`。客户端传入的 `status/active/verificationStatus` 均不入库。
- `matches.version`、`coach_bookings.version` 用于乐观并发控制。
- `matches.create` 只接受 `venueId/date/startTime/endTime/capacity/feePerPerson/expectedBallAge/practiceIntent/joinMode/courtStatus/termsAccepted/termsVersion` 等结构化字段；标题由服务端生成，客户端传入的旧 `title/note/courtBookingNote` 不参与新球局内容。
- `matches.update` 只允许发起人在开球前按完整结构化表单更新，并同时校验 `expectedVersion` 与绑定意图的 `requestId`；总人数不能小于已加入人数，变更球馆或时段会递增 `scheduleVersion`、把订台状态重置为 `unbooked` 并要求成员重新确认。
- `match_members` 文档 ID、球局创建 ID、消息 ID、预约 ID均由服务端按用户和 `requestId` 计算，保证重试幂等。
- 直接加入和教练时段扣减均使用数据库事务，不能用客户端“先查再写”替代。
- 用户公开资料和成员快照的 `avatarFileId` 在 1.0.10 presenter 中固定为空，界面只显示基于 `playerId` 的系统头像。`profile.avatar.*` 与 `files.prepareUpload` 均返回 `FEATURE_DISABLED`，不创建上传凭证或新审核记录。升级前的头像、比赛视频和场馆照片记录仅保留运营处置、兼容删除及注销清理；历史状态不得使用户头像或个人视频重新公开。
- `audit_logs`、`reports` 属于敏感运营数据，客户端永远不可读取。
- `accountCleanup` 每小时处理注销清理任务，并通过 `expiresAt` 普通索引分别限量清理过期 `upload_tickets` 与 `rate_limits`；任一过期集合清理失败不会阻断注销任务。注销只取消未来已确认预约，历史预约保留状态并去标识；教练申请和关联档案去标识后下架；任务完成时自身的原始用户标识也替换为稳定删除引用。应对连续失败和长期清理积压配置云函数告警。
