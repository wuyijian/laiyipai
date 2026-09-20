# 来一拍云 API v2 契约

## 统一调用

所有业务请求只调用云函数 `api`：

```js
wx.cloud.callFunction({
  name: 'api',
  data: {
    apiVersion: 2,
    action: 'matches.join',
    payload: { matchId: '...' },
    requestId: 'req_唯一值'
  }
})
```

成功响应固定为：

```json
{ "ok": true, "data": {}, "requestId": "req_唯一值" }
```

业务失败固定为：

```json
{
  "ok": false,
  "error": { "code": "MATCH_FULL", "message": "球局已满，可选择加入候补", "details": null },
  "requestId": "req_唯一值"
}
```

`requestId` 必填，长度 8—80，只可包含字母、数字、`_`、`-`。同一次用户操作的网络重试必须复用同一个值。客户端封装位于 `utils/api.js`，不提供 mock 或本地缓存回退；云端失败会直接抛出 `CloudApiError`。

1.0.10 只有生产环境 `laiyipai-d2gks4fmq84ce6b44`。客户端不直连云数据库；云存储仅允许本人头像路径的受限写入，所有公开媒体解析和历史媒体清理都必须经过本契约中的 action。

服务端在滚动升级期间同时接受 API v1 和 v2；v1 仅用于已上传旧客户端的过渡兼容，所有新客户端统一发送 v2。部署顺序固定为先更新 `api` 云函数，再上传新版小程序。

## 身份与资料

| action | payload | data |
| --- | --- | --- |
| `bootstrap` | `{consentAccepted, consentVersion}` | `{authentication:{provider:'wechat',authenticated:true},profile,capabilities,policies,serverTime}`；`capabilities.adminVenueReview/adminCoachReview` 是服务端按当前账号角色及管理员白名单计算的入口提示；首次建档或协议升级时必须明确同意当前版本，身份只取微信云函数上下文 |
| `profile.get` | `{}` | 当前用户脱敏资料 |
| `profile.update` | 昵称、城市、地区、球龄、技术、第三方积分的任意白名单字段 | 更新后的资料；文本先经过内容安全检测 |
| `players.get` | `{playerId}` | 从具体球局查看的球友公开资料；双向屏蔽时返回不可见。兼容字段 `videos` 固定为空数组，不查询或返回个人视频 |
| `friends.list` | `{page?,pageSize?}` | 当前用户的球友列表；确认加入同一球局后自动建立，返回公开资料和共同球局数；双向屏蔽及注销用户不返回 |
| `profile.avatar.register` | `{fileId,uploadToken}` | `{avatar:{status:'reviewing'}}`；必须先取得一次性上传凭证并上传云存储 |
| `profile.avatar.status` | `{}` | 最近头像审核状态；对外状态为 `reviewing/passed/rejected/failed/timed_out`，失败或超时可重试 |
| `profile.avatar.retry` | `{}` | 对本人最新失败或超时头像重新发起审核，复用原文件并保持请求幂等 |
| `profile.avatar.remove` | `{}` | `{deleted:true}` |
| `account.delete` | `{confirmation:'注销账号'}` | 立即注销并返回后台清理任务 ID；同一请求重试幂等，已暂停账号仍可注销 |

`profile.update` 不接受 `avatarFileId` 或 `videoFileIds`，防止绕过媒体审核。用户公开资料与成员快照只返回已审核通过的头像编号。

上传头像使用 `utils/api.js` 的 `profile.uploadAvatar`：先取得绑定本人、用途和路径的一次性凭证，再上传并登记审核。比赛视频和场馆照片的客户端上传方法保持移除。

`security.mediaCheckAsync` 的结果通过 `event/wxa_media_check → mediaCallback` 收敛，只有通过审核的头像才公开。超过审核窗口的记录对外显示为可重试超时态，但不会自动通过。

## 球馆与球局

