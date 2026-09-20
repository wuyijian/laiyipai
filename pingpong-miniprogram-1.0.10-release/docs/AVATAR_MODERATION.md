# 头像内容安全审核

## 为什么会一直显示“审核中”

`security.mediaCheckAsync` 成功只表示微信接收了任务，并返回用于关联结果的 `trace_id`，不代表图片已经通过。微信会在 30 分钟内把结果作为 `MsgType=event`、`Event=wxa_media_check` 的消息推送到小程序配置的消息接收端。CloudBase 只有建立消息推送订阅后，才会把这类事件转换成 JSON 并调用 `mediaCallback`。

因此，仅部署 `mediaCallback` 云函数，或者在函数详情里看到它处于“可用”，都不足以接收结果。SCF 详情中的普通触发器列表为空也不能证明消息推送已经配置。

参考：

- [微信 `security.mediaCheckAsync` 接口](https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/sec-check/security.mediaCheckAsync.html)
- [CloudBase 使用云函数接收微信消息推送](https://docs.cloudbase.net/practices/use-wechat-message.html)

## 数据流

1. 客户端先取得一次性上传凭证并把 JPG/PNG 上传到本人 `user-avatars/` 路径。
2. `api/profile.avatar.register` 获取临时下载 URL，调用 `security.mediaCheckAsync`，将 `trace_id`、请求时间和 35 分钟恢复期限写入 `user_media`。
3. 微信消息推送以 `event/wxa_media_check` 调用 `mediaCallback`。
4. `mediaCallback` 按 `trace_id` 找到待审记录：`pass` 才把 `users.profile.avatarFileId` 切换为新头像；`risky/review` 拒绝并删除新文件；微信下载或服务异常标记为 `failed`，文件暂留供用户重试。
5. “我的”页可见期间会退避轮询状态。超过 35 分钟仍未收到结果时，API 对外返回 `timed_out`，页面停止无限显示“审核中”，并提供“重新提交”。重试复用同一云文件，生成新的 `trace_id`，无需用户重新选图。

## 必须完成的云端订阅

在微信开发者工具的云开发控制台进入“设置 → 全局设置 → 消息推送”，新增并启用：

| 配置项 | 值 |
| --- | --- |
| 消息类型 | `event` |
| 事件类型 | `wxa_media_check` |
| 云环境 | 当前实际保存 `user_media` 的环境 |
| 云函数 | `mediaCallback` |

仓库中的 `cloudfunctions/mediaCallback/message-push.subscription.json` 是同一配置的机器可读清单。若使用 CloudBase 管理工具，应先读取现有消息推送配置，再以该清单做合并订阅，不能覆盖其他事件。

同一个小程序 AppID 的同一 `(消息类型, 事件类型)` 只能推送到一个环境的一支云函数。测试环境和生产环境共用 AppID 时，不能同时各订阅一份：开发版、体验版和审核版本连接测试环境，因此联调与提审期间应指向测试环境；审核通过后、点击正式“发布”前再切到生产环境。每次切换都要确认回调函数与实际保存 `user_media/users` 的环境一致。

## 部署与验证顺序

1. 部署新版 `api` 和 `mediaCallback`，都选择“云端安装依赖”。
2. 确认 `api/config.json` 已授权 `security.mediaCheckAsync`；等待云调用权限缓存生效。
3. 按上一节建立消息推送订阅。`mediaCallback` 继续禁止小程序客户端直接调用；消息推送由平台通道触发，不需要开放客户端调用权限。
4. 用真机上传一张正常头像，记录对应 `user_media.moderationTraceId`。
5. 在 30 分钟内核对 `mediaCallback` 调用日志，并确认该记录变为 `passed`、`users.profile.avatarFileId` 等于新文件 ID、页面自动显示新头像。
6. 用测试违规图片验证 `rejected` 且新文件被删除；用错误 URL 的模拟回调验证 `failed` 后可以重新提交。
7. 对历史 `reviewing` 记录：进入“我的”页应显示“审核结果没有按时返回”；订阅接通后点击“重新提交”，核对新的 `trace_id` 收到回调。

可以在云函数控制台用以下 JSON 测试回调解析，但这只能验证代码，不能代替真实的消息推送订阅：

```json
{
  "MsgType": "event",
  "Event": "wxa_media_check",
  "trace_id": "替换为数据库中真实的待审任务号",
  "errcode": 0,
  "result": { "suggest": "pass", "label": 100 }
}
```

## 监控

- 告警 `INVALID_MEDIA_CALLBACK` 和 `MEDIA_CALLBACK_TARGET_NOT_FOUND`。
- 每小时统计数据库中真实状态仍为 `reviewing` 且 `moderationDeadlineAt` 已过期的记录；生产环境出现记录时，先检查消息推送是否仍指向生产环境。
- 不得因超时自动公开头像；只有微信明确返回 `pass` 才能更新公开资料。
