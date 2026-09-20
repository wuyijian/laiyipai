# 1.0.10 数据存储架构与优化结论

## 总体结论

当前采用“原生微信小程序 + 单一 CloudBase 生产环境 + 统一 `api` 云函数 + 云数据库”。客户端不直连数据库，所有身份、权限、脱敏、幂等和事务都在云函数内完成。这个边界适合正式发布，不建议在 1.0.10 中改成客户端直读或同时引入第二套数据服务。

目前只有生产环境 `laiyipai-d2gks4fmq84ce6b44`。开发版、体验版和正式版都会读写同一套数据，因此本地自动化测试只能使用内存仿真，不得在真库灌测试数据。

## 分层

1. 小程序层：`utils/api.js` 只调用 `wx.cloud.callFunction`；本地只保存筛选、未提交草稿和协议版本，不保存 OPENID 或业务事实。
2. API 网关层：`cloudfunctions/api/index.js` 统一校验 API 版本、`requestId`、微信身份、限流和 action 白名单。
3. 业务层：球局、成员、消息、教练时段、预约、收藏、安全治理分模块处理。
4. 数据层：CloudBase 集合全部使用 `read:false/write:false`，云存储也使用 `read:false/write:false`。允许展示的球馆/教练媒体只能经 `files.resolve` 鉴权获取短时 URL，历史用户媒体只能经鉴权云函数处置。

## 业务集合

| 领域 | 集合 | 职责 |
| --- | --- | --- |
| 身份 | `users` | OPENID 主键、角色、账号状态、球龄、技术、第三方积分；`publicId` 用于对外关联 |
| 球馆 | `venues` / `venue_submissions` / `venue_favorites` | 公开目录、用户录入留痕、常去球馆 |
| 球局 | `matches` / `match_members` | 球局聚合根和每人每局状态。创建使用稳定 ID；编辑使用版本号与请求意图指纹；加入、审批和取消使用事务 |
| 球友 | `player_friends` | 已确认同场后自动生成的私有双向关系 |
| 消息 | `match_messages` / `message_inboxes` | 球局成员沟通正文，以及每人每局唯一的最新消息指针和未读计数；后者驱动“我的”页与自定义 Tab 红点 |
| 教练 | `coaches` / `coach_slots` / `coach_bookings` / `coach_applications` | 教练档案、库存时段、预约、认证申请 |
| 安全 | `user_blocks` / `reports` | 双向屏蔽和举报 |
| 运维 | `rate_limits` / `audit_logs` / `account_deletion_jobs` | 限流、写操作审计、注销去标识化 |

`matches` 保存球馆和发起人快照，`coach_bookings` 保存教练和球馆快照。这是有意的冗余：球馆或教练后续下架时，历史预约仍可解释，不需要级联删除。

## 兼容与待归档数据

- `player_updates` / `player_update_comments`：公开动态及回复已下线。`friendUpdates.list` 返回安全空响应，详情/发布/删除与回复路由返回 `FEATURE_UNAVAILABLE` 且不写入，避免 1.0.7 旧客户端报系统错误。
- `user_media` / `user_videos` / `upload_tickets`：只用于历史媒体删除、注销清理和运营留痕。1.0.10 不再提供头像、视频或场馆照片新增上传。
- 不可直接删除这些集合。`accountCleanup` 仍需它们完成存量账号注销和过期票据清理。正确顺序是：备份→确认无待审/无老客户端写入→修改清理任务→归档数据→删索引/集合。

## 1.0.10 已落地的存储与性能优化

1. `matches.create` 只提交球馆、日期、时段、人数、费用、球龄、练球类型、加入方式、订台状态和协议留痕等结构化字段；标题由服务端用“球馆名 · 练球类型”生成，旧客户端提交的 `title/note/courtBookingNote` 被忽略。
2. `matches.update` 只允许发起人在开球前提交完整结构化表单，以 `expectedVersion` 防止覆盖，并用 `requestId + 意图指纹` 保证重试幂等；球馆或时段变化会重置订台状态、递增 `scheduleVersion` 并要求成员重新确认。
3. 用户头像改为基于 `playerId` 的稳定系统头像；`profile.avatar.*` 与 `files.prepareUpload` 均停用，不再上传、轮询审核或解析历史头像 URL。
4. `files.resolve` 只查公开球馆封面、历史已通过的球馆照片和已上架教练头像；单次请求使用 3 类固定查询，不再查询用户头像。
5. 发球局首屏不再后台拉完全杭州球馆的所有分页。首页只取一页，名称/完整地址搜索按需请求一页；相同关键词使用 2 分钟、最多 8 项的页面级 LRU 缓存，避免长驻 Tab 无限增长或长期展示已下架记录。
6. `messages.inbox` 按成员、球局、消息和候选发送者的双向屏蔽记录分组批量查询，过滤失效会话后返回最多 10 个预览；空收件箱只做 1 次查询。失效指针会在事务中复核最新消息 ID 后安全清零，使后续有效消息不会被旧记录永久挡住；`unreadCount` 汇总有效记录而非只累加返回首页。“我的”页和第 4 个自定义 Tab 订阅同一客户端状态显示红点；`messages.read` 仅在最新消息 ID 匹配时原子清零。
7. 客户端相同并发读请求会合并；所有写入前后都作废在途读，防止旧响应覆盖新状态。

## 上线前必须确认

1. 先备份生产数据库，再部署任何云函数或安全规则。
2. 在 CloudBase 控制台核对 `database/indexes.json` 的关键索引均为“可用”，特别是 `matches`、`match_members`、`venues`、`venue_favorites`、`match_messages`、`message_inboxes`。
3. 顺序固定为：数据备份→数据库与云存储的全拒绝客户端规则及索引→兼容 API v1/v2 的 `api` 云函数→`accountCleanup`→客户端 1.0.10；`mediaCallback` 仅在仍需收敛升级前历史任务时保留。
4. 不在真库运行写入型测试；真机只使用明确的测试账号和可删除的测试球局。

## 后续优化（不阻塞 1.0.10）

- 球馆搜索从正则 + offset 分页升级为 `nameKey/searchTokens` + 游标分页。
- 为球馆目录增加短 TTL/版本缓存，按资源类型失效，而非每次写入清空全部读状态。
- 将 `audit_logs` 改为事务 outbox + 异步落库，避免业务成功但审计写入失败。
- 定义消息、审计、举报和已结束球局的保留期与归档任务。
- 新建独立的预发布环境后，再恢复开发/体验/正式数据隔离。