| action | payload | data |
| --- | --- | --- |
| `venues.list` | `{city?,district?,keyword?,page?,pageSize?}` | 已上架球馆分页；每项包含 `listingMode:'full'|'name_only'` 与受控 `activityTags`。名称型记录没有地址或位置，且 `verified/partnerVerified` 均为 `false` |
| `venues.nearby` | `{latitude,longitude,radiusMeters?,pageSize?}` | 距离范围内已核验球馆 |
| `venues.get` | `{venueId}` | 已上架球馆详情；名称型记录不代表平台核验 |
| `venues.create` | `{name,activityTags?,confirmPublic:true}` | 新名称在事务中立即公开，返回 `{submission,venue,created:true,venueCreated:true,duplicateExisting:false,idempotent:false}`；同名已上架时返回 `{submission:null,venue,created:false,duplicateExisting:true,idempotent:true}` |
| `venues.submissions.list` | `{page?,pageSize?}` | `{items,page,pageSize}`；仅返回当前用户的球馆提交 |
| `venues.submissions.get` | `{submissionId}` | `{submission,venue}`；仅申请人可访问，已通过且仍上架时 `venue` 才非空 |
| `venues.submissions.resubmit` | `{submissionId,activityTags?,confirmPublic:true,expectedVersion}` | `{submission,venue,venueCreated,idempotent}`；仅申请人可将历史 `rejected` 记录按版本重提并直接公开 |
| `matches.list` | `{city?,district?,venueId?,date?,expectedBallAge?,friendsOnly?,page?,pageSize?}` | `{items,page,pageSize,hasMore}`；过滤发生在服务端，自动排除双向拉黑用户；`friendsOnly:true` 仅对登录用户开放，返回有球友确认参加的球局；传入全局唯一的 `venueId` 时忽略地区条件。新球局的 `venue` 快照包含经脱敏的位置，名称型球馆仍不返回地址或坐标 |
| `matches.get` | `{matchId}` | `{match,membership,confirmedCount,hostVideos}`；`match.venue` 可包含地址、位置和展示模式。兼容字段 `hostVideos` 固定为空数组，不查询或返回发起人的个人视频 |
| `matches.create` | `{venueId,title,date,startTime,endTime,capacity,feePerPerson,expectedBallAge,practiceIntent,note,joinMode,courtStatus,courtBookingNote?,termsAccepted,termsVersion}` | `{match,membership:{status:'host',canChat:true},idempotent}`；`practiceIntent` 只能为 `随便练练/切磋球技`，`capacity` 为 1—8 的整数，1 人球局不开放加入；自由文字经过内容安全检查 |
| `matches.update` | `{matchId,expectedVersion,title?,note?,courtBookingNote?,venueId,date,startTime,endTime,capacity,feePerPerson,expectedBallAge,practiceIntent,joinMode,courtStatus}` | `{match,idempotent,noop}`；仅发起人可在开球前修改。未提交的文字字段保持原值；球馆或时段变化时订台状态重置并要求成员重新确认 |
| `matches.join` | `{matchId,allowWaitlist?,termsAccepted,termsVersion}` | 直接加入为 `joined`，申请制为 `pending`，满员且明确允许时为 `waitlisted` |
| `matches.pending` | `{matchId}` | 仅发起人可见的申请和候补列表 |
| `matches.respondJoin` | `{matchId,membershipId,decision:'accept'|'reject',expectedVersion}` | 审批结果和新球局版本 |
| `matches.cancel` | `{matchId,reason,expectedVersion}` | 发起人取消整场；成员退出释放名额 |
| `matches.reschedule` | `{matchId,date,startTime,endTime,expectedVersion}` | 仅发起人可改期，递增 `scheduleVersion` |
| `matches.confirmSchedule` | `{matchId}` | 当前成员确认最新 `scheduleVersion` |

`matches.create/update/join/respondJoin/cancel/reschedule` 均由服务端校验身份和状态。发布、加入和教练预约还会校验当前用户协议版本并在业务记录中保存同意时间。直接加入、审批占位与取消释放名额使用数据库事务。

`matches.update` 要求同一表单提交携带完整结构化字段。它同时使用 `expectedVersion` 和 `requestId`：版本过期返回 `VERSION_CONFLICT`；同一 `requestId` 重放相同意图返回 `idempotent:true`，改换意图则返回 `IDEMPOTENCY_CONFLICT`；值未变化返回 `noop:true`。客户端必须刷新后让用户重新确认，不能静默覆盖。

球馆录入要求登录且账号可用，使用发布限流桶，并在写入前执行文本安全检测。普通用户只能查看自己的 `venue_submissions`，传入的 `userId/status/active/verificationStatus` 均被忽略。新记录由服务端直接写为 `approved/publicationMode:instant`，并与名称型公共球馆在同一事务中落库；历史状态 `reviewing/rejected/withdrawn` 继续兼容。响应不包含 OPENID、内部名称键或审核员身份。

