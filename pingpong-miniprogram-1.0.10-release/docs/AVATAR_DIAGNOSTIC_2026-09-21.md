# 头像审核投递诊断（2026-09-21）

所有时间均为北京时间 UTC+8。本记录不表示问题已修复。

## 范围

- AppID：`wxdbcd8fd8a8014055`
- 唯一当前生产环境：`laiyipai-d2gks4fmq84ce6b44`，上海。
- 提交函数：`api`；审核结果函数：`mediaCallback`；记录集合：`user_media`。
- 本轮只读检查生产配置与业务数据，未修改订阅、权限、函数代码或审核结论。

## 已确认的证据

1. 环境归属小程序、提交账号的 `appId` 与上述 AppID 一致，账号状态为 active。
2. 用户提供的微信消息推送页面提示 `event:wxa_media_check` 已转交云函数；服务器 URL 留空不是该事件缺少接收地址的证据。
3. 较早的开发工具控制台检查显示 `event / wxa_media_check` 启用并指向生产环境的 `mediaCallback`。本轮重新打开控制台未成功，不能将较早截图当作本轮再次核验。
4. `mediaCallback` 为 Active / Available，入口 `index.main`，Node.js 20.19，依赖已安装。CLS 已启用。
5. 文件信息检查成功，头像文件存在、类型为 `image/jpeg`。这不等价于已验证微信扫描服务器成功下载提交时的临时 URL。
6. 查询时段内 API 调用和环境网关流量正常。回调函数监控返回的样本只有此前的诊断调用，未发现真实审核调用。稀疏或缺失监控样本不应被当成完整的逐分钟零值。
7. 可查日志未发现 `EXCEED_AUTHORITY`、`ACTION_FORBIDDEN`、`UnauthorizedOperation`、`AccessDenied`；未发现该回调函数的网关调用记录。未找到记录不等于已排除微信平台内部投递拒绝。

## 两次真实审核请求

| 项目 | 开发工具提交 | 手机微信提交 |
| --- | --- | --- |
| 提交时间 | 20:21:51 | 21:24:50 |
| 网关 source | wx_devtools | wx_client |
| API 动作 | profile.avatar.retry | profile.avatar.retry |
| API 结果 | OK | OK |
| API 处理耗时 | 1350 ms | 1146 ms |
| 业务 requestId | req_mub7stbs_5zc51k72a6 | req_muba1tu5_5hq9p317b3 |
| SCF requestId | 1bcaa984-114d-4552-96c9-679d744bec4c | cfd34e97-fbb9-412c-b874-e5b776507daf |
| 微信 trace_id | 6ab1215e-08e727ba-410d9139 | 6ab13022-107eb9ee-05ee39ea |
| 应用 35 分钟超时截止 | 20:56:51 | 21:59:50 |

第一条超过应用等待期限后仍未找到真实回调。第二条在本轮 21:28 检查时仍在等待窗口内，不能提前判定失败。重试会替换同一媒体记录中的审核编号；后续必须使用最新编号核对。

## 诊断探针与真实回调分开计算

- 20:11 的空参数探针返回 `INVALID_MEDIA_CALLBACK`，只能证明函数启动。
- 21:26 的结构化探针先查询并确认 `diagnostic-readonly-no-avatar-20260921-1327` 不存在，再传入 `MsgType=event / Event=wxa_media_check`。
- 结构化探针返回预期的 `MEDIA_CALLBACK_TARGET_NOT_FOUND`，SCF requestId 为 `92595453-e1f5-410e-b0b9-f2359a6828df`，执行约 934 ms，证明事件解析和审核表查询可执行。
- 上述两条都不是微信真实回调；不存在媒体目标，未将任何真实图片标记为通过。

## 权限与诊断边界

- 回调函数保持客户端 `invoke:false`，未放开公开调用。函数安全规则主要约束客户端调用，不能单凭该值认定平台推送被拦截。
- 当前工具身份读取 `TCB_QcsRole` 的 `cam:ListAttachedRolePolicies` 被拒绝。诊断查询 requestId：`9a2e0b9d-9293-4e68-bd3a-7a6b273ac032`。
- 这表示诊断账号缺少角色策略读取权限，不证明回调运行身份缺少调用权限。没有擅自增加 CAM 权限。
- 微信公众平台后台的自动浏览受安全策略限制，未尝试绕过。用户截图可用于核对页面信息。

## 当前结论及下一步

已确认历史请求“已受理但审核结果没有在目标函数中落地”。尚不能从用户可见日志确定是微信扫描任务、事件转发绑定、投递权限，还是平台内部异常。

1. 手机这次请求应在 21:59:50 之后再做终态检查，期间不要重复提交。实际通过/拒绝应以真实回调及数据库终态为准。
2. 若仍无结果，请平台支持按手机请求 trace_id 和 AppID 查询任务状态、图片下载结果、实际投递环境/函数、投递时间、返回错误码及重试情况。普通业务日志不能代替平台侧投递记录。
3. 如需重新保存/重建订阅做对照实验，须另行确认生产配置变更；不得直接开放回调函数给客户端，也不得手工标记审核通过。

参考：[CloudBase 云函数安全规则](https://docs.cloudbase.net/cloud-function/security-rules)。
