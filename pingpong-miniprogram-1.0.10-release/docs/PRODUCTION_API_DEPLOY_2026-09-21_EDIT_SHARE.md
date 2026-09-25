# 2026-09-21 生产 api 部署记录

## 已完成

- 用户明确确认“部署生产”，目标仅为 `api`，环境 `laiyipai-d2gks4fmq84ce6b44`（上海）。
- 使用 `updateFunctionCode` 更新现有函数并等待云端安装依赖，未修改环境变量、运行时、权限、触发器、内存或超时。
- 云端最后修改时间：2026-09-21 23:03:17；状态 `Active / Available`；代码结果 `success`；`ErrNo=0`。
- 配置保持 `Nodejs16.13`、`index.main`、256 MB、20 秒。管理员等环境变量仅核对键名与脱敏长度，不导出密钥或身份配置。
- 部署前完成云函数测试，核对 `venue_submissions`、`player_friends`、`message_inboxes` 所需索引存在；没有变更数据库结构。
- 本次线上变化为 `lib/admin.js`、`lib/match-options.js`、`lib/matches.js`、`lib/messages.js`、`lib/presenters.js`、`lib/venue-entry.js`。包含球馆地址/认证、球局行政区保存及既有消息优化；入口和依赖版本保持不变。
- 下载部署后代码包并逐文件比对：39 个运行源码/配置/依赖声明文件全部与本地一致，0 个缺失或差异。

## 线上验证及边界

- API v2 `venues.list` 公开读取成功，返回包含行政区、地址的真实公开球馆；本次函数执行耗时 222 ms，仅为单次检查，不是性能基准。
- API v1 `matches.list` 公开读取成功，确认旧客户端读取兼容；本次函数执行耗时 265 ms。
- 已下线的 `friendUpdates.list` 返回预期 `FEATURE_REMOVED`。
- 空参数 `matches.update` 权限探测在执行前被工具安全检查拒绝，未绕过、未重试，不把它记为线上权限验证通过。写入与权限逻辑使用本地模拟测试验证；真实编辑保存需另行授权指定测试球局。
- 没有新建、修改或删除业务球局，没有发送测试消息。公开读取可能正常记录限流计数和调用日志。
- 没有部署 `mediaCallback` / `accountCleanup`，没有提交审核、正式发布或更改体验版选择。

## 回滚材料

位于被 Git 和小程序打包排除的 `build/production-backups/2026-09-21/`：

- `api-before-edit-share.zip`：7,539,491 字节；SHA-256 `63de5fe8637a24bbc3c3bc5de1278055ff757c79a36bd9c6ea790051a9905989`，与云端返回的旧代码哈希一致。
- `api-deployed-edit-share.zip`：7,544,117 字节；SHA-256 `648fc22d1e9cf6fdbe36fcacc183cf032f4446ebe9f5d03c6c1ddf0ec70a8d72`，与云端返回的新代码哈希一致。
- 如需回滚，仅恢复旧代码包，保留当前环境与函数配置；本次未执行回滚。
- 部署请求 ID：`f4b62faf-509a-4f7a-bda5-17672b5a912d`。