名称做 NFKC、去空白和英文小写化；同一用户同名提交 ID 稳定，不同用户同名录入指向同一目标球馆 ID。新馆在事务内创建或复用 `source:community`、`listingMode:name_only` 的公开球馆；同名待审/停用目录冲突时不会自动重新上架。`venues.city_name_key` 必须建为唯一组合索引；建索引前须补齐旧数据的 `nameKey` 并清理 `city + nameKey` 重复项。上线还需要创建 `venue_submissions` 及其索引，详见 `docs/VENUE_ENTRY.md`。

## 场地照片

| action | payload | data |
| --- | --- | --- |
| `files.prepareUpload` | `{purpose:'avatar',extension:'jpg'|'jpeg'|'png'}` | 仅发放本人头像的一次性上传凭证；`video/venue_photo` 返回 `FEATURE_DISABLED` |
| `venuePhotos.register` | 旧版登记参数 | 已停用，返回 `FEATURE_DISABLED`，不写入媒体记录 |
| `venuePhotos.list` | `{venueId}` | `{items,limit:6}`；只返回自己的历史照片状态，未通过不返回 fileID |
| `venuePhotos.remove` | `{photoId}` | 仅本人可删除；事务移除公开引用并释放配额 |
| `admin.venuePhotos.pending` | `{pageSize?}` | 仅运营可见的待审核记录及短时 reviewUrl |
| `admin.venuePhotos.review` | `{photoId,decision:'pass'|'reject',reason?}` | 审核与公开引用事务更新；拒绝必须有原因 |
| `admin.venuePhotos.remove` | `{photoId}` | 运营下架已公开或待审核照片，记录审计并清理文件 |

场馆照片上传已移除，前端仅保留历史 `list/remove`。每馆最多公开 6 张历史用户贡献照片。审核通过的 `photoFileIds` 与官方封面合并返回；名称型球馆仍无地址、位置或认证标志。云存储写规则只允许本人头像路径，不能绕过 action 新增场馆照片。

## 球友动态与回复

以下路由保留 1.0.7 已审核能力；动态与回复全局可见，写入前执行身份、限流、双向屏蔽和文本安全校验：

| action | payload | data |
| --- | --- | --- |
| `friendUpdates.list` | `{page?,pageSize?}` | `{mine,items,page,pageSize,hasMore}`；返回未被双向屏蔽的公开动态 |
| `friendUpdates.get` | `{updateId}` | 动态详情与当前用户权限 |
| `friendUpdates.publish` | `{kind,content,availability?,timeNote?,venueName?,district?,ratingPlatform?,ratingValue?}` | 新动态；同一请求幂等 |
| `friendUpdates.remove` | `{updateId}` | 仅本人删除 |
| `updateComments.list` | `{updateId,page?,pageSize?}` | 公开回复分页 |
| `updateComments.send` | `{updateId,text}` | 发布回复；同一请求幂等 |

## 教练、预约和收藏

| action | payload | data |
| --- | --- | --- |
| `coaches.list` | `{city?,district?,venueId?,page?,pageSize?}` | 已认证且确有未来库存的教练及最多 6 个可约时段 |
| `coaches.get` | `{coachId}` | 单个教练及其全部未来可约时段（最多 100 条） |
| `coachApplications.get` | `{}` | 本人教练认证状态：`not_submitted/reviewing/approved/rejected` 及申请内容 |
| `coachApplications.submit` | `{realName,mobile,experienceYears,specialty,venueName,introduction?,qualification,expectedVersion?,termsAccepted,termsVersion}` | 创建申请或重新提交未通过申请；内容安全检查后进入 `reviewing` |
| `coachBookings.create` | `{slotId,note?,termsAccepted,termsVersion}` | 已确认预约；时段库存事务扣减 |
| `coachBookings.cancel` | `{bookingId,reason,expectedVersion}` | 取消并事务释放时段 |
| `appointments.list` | `{pageSize?}` | 球局和教练预约统一列表；逐人返回改期确认状态 |
| `favorites.list` | `{page?,pageSize?}` | `{items,page,pageSize,total,hasMore}`；支持分页，已下架球馆以可取消标记的最小占位项返回 |
| `favorites.status` | `{venueIds:[...]}` | 批量返回当前用户已标记的球馆 ID，最多 50 个 |
| `favorites.set` | `{venueId,marked}` | 明确设置收藏状态，天然幂等 |

## 群聊、历史视频兼容与安全

