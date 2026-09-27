# Switchboard Console 架构

本文描述当前代码的运行结构、持久化模型和关键数据流，用于判断一次改动应落在哪个模块，以及必须同时维护哪些正确性约束。领域词汇以 [CONTEXT.md](./CONTEXT.md) 为准；PostgreSQL 协调任务的取舍见 [ADR 0001](./docs/adr/0001-postgres-coordinates-work.md)。部署和本地运行命令见 [README.md](./README.md)。

## 系统边界

Switchboard 是面向操作员的多账号群组消息系统。它管理服务账号和群成员关系，通过外部消息网关收发消息，并以可恢复的 Job、Agent Run 和 Sequence Run 执行长流程。

```text
浏览器
  │ HTTP + WebSocket
  ▼
Web 控制台 ───────► API / Worker ───────► 消息网关
                         │                    │
                         │ HTTP               │ SSE（允许重复、乱序）
                         ▼                    │
                    Agent 服务                │
                         │                    │
                         └──────┬─────────────┘
                                ▼
                           PostgreSQL
                      （唯一的事实与协调来源）

可选：API / Worker ──► 本地媒体目录
      LLM Agent ─────► OpenAI 兼容 /chat/completions
```

API 和 Worker 当前运行在同一个 `@switchboard/api` 进程中，但通过数据库中的状态、租约和唯一约束协作，而不是依赖进程内状态。因而多个 API 实例可以竞争工作；外部调用失败或进程重启后，工作仍可从 PostgreSQL 恢复。

## 仓库模块

