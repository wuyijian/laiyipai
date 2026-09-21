# 微信云开发生产部署

> 本文是人工发布清单。修改仓库文件不会自动部署云函数、改安全规则或发布小程序；每一步都必须由有权限的管理员在控制台执行并留存结果。

## 1. 核对唯一生产环境

1.0.10 当前只启用一个 CloudBase 环境：`laiyipai-d2gks4fmq84ce6b44`。`utils/cloud-config.js` 的 `productionCloudEnvId` 固定为该值，`cloudEnvId` 保持为空；开发版、体验版和正式版都会通过 `resolveCloudEnvId()` 连接同一生产环境。仓库中没有可用于真库联调的独立测试环境。

因此不得在该环境运行自动化写入测试、导入虚构供给或使用不可回收的测试账号。需要联调写操作时使用本地内存仿真；确需真机验证时，只使用明确标记且可清理的测试球局。并确保 `project.config.json` 包含正式 AppID 及：

```json
"cloudfunctionRoot": "cloudfunctions/"
```

客户端首次启动时，在用户确认微信隐私保护指引之后调用 `api.bootstrap(true)`；封装会发送当前 `consentVersion`。不能在同意前创建用户记录。

## 2. 配置数据库与存储

按 `database/README.md` 在唯一生产环境创建集合、索引和安全规则。新增的 `venue_submissions` 必须先创建并等待四个组合索引可用；新增的 `player_friends` 必须先创建并等待 `user_updated`、`friend_updated` 两个索引可用；`message_inboxes.user_unread_updated` 也必须可用，再部署新版 `api`。所有数据库集合对客户端设为 `read:false/write:false`，页面代码不得调用 `wx.cloud.database()`。

云存储应用 `database/security-rules/storage-owner-only.json`。规则仅允许登录用户向自己的 `user-avatars/` 路径写入不超过 5MB 的 JPG/JPEG/PNG；公开头像、球馆封面和已上架教练头像由 `api.files.resolve` 鉴权换取短时 URL。视频与新增场馆照片上传保持关闭。

个人历史视频、历史用户头像媒体与场馆照片记录暂不物理删除，只保留兼容删除、运营处置和账号注销清理能力。不要为了 1.0.10 放开任何客户端存储路径。

## 3. 配置云函数变量

在 `api` 函数中设置：

- `LAIYIPAI_PRIVACY_POLICY_VERSION=2026-09-13`：必须与 `utils/cloud-config.js` 一致；版本变化后需让存量用户重新确认。
- `LAIYIPAI_TERMS_VERSION=2026-09-13`：必须与客户端用户协议版本一致。
- `LAIYIPAI_ADMIN_OPENIDS=...`：首批运营管理员 OPENID，建立管理员后应尽量缩短并定期复核。
- `LAIYIPAI_COACH_CANCEL_HOURS=12`：教练预约免费取消窗口。

生产环境 ID 是客户端初始化所需的公开配置，当前已固定写入 `utils/cloud-config.js`；不得把 AppSecret、商户密钥或管理员 OPENID 提交到源码。

部署 `api` 并配置管理员 OPENID 后，管理员需要退出并重新进入小程序，让 `bootstrap.capabilities.adminVenueReview/adminCoachReview` 刷新。“我的”页出现运营审核入口只代表页面提示；普通账号即使手工直达页面，也必须由云函数返回 `FORBIDDEN`。

## 4. 部署函数

新建云函数优先使用平台当前支持的 Node.js LTS。现有 `api` 仍兼容 Node.js 16，`mediaCallback` 与 `accountCleanup` 使用 Node.js 20.19；运行时升级应单独安排回归窗口，不与普通代码发布捆绑。三个目录均精确锁定官方稳定版 `wx-server-sdk@4.0.2`，发布前不要临时降级依赖或执行 `npm audit fix --force`。

1.0.10 的业务更新必须先部署：

1. `cloudfunctions/api`
2. `cloudfunctions/mediaCallback`
3. `cloudfunctions/accountCleanup`

`mediaCallback` 是头像异步审核链路的一部分。部署后启用 `event/wxa_media_check → mediaCallback` 消息订阅；回调只根据可信 `trace_id` 更新本人头像审核记录，审核通过后才公开新的 `avatarFileId`。

本次客户端使用 API v2，并保留 API v1 的滚动升级兼容。新版 `api` 停用公开动态与回复，保留头像与教练能力，并提供 `matches.update`、`messages.inbox/read` 等路由。必须先部署云函数再上传新版小程序，避免客户端调用尚未上线的 action。

`api/config.json` 已声明 `security.msgSecCheck` 与 `security.mediaCheckAsync`。用户文字使用 `msgSecCheck` 并失败关闭；头像登记后调用 `mediaCheckAsync`，结果由 `mediaCallback` 收敛。上传后若内容检测遇到 `-604101`，先确认云调用权限已生效。

在云函数权限控制中应用 `database/security-rules/cloud-functions.json`。`mediaCallback` 和 `accountCleanup` 对客户端必须是禁止调用。

## 5. 头像审核与历史媒体