| action | payload | data |
| --- | --- | --- |
| `messages.list` | `{matchId,before?,pageSize?}` | 仅 `host/joined` 成员可读，自动隐藏双向拉黑用户消息 |
| `messages.send` | `{matchId,text}` | 内容检测后写入的消息；同 `requestId` 幂等 |
| `messages.inbox` | `{pageSize?}` | `{items,unreadCount,hasMore,recoveryPending}`；`pageSize` 默认为 5、最大 10。每项含 `matchId/messageId/unreadCount/sender/preview/match/createdAt`；服务端批量复核成员资格、球局有效期、消息状态与候选发送者的双向屏蔽。失效指针在事务中再次核对最新消息 ID 后清零，既不会挡住后续有效消息，也不会误清并发到达的新消息；需要继续渐进清理时 `recoveryPending:true`，客户端用有上限的指数退避追赶；达到 100 后统一显示 `99+` |
| `messages.read` | `{matchId,messageId}` | `{read}`；仅当 `messageId` 仍等于该会话最新消息指针时原子清零，防止旧页面把后到消息标为已读 |
| `videos.list` | `{}` | 仅供旧客户端识别和删除既有记录；只返回 ID、状态、拒绝原因和创建时间，不返回标题、时长、可见范围或文件 ID。当前客户端不调用、不展示 |
| `videos.register` | 旧版登记参数 | 已停用，返回 `FEATURE_DISABLED`，不写入媒体记录 |
| `videos.remove` | `{videoId}` | 软删记录并删除云文件 |
| `safety.block` | `{playerId,blocked}` | 拉黑或解除拉黑；`playerId` 是公开 ID，不是 OPENID |
| `safety.blocks.list` | `{}` | 当前用户的拉黑名单，用于设置页管理 |
| `safety.report` | `{targetType,targetId,category,details?}` | 创建举报单 |
| `files.resolve` | `{fileIds:[...]}` | 批量校验访问权并把 1—20 个获准的球馆封面、历史已通过场馆照片或已上架教练头像 fileID 转为短期 URL，响应固定为 `{urls:{"cloud://...":"https://临时地址"},unresolved:[]}`；不解析用户头像或个人视频 |

聊天在球局取消后只读，球局正常结束 24 小时后读写均关闭。发送消息时，服务端在同一事务内为每名有效成员维护一条稳定 `message_inboxes` 记录；发送者指针保持已读，其他成员累加未读数（最高 99）。客户端轮询 `messages.inbox`，以返回总数驱动“我的”页和第 4 个自定义 Tab 红点，进入会话后调用 `messages.read`。

所有仍开放的用户文本 fail-closed：微信内容安全服务不可用时不落库。用户使用系统头像，不进行上传或异步图片审核；历史比赛视频仅保留兼容删除、运营处置和注销清理，`players.get`、`matches.get` 与 `files.resolve` 均不再公开或解析其内容。

## 运营接口

运营接口除用户表 `role=admin` 外，还可用云函数环境变量 `LAIYIPAI_ADMIN_OPENIDS`（逗号分隔）建立首批管理员：

- `admin.venues.upsert`
- `admin.venues.list`
- `admin.venues.remove`
- `admin.venueSubmissions.pending`
- `admin.venueSubmissions.get`
- `admin.venueSubmissions.review`
- `admin.coaches.upsert`
- `admin.coaches.list`
- `admin.coaches.remove`
- `admin.coachSlots.upsert`
- `admin.coachApplications.pending`
- `admin.coachApplications.get`
- `admin.coachApplications.review`
- `admin.videos.pending`
- `admin.videos.review`

生产环境不包含任何自动 seed。以上接口输入必须来自人工核验或有授权的数据源。

`admin.venues.upsert` 的 `listingMode` 默认为 `full`，保持既有完整场馆兼容。完整场馆在 `verificationStatus:'verified'` 时强制要求地址、经纬度、`verificationDate` 与至少一个 HTTPS `sourceUrls`；`partnerVerified:true` 还必须提供内部 `partnershipReference`。`listingMode:'name_only'` 只需要名称、城市和 `activityTags`，不读取地址、经纬度、电话、图片或设施字段；即使已上架，公开响应也不会将它标记为资料已核验或合作场馆。`activityTags` 最多四项且只能为 `教学/比赛/训练/切磋`。

`admin.venueSubmissions.pending({page?,pageSize?})` 只返回 `reviewing` 队列及脱敏申请人快照，按最早提交优先，响应为 `{items,page,pageSize,hasMore}`。`admin.venueSubmissions.review({submissionId,expectedVersion,decision:'approve'|'reject',reason?})` 使用对象版本和请求 ID 保证并发与重试幂等；同一请求的重试必须复用原 `requestId`、`expectedVersion`、决定和理由，改变意图会返回 `IDEMPOTENCY_CONFLICT`。驳回必须填写 2—200 字理由，通过后返回 `{submission,venue,venueCreated,idempotent}`，幂等重试中的 `venueCreated` 与首次响应一致。审核人、时间、理由、请求号和版本随申请事务保存；独立 `audit_logs` 写入失败会记录 `AUDIT_WRITE_FAILED`，由运维补查申请记录。