| 模块                | 接口                          | 实现职责                                                                                                                  |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`          | `/api/*`、`/ws`               | React 操作台；React Query 管理服务端状态；处理登录、账号、群组、时间线、Agent Run 和 Sequence；中文、英文、阿拉伯文及 RTL |
| `apps/api`          | HTTP、WebSocket、Worker 循环  | 鉴权和业务路由；持久化意图；消费网关事件；投递消息；推进 Job、Agent Run、Sequence Run；媒体归档                           |
| `apps/mock-gateway` | 网关 HTTP + SSE 协议          | 本地开发和测试用网关适配器，可注入重复消息、账号终态和群不可写等情形                                                      |
| `apps/mock-agent`   | `/agent/turn`、`/agent/audit` | 可编程的确定性 Agent 适配器，用于开发、协议错误演示和端到端测试                                                           |
| `apps/llm-agent`    | 同一 Agent HTTP 接口          | 将内部工具协议翻译为 OpenAI 兼容的 Chat Completions 调用；不直接访问数据库或网关                                          |
| `packages/shared`   | 导出的类型与状态函数          | 前后端共享的账号、投递和实时事件类型，以及账号状态转换规则                                                                |
| `db/migrations`     | 顺序 SQL 迁移                 | 数据库类型、表、索引和约束的唯一演进入口                                                                                  |

主要接缝集中在 `GatewayClient` 和 Agent HTTP 协议。模拟实现与真实实现应满足同一接口；业务正确性留在 API/Worker 和数据库中，而不下沉到模拟器、LLM 服务或浏览器。

## API 进程内部

`apps/api/src/index.ts` 是组合根：加载配置，建立 PostgreSQL 连接，注册鉴权、业务路由与 WebSocket，校验迁移版本，然后启动所有 Worker。

```text
index.ts
├── auth.ts       登录、Refresh Token 轮换、会话校验和角色授权
├── routes.ts     同步查询与命令入口；长任务只写入持久化意图
├── db.ts         连接池、事务封装、frontend_events 写入
├── gateway.ts    外部网关 HTTP 适配器及错误归一化
├── workers.ts    投递、事件应用、Job、限流恢复、Sequence 调度
├── agent.ts      Agent 工具循环、审计、预算与副作用幂等
├── media.ts      可选媒体下载和过期清理
└── errors.ts     统一 `{ error: { code, message, requestId, ... } }`
```

路由负责鉴权、输入检查、快速事务和查询。需要外部副作用或多步推进的命令先写入 `messages`、`jobs`、`agent_runs` 或 `sequence_runs`，再返回 `202`/`201`；Worker 之后领取记录并执行。这个分工是恢复能力的来源，新增外部副作用时应保持同样形状。

## 持久化模型

表按职责分为五组：

| 职责             | 表                                                                                                            | 关键约束                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 身份与会话       | `users`, `auth_sessions`                                                                                      | Refresh Token 仅保存哈希；轮换代数进入 Access Token；检测旧 Token 复用时撤销整个会话族                    |
| 账号与群         | `accounts`, `groups`, `group_members`                                                                         | 账号状态用 CAS 更新；终态账号移除成员关系；群内成员按平台用户唯一                                         |
| 消息与网关 inbox | `messages`, `gateway_events`, `gateway_checkpoints`                                                           | `(group_id, msg_id)` 和 `client_msg_id` 去重；时间线按 `(sent_at, id)`；checkpoint 只连续推进             |
| 前端 outbox      | `frontend_events`                                                                                             | `seq` 全局递增且事件不可变；WebSocket 客户端用 `sinceSeq` 补拉                                            |
| 持久化工作流     | `jobs`, `agent_runs`, `agent_steps`, `agent_tool_effects`, `sequences`, `sequence_runs`, `sequence_run_steps` | 租约支持抢占恢复；部分唯一索引限制每群一个运行中的 Agent Run 和 Sequence Run；工具效果按 run 内幂等键唯一 |

数据库约束承担跨实例互斥和幂等的最后防线。应用层的预检查只用于更好的错误信息，不能替代唯一约束、事务、行锁或条件更新。

## Worker 协调模型

Worker 使用短轮询。领取任务时在事务中通过 `FOR UPDATE SKIP LOCKED` 找到候选行，并写入 `lease_owner`、`lease_until`；副作用完成后推进持久化状态并释放租约。租约过期后其他实例可重新领取。

| 循环                              | 输入                                 | 结果                                                                                  |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| `delivery`                        | `messages` 中的 `queued` / `unknown` | 调用网关发送或按 `clientMsgId` 对账，推进为 `accepted`、`sent`、`failed`、`cancelled` |
| `events`                          | 未应用的 `gateway_events`            | 更新时间线、投递、成员和账号状态，触发 Agent，并推进连续 checkpoint                   |
| `jobs`                            | `jobs.status = running`              | 执行建群或全员退群的多阶段网关操作                                                    |
| `rate-limit`                      | 到期的 `rate_limited` 账号           | 恢复为 `online`                                                                       |
| `agent`                           | 运行中的 `agent_runs`                | 调用 Agent、验证协议、执行一个工具步骤并持久化结果                                    |
| `sequence`                        | 到期的 `sequence_run_steps`          | 选择指定角色账号，创建出站消息，等待投递事件推进下一步                                |
| `media-archive` / `media-cleanup` | 待归档或过期的媒体消息               | 下载媒体；先清空数据库文件引用，再删除过期文件                                        |
| SSE 消费                          | 网关 `/events?since=...`             | 原样写入 `gateway_events`，重复 `eventId` 由主键消解                                  |

这些循环可以并发，但一次 tick 只推进有限工作。跨循环协作全部经由数据库完成，例如 Sequence 创建消息后由 delivery 发送，再由网关事件把对应步骤标记为 `sent`。

## 关键数据流

### 出站消息

1. 操作员、Sequence 或 Agent 先创建带 `clientMsgId` 的 `messages` 行，状态为 `queued`。
2. delivery Worker 领取该行并调用网关。网关接受请求后状态变为 `accepted`。
3. 网络结果不明确时状态变为 `unknown`；Worker 先按 `clientMsgId` 向网关对账，确认不存在后才允许有限重试。网关本身不按 `clientMsgId` 去重。
4. `message_sent` / `message_failed` 事件进入 inbox 后完成最终状态转换。
5. 若普通 `message` 回流先到，事件应用逻辑会在后续 `message_sent` 时把回流行与本地出站行归并，时间线最终只有一行。

### 网关事件

1. SSE 消费器从连续 checkpoint 之后订阅，把每个外部事实写入 `gateway_events`；主键消除重复投递。
2. event Worker 可按 `eventId` 顺序领取尚未应用的记录，但每条事件独立记录重试、错误和租约。
3. 业务更新、`applied_at` 和可能产生的前端事件在事务中提交。
4. `gateway_checkpoints.contiguous_event_id` 仅在下一编号恰好接续时前进。遇到缺口时，后面的事件可以已应用，但重连仍从旧 checkpoint 补取缺失区间。

### Agent Run

外部用户消息写入时间线后，已启用 Agent 的群会创建一个 Run；若该群已有运行中 Run，新触发消息追加到 `pending_trigger_messages`。Run 每次租约只执行一个模型回合或工具步骤。

Agent 可读取近期消息、发送消息、踢人或结束运行。响应须符合单块工具协议；连续三次协议错误终止运行。单个 Run 最多 12 步、累计 60 秒。发送和踢人先经过独立审计；审计连续不可用时 Run 进入 `blocked`。`send_message` 先在同一事务中写入消息意图和 `agent_tool_effects`，以 `(run_id, idempotency_key)` 防止恢复时产生第二次外部效果。Run 结束后，排队触发消息可创建下一个 Run。

### Sequence Run

Sequence 定义是带角色、文本模板和延迟的有序步骤。创建 Run 前先解析全部变量并记录值及来源；无法解析的占位符不会进入运行态。每群至多一个运行中 Sequence Run。调度器到期时为当前步骤创建消息；只有网关确认 `message_sent` 后才安排下一步，失败或群不可达会停止整个 Run。

### 实时前端

业务事务把通知写入 `frontend_events`。WebSocket 连接使用 Access Token 认证，并从客户端保存的 `sinceSeq` 开始按序补发；连接存活期间 API 轮询新增事件。Web 端收到任意带 `seq` 的事件后保存 checkpoint 并使 React Query 缓存失效。因此 WebSocket 是刷新提示和补拉通道，HTTP 查询仍是页面数据接口。

## 正确性不变量

- PostgreSQL 是账号状态、工作归属、幂等和事件进度的唯一事实来源；可选缓存不得参与这些判断。
- 外部副作用之前持久化意图；不确定的投递先对账，再决定是否重试。
- 网关事件可重复、乱序；接收和应用是两个独立持久化阶段。
- 账号 `suspended`、`session_expired` 后不可转换，并清除成员关系及尚未发送的相关工作。
- 时间线使用 `(sent_at, id)` 稳定游标；本地出站与网关回流归并为同一逻辑消息。
- 每群同时最多一个运行中的 Agent Run 和一个运行中的 Sequence Run，该互斥由部分唯一索引保证。
- `ENABLE_C_FEATURES` 同时控制媒体归档和真实 LLM Agent；关闭时不得下载媒体或调用真实 LLM。
- 媒体清理先清除 `local_file_path` 再删除文件，并跳过存在运行中 Agent Run 的群。
- 阿拉伯语页面整体 RTL，ID、JSON、代码和时间等技术内容保持 LTR。

修改这些行为时，应同时检查 [CONTEXT.md](./CONTEXT.md)、迁移约束、事务范围、恢复路径和相应测试。

## 鉴权与权限

登录签发 15 分钟 Access Token，并把 30 天 Refresh Token 放入 `HttpOnly`、`SameSite=Strict` Cookie。刷新时持有会话行锁并轮换 Token；Access Token 中的 generation 必须与数据库会话一致。`viewer` 可读取，账号转换、建群、发送、策略更新和 Sequence 创建等写操作要求 `admin`。WebSocket 也通过相同会话校验，不把 JWT 验证当作撤销检查的替代品。

## 功能开关与外部依赖

基础运行时只要求 PostgreSQL、消息网关和一个满足 Agent HTTP 协议的实现。`ENABLE_C_FEATURES=false` 时 API 指向 mock Agent，且不启动媒体 Worker；开启后 API 改用 `LLM_AGENT_URL` 并启用本地媒体目录。LLM Agent 再通过配置访问 OpenAI 兼容端点。开关判断集中在 `apps/api/src/config.ts`，新增 C 组行为应从该配置派生，避免出现第二个总开关。

## 改动导航

| 要修改的行为       | 首要位置                                                                            | 必须联动检查                                             |
| ------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 账号状态或终态清理 | `packages/shared/src/index.ts`, `apps/api/src/routes.ts`, `apps/api/src/workers.ts` | `account_status` 类型、成员和排队任务清理、领域测试      |
| API 命令或查询     | `apps/api/src/routes.ts`                                                            | `auth.ts` 权限、`errors.ts` 错误结构、Web 调用方         |
| 出站投递与对账     | `workers.ts` 的 delivery/event 循环、`gateway.ts`                                   | `messages` 约束、网关模拟器、重复/超时测试               |
| 网关事件类型       | `workers.ts` 的 SSE 与 event apply                                                  | `gateway_events` / checkpoint、mock gateway、前端事件    |
| Job 工作流         | `workers.ts` 的 job 循环                                                            | `jobs.state` 的恢复点、租约、网关错误映射                |
| Agent 工具或策略   | `agent.ts`、两个 Agent 应用                                                         | 工具协议、审计、`agent_steps`、`agent_tool_effects` 幂等 |
| Sequence 行为      | `routes.ts` 的预检、`workers.ts` 的调度                                             | 两类 sequence 表、消息投递事件、唯一索引                 |
| 实时 UI 更新       | `db.ts`, `index.ts`, `apps/web/src/App.tsx`                                         | outbox 事务、`seq` 补拉、HTTP 查询缓存                   |
| 媒体生命周期       | `media.ts`, `002_media_archive.sql`                                                 | C 组总开关、清理顺序、运行中 Agent Run 排除条件          |
| 数据模型           | 新增 `db/migrations/NNN_*.sql`                                                      | `latestMigration`、迁移测试、所有读写 SQL                |

## 验证结构

Vitest 覆盖领域规则、迁移、C 组配置、LLM Agent 协议和媒体归档；需要数据库语义的测试使用 PGlite。Playwright 覆盖登录、建群错误、Sequence 创建、Agent Run 主流程和 RTL 布局，并固定使用 mock Agent 保持确定性。

实现完成时按 [AGENTS.md](./AGENTS.md) 运行全套质量检查；修改用户主流程时额外运行端到端测试。构建产物、TypeScript 增量文件、环境变量和运行时媒体不进入版本库。