用户未设置或头像审核未通过时，由 `utils/avatar.js` 根据公开 `playerId` 生成稳定系统头像。用户主动选择头像后，客户端经一次性凭证上传，登记审核并轮询状态；审核通过后通过 `files.resolve` 展示，超时状态允许重试。

`event/wxa_media_check → mediaCallback` 必须启用，并完成一张真实头像的通过/拒绝回调验证。个人比赛视频和新增场馆照片仍不得上传；相关历史记录只供运营处置、兼容删除与注销清理。

## 6. 导入真实供给

通过管理员 action 写入已核验的杭州球馆、教练和时段。用户录入的新球馆经文本安全和同名校验后立即成为名称型目录记录；`admin.venueSubmissions.pending/review` 仅处理旧版遗留待审记录。部署前先复核已有 `source:community` 记录，无法确认的先下架。教练认证申请通过 `admin.coachApplications.pending/get/review` 分页读取、精确核对并审核；可关联任一已上架的球馆目录记录，名称型记录只表示授课地点，不代表场馆认证或合作关系。通过后生成的教练仍保持下架，运营补齐真实时段后再上架。每条完整球馆至少核实：正式名称、详细地址、经纬度、营业状态、联系电话/官方预约方式和图片授权。`database/hangzhou-venue-candidates.pending.json` 可作为回访队列，但默认全部下架；逐条补齐 `verificationDate` 后才可上架。不要把候选记录误标为合作场馆。

## 7. 前端切换

页面只从 `utils/api.js` 取数和写入：

- 启动：`api.bootstrap`
- 首页：`api.venues.*`、`api.matches.list`、`api.coaches.list`
- 同场球友：`api.friends.list`；公开动态与回复路由统一返回 `FEATURE_REMOVED`；`api.matches.list` 的 `friendsOnly:true` 只允许登录用户使用
- 发布与球局详情：`api.matches.*`
- 预约：`api.appointments.list`、`api.coachBookings.*`
- 对话与提醒：`api.messages.list/send/inbox/read`；`messages.inbox` 驱动“我的”页及第 4 个自定义 Tab 的未读红点
- 我的：`api.profile.*`、`api.favorites.*`、`api.coachApplications.*`、`api.venues.submissions.*`
- 媒体显示：`api.files.resolve` 解析获准的用户头像、球馆和教练媒体；不要把临时 URL 持久化

生产工程已移除旧的本地业务数据文件。云请求失败时显示重试/空状态，绝不能静默回退到本地数据，否则会产生假球局和状态分叉。

## 8. 上线门禁

- 两个真实微信账号并发抢最后一个名额，只能一人成功。
- 申请制球局完整跑通申请、拒绝、通过、取消、改期和逐人确认。
- 直接加入或申请获批后，双方在 `player_friends` 中形成双向关系；同一球局重试不增加共同场次，候补、待审批和被拒绝申请不建立关系，“球友局”不展示被拉黑用户参与的球局。
- 非成员无法读写群聊；被拉黑双方互相不可见。
- 相同 `requestId` 重放创建、加入、发消息和预约，不产生重复数据。
- `matches.create` 与 `matches.update` 保留标题和备注并校验内容安全；编辑仅发起人可用，以 `expectedVersion` 和 `requestId` 防并发覆盖与异意图重放，变更球馆或时段时重置订台状态并要求成员重新确认。
- 新消息只为有效成员维护每人每局一条 `message_inboxes` 指针；收件箱总未读数正确驱动“我的”页与自定义 Tab 红点，进入最新消息后用 `messages.read` 清零，旧消息 ID 不能误清新消息。
- 内容安全不可用时，用户内容不落库。
- 头像选择、上传、审核中、通过、拒绝、超时重试和删除链路均通过真机验证；未通过的头像不得公开。比赛视频和新增场馆照片仍无上传入口。
- 首页与球友页无动态/心得/公开回复入口；旧动态详情链接仅展示下线提示；云端旧客户端直接调用同样被拒绝，不读取、写入或删除历史动态。
- 教练申请完整跑通未提交、审核中、通过和退回四态；运营审核通过后生成的教练必须保持下架，补齐真实球馆与可约时段后再上架。
- 新球馆完整跑通即时可用、同名并发复用、文本安全拒绝不落库，以及历史待审记录的审核与申请人注销撤回。
- `app.json` 不声明未使用的第三方插件，客户端不存在对应的运行时加载代码。
- 注销后立即无法继续调用；小时清理任务只取消未来已确认预约并释放对应名额，历史预约保持原状态但去标识，同时去标识并下架关联教练资料、删除媒体，最终确认 `account_deletion_jobs` 不再保存原始 `userId/openid`。
- 为云函数错误率、P95 延迟、内容审核积压、注销任务失败和数据库用量设置告警。
- 教练费用和球局费用当前仅为信息展示，不包含微信支付、退款和对账；接入微信支付前不得宣称已在线收款。

完成以上门禁后再提交体验版审核，并在正式发布前备份数据库、导出索引清单、冻结 API v2 契约。