`admin.venueSubmissions.get({submissionId})` 精确返回 `{submission,venue}`，可读取 `reviewing/approved/rejected/withdrawn` 全部状态；申请和申请人信息均经过管理员 presenter 脱敏，不返回 OPENID、审核人、内部名称键或请求号。仅在状态为 `approved` 且关联球馆仍上架时返回 `venue`。审核请求结果不确定时必须调用此接口核对，不能用 pending 第 1 页缺席推断已处理。

审核会使待审队列收缩，因此每次通过或驳回后应从第 1 页重新加载，不要在旧页码上继续做偏移翻页。

客户端可用 `bootstrap.capabilities.adminVenueReview/adminCoachReview === true` 分别展示球馆和教练审核入口，但这不是授权凭证。所有运营接口仍按云函数可信 OPENID、用户表 `role=admin` 或 `LAIYIPAI_ADMIN_OPENIDS` 鉴权；审核写事务还会重新读取管理员和申请人账号，防止权限撤销/账号注销并发穿透。`VERSION_CONFLICT.details` 会带当前 `currentStatus/currentVersion`，客户端应刷新队列；`VENUE_NAME_CONFLICT` 应交给运营查重处理；`FORBIDDEN` 应立即退出后台；`IDEMPOTENCY_CONFLICT` 不得自动重试，应生成新请求 ID 并在刷新后重新确认操作。

`admin.coaches.upsert` 在认证通过时强制要求 `verificationDate` 和不含证件号码的内部 `verificationReference`；只有已认证教练才能上架或创建时段。公开接口不会返回资料来源、合作记录或教练内部核验记录。

`admin.venues.list({page?,pageSize?,keyword?})` 与 `admin.coaches.list({page?,pageSize?,keyword?})` 分页返回未删除的管理记录，包括暂未上架项；响应继续使用脱敏 presenter，不返回用户标识、审核人或内部核验记录。`admin.venues.remove({venueId,reason?})` 与 `admin.coaches.remove({coachId,reason?})` 执行可审计软删除：在事务中再次确认管理员权限，并写入 `active:false/deleted:true`、删除人、时间、原因和请求号。公开列表、新球局和新预约立即停止使用该记录，历史球局、聊天和预约快照保留。对已删除记录重试返回幂等成功，不物理删除关联数据。

`admin.coachApplications.pending({page?,pageSize?})` 按最早提交优先返回 `{items,page,pageSize,hasMore}`；`admin.coachApplications.get({applicationId})` 可精确读取 `reviewing/approved/rejected` 状态，且不返回 OPENID、审核人或内部请求号。`admin.coachApplications.review` 审核通过时必须传入 `venueIds` 和 `verificationDate`，关联项必须是已上架的球馆目录记录；名称型球馆可以作为授课地点，但不因此获得完整资料核验或合作认证。`verificationReference` 仅为旧运营接口兼容字段，新客户端省略时由服务端根据审核请求自动生成。接口以申请版本和绑定审核意图的请求 ID 防止并发覆盖或异意图重放，并在事务中创建或关联 `coaches.userId`；已认证教练默认 `active:false`，运营补齐真实可约时段后才可上架。拒绝时必须返回可修改的原因。写结果不确定时先调用精确查询，不以待审列表缺席推断成功。

## 稳定错误码

客户端应分别处理：`UNAUTHENTICATED`、`BOOTSTRAP_REQUIRED`、`CONSENT_REQUIRED`、`CONSENT_VERSION_MISMATCH`、`TERMS_REQUIRED`、`TERMS_VERSION_MISMATCH`、`PUBLIC_CONFIRMATION_REQUIRED`、`INVALID_ARGUMENT`、`NOT_FOUND`、`FORBIDDEN`、`FEATURE_DISABLED`、`FEATURE_UNAVAILABLE`、`RATE_LIMITED`、`VERSION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`VENUE_NAME_CONFLICT`、`MATCH_FULL`、`MATCH_CLOSED`、`CHAT_CLOSED`、`SLOT_FULL`、`SLOT_CLOSED`、`CONTENT_REJECTED`、`CONTENT_CHECK_UNAVAILABLE`、`NETWORK_ERROR`、`INTERNAL`。
