# 球友标记新球馆

## 用户流程

1. 用户输入 2—60 字球馆名称，可选「教学 / 比赛 / 训练 / 切磋」标签。城市固定为杭州，不收集地址、定位或照片。
2. 客户端调用 `venues.create`。已有公开同名球馆时直接返回 `duplicateExisting:true` 和可选球馆；否则在一个事务中创建名称型公共球馆及状态为 `approved` 的私有提交记录，提交后立即可用于发布球局。
3. 同名、同城的停用或待处理运营记录不会被用户录入重新上架，接口返回 `VENUE_NAME_CONFLICT`，交由运营处理。
4. 用户从 `venues.submissions.get/list` 可看到自己的录入记录；详情响应同时返回仍在上架的公开 `venue`。
5. 旧版本遗留的 `reviewing/rejected` 记录继续兼容管理员审核；旧驳回记录由原申请人按 `expectedVersion` 重提后直接公开。改名视为新录入。

## API 契约

- `venues.create({name, activityTags, confirmPublic:true})`
  - 新录入：`{submission, venue, created:true, venueCreated:true, duplicateExisting:false, idempotent:false}`，`submission.status` 为 `approved`
  - 同名已上架：`{submission:null, venue, created:false, duplicateExisting:true, idempotent:true}`
- `venues.submissions.list({page,pageSize})` 仅返回当前 OPENID 的申请。
- `venues.submissions.get({submissionId})` 仅允许申请人访问；已通过且球馆仍上架时附带 `venue`。
- `venues.submissions.resubmit({submissionId,activityTags,confirmPublic:true,expectedVersion})` 仅允许申请人把历史 `rejected` 记录按版本直接转为 `approved` 并返回公开 `venue`。
- `admin.venueSubmissions.pending({page,pageSize})` 仅返回旧版本遗留的 `reviewing`，不返回申请人 OPENID；按最早提交优先返回 `{items,page,pageSize,hasMore}`。
- `admin.venueSubmissions.get({submissionId})` 精确返回 `{submission,venue}`，用于弱网后核对 `reviewing/approved/rejected/withdrawn` 实际状态；只有已通过且仍上架的球馆才附带 `venue`。
- `admin.venueSubmissions.review({submissionId,expectedVersion,decision,reason})`：`decision` 为 `approve/reject`；驳回理由必填 2—200 字。

`submission` 公开字段为 `id/venueId/name/city/activityTags/status/reviewReason/version/submittedAt/reviewedAt/updatedAt`。客户端仍以 `status === 'approved'` 且存在 `venue` 为可选条件，以兼容已下架球馆和历史数据。

## 数据、去重与权限

- `venue_submissions/{hash(OPENID,city,nameKey)}` 是私有录入留痕；`userId`、`reviewedBy`、内部请求 ID 均不通过 presenter 返回。即时公开记录带 `publicationMode:instant`，旧审核记录保持原结构。
- `nameKey` 对名称做 NFKC 标准化、去空白和英文小写化。同一用户同名录入的稳定 ID 防止重试重复写入；不同用户同名录入共用稳定目标球馆 ID，并在事务中复用同一公开记录。`venues.city_name_key` 唯一索引作为最终竞态保护，唯一键冲突映射为 `VENUE_NAME_CONFLICT`。
- 旧 `venues` 记录没有 `nameKey` 时仍用城市 + 精确名称兼容查找。不自动判定别名或同品牌分店。
- 普通用户传入的 `userId/status/active/verificationStatus/listingMode/source` 均不入库；即时公开字段全部由服务端生成。历史审核 action 必须通过 `requireAdmin`。
- 申请人注销时，待审单由账号清理任务转为终态 `withdrawn` 并去标识化；审核队列和审核路由均不会再处理它。
- `bootstrap.capabilities.adminVenueReview` 由服务端根据用户表角色和 `LAIYIPAI_ADMIN_OPENIDS` 计算，只用于显示后台入口；它不是授权凭证，所有管理 action 仍在云端鉴权。个人资料不返回或接受可由客户端修改的 `role`。
- 审核使用事务、`expectedVersion` 和 `reviewRequestId` 同时防止并发覆盖及超时重复操作，提交时还会在事务中重新确认管理员权限和申请人账号状态。同一请求号只能重放完全一致的版本、决定和理由，否则返回 `IDEMPOTENCY_CONFLICT`。申请记录本身原子保存审核人、时间、理由、请求号、是否新建球馆和版本；系统另写 `audit_logs`，若出现 `AUDIT_WRITE_FAILED` 必须由运维告警补查申请记录，不能把日志写入成功当作审核成功的前置条件。
- 同名待审或停用的运营球馆会使即时录入或历史审核返回 `VENUE_NAME_CONFLICT`，不会被自动覆盖或意外重新上架。

## 历史记录运营审核

1. 新录入不进入审核队列。授权账号可从历史管理入口调用 `admin.venueSubmissions.pending`，处理旧版本遗留的待审记录。
2. 可确认为真实球馆名称时选择 `approve`。事务内生成 `listingMode:name_only`、`source:community`、`active:true`的公开记录；这只表示「名称可用于约球」，不表示平台实地核验。
3. 无法确认或名称不完整时选择 `reject`，填写可执行的修改理由。
4. 返回 `VERSION_CONFLICT` 时刷新队列，不要盲目重放；返回 `VENUE_NAME_CONFLICT` 时先在目录中合并或处理冲突记录。
5. 每次通过或驳回后从第 1 页重新加载队列，避免偏移分页在队列收缩后跳过记录。请求超时或网络中断时，使用 `admin.venueSubmissions.get` 按 ID 核对，不能以待审第 1 页里没有该记录推断审核已完成。

## 部署

1. 上线前盘点已有 `venues.source:community` 记录；明显虚假或错误项设为 `active:false`。用户即时录入仍可由运营通过目录管理和举报流程下架。
2. 在测试和生产环境创建 `venue_submissions`，应用拒绝客户端直读写的数据库安全规则。
3. 先备份 `venues`，为全部旧记录补齐 `nameKey` 并人工合并 `city + nameKey` 重复项，再建立唯一组合索引 `venues.city_name_key`。缺失字段在 CloudBase 唯一索引中视为 `null`，不可跳过迁移直接建索引。
4. 按 `database/indexes.json` 创建 `venue_submissions.user_updated/status_submitted/target_status_submitted/reviewer_updated`，并确认 `venues.city_name` 可用。
5. 先部署完整 `cloudfunctions/api` 和 `accountCleanup`，都选择云端安装依赖；配置 `LAIYIPAI_ADMIN_OPENIDS`，确认云端路由可用后，再发布含用户申请及内置审核页的小程序。不要先发客户端再部署云函数。
6. 上线前用两个普通账号和一个运营账号验证：新馆提交即选中并可发布、同名并发只建一条公共球馆、内容安全失败不落库、注销并发不落库，以及旧待审记录仍可审核。

本地自动测试不等于云端已部署；不得为联调放开数据库客户端权限或跳过文本安全检查。
