# 2026-09-28 生产部署记录

目标小程序 AppID：`wxdbcd8fd8a8014055`。生产 CloudBase 环境：`laiyipai-d2gks4fmq84ce6b44`。本次客户端版本：`1.0.11`。代码来源：`codex/integrate-sep28`，整合首页性能、球友目录、自愿开启的附近展示和球馆评价；没有恢复动态、头像更换、照片或视频上传。

## 已执行

- 发布前 `npm test`、`npm run test:cloud`、`npm run check:structure`、`npm run check:release` 全部通过。
- 沿用生产既有的 `users.public_id_status`，新增 `users.status_district_public_id`、`users.nearby_enabled_expiry`；生产读取确认索引均存在。CloudBase 不允许创建与 `public_id_status` 字段集合相同、仅顺序相反的 `status_public_id`，故更新了索引清单与发布检查。
- 生产 `venue_reviews` 集合、评价索引及 `venues` 地理索引经核对已存在。
- 旧版生产 `api` ZIP 已备份至主工作区 `C:/Users/Administrator/Documents/ChatGPT/创客/deployment-backups/2026-09-28/api-before-integration-cd9d48f268d7.zip`，7,537,841 字节，SHA256 `CD9D48F268D7B9797D5AA7C3BF5FC7A4EBEB4716D9B5E0976F51D5BF902C4A71`，与云端返回哈希一致。
- 生产 `accountCleanup` 已更新代码，原有 10 分钟定时触发器保留。22:10 的定时执行返回成功，过期记录与附近位置清理均 `failed:0`。该更新原本只拟作预演，但 CloudBase 工具忽略了 `dryRun:true, confirm:false` 并实际部署；发现后已停止使用该工具做预演，并核验触发器及运行状态。
- 生产 `api` 已更新代码，22:09 状态为 `Active`，保留原 Node.js 16.13、环境变量和配置。云端代码包含 `players.list` 与附近展示路由。管理端调用 `venues.list` 时因无微信 OPENID 返回业务 `UNAUTHENTICATED`，函数本身执行成功；这不等于真实小程序端到端读取通过。
- 微信开发者工具 CLI 显示 AppID 正确，`1.0.11` 客户端上传成功，上传包 1,407,645 字节。**代码上传不是审核通过，也不是正式发布。**

## 尚未完成的发布门禁

1. 在微信公众平台确认本次上传版本，提交审核；审核通过后点击发布。浏览器安全策略阻止自动访问该页面，故没有代为执行或声称已上线。
2. 真机使用体验版核对：游客找球局、已登录球友目录与等级、球馆搜索/评价、附近功能主动授权与拒绝后回退、球局加入及消息。管理端无微信 OPENID，不能替代这一步。
3. 微信后台核实 `getFuzzyLocation` 权限、隐私指引、服务类目及公开球友资料的审核适配。附近展示默认关闭，需用户明确开启。

如需回退云端 `api`，使用上述经过哈希校验的旧 ZIP 重新部署；不要只回滚客户端而停用附近位置到期清理。发布前后持续检查 `api`、`accountCleanup` 的错误日志。
