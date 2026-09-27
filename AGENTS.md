# 项目开发约定

## 开始工作

先阅读 [CONTEXT.md](./CONTEXT.md) 统一领域术语。修改账号生命周期、消息投递、网关事件、Job、Agent Run 或 Sequence Run 时，同时核对需求不变量与数据库约束；领域术语发生变化时更新 `CONTEXT.md`。

涉及持久化任务协调、inbox/outbox、Worker 租约或缓存职责时，阅读 [ADR 0001](./docs/adr/0001-postgres-coordinates-work.md)。新的架构选择只有在难以逆转、存在真实取舍且代码本身无法解释原因时才新增 ADR。

## 正确性约束

- PostgreSQL 是唯一事实来源；缓存只能加速，不能决定状态、幂等或任务归属。
- 外部副作用前先持久化意图，恢复时先对账再重试。消息网关不按 `clientMsgId` 去重。
- 网关 SSE 允许重复和乱序；事件先进入 `gateway_events`，连续 checkpoint 只能在缺口补齐后推进。
- 多实例互斥依靠数据库唯一约束、事务和租约，应用层的“先查询再写入”不足以保证互斥。
- 消息时间线分页使用 `(sentAt, id)` 稳定游标。自己的出站记录与网关回流必须归并为一行。
- Agent 工具产生的发送和踢人效果必须可恢复；相同 run 内的发送幂等键不能产生第二次外部效果。
- `ENABLE_C_FEATURES` 是 C1/C2 的唯一总开关；关闭时不能下载媒体或调用真实 LLM。
- 媒体清理先清除 `localFilePath` 再删除文件，并跳过存在运行中 Agent Run 的群。
- 阿拉伯语界面保持 RTL；ID、JSON、代码和时间类技术内容保持 LTR。

## 修改与验证

数据库结构只通过 `db/migrations/` 演进；更新 schema 时增加迁移测试。后端接口错误保持 `{ error: { code, message, requestId, ... } }` 结构。

完成修改前运行：

```bash
npm run lint
npm test
npm run typecheck
npm run build
npx playwright test --list
```

以上检查全部通过；修改用户主流程时还需运行 `npm run test:e2e`。没有提交 `dist/`、`*.tsbuildinfo`、`.env` 或运行时媒体文件，才算完成。
