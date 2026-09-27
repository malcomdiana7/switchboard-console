# Switchboard 多账号群组消息平台

这是一个可靠的多账号群组消息后端与操作控制台。仓库包含后端 API、React 控制台、可编程的 HTTP/SSE 消息网关模拟器，以及 Agent 协议模拟器。

## 已实现功能

- 基于 CAS 更新和终态清理的持久化账号状态机
- PostgreSQL 网关事件 inbox、前端事件 outbox、Worker 租约和重启恢复
- 稳定的消息游标分页和出站消息状态对账
- 异步建群、邀请、入群、提升管理员和群主最后退出的工作流
- 支持协议校验、审计、运行上限和发送幂等的可恢复 Agent 工具循环
- 支持变量预检和持久化调度的定时序列
- Refresh Token 轮换和 Token 复用时的会话族撤销
- 中文、英文、阿拉伯文及 RTL 布局
- 浅色、深色、跟随系统三种主题
- 可开关的媒体文件归档与过期清理（C1）
- 可切换到任意 OpenAI 兼容服务的独立 LLM Agent（C2）
- 覆盖登录、群详情和 Agent Run 步骤的 Playwright 端到端测试（C3）

## 环境要求

- Node.js 22 或更高版本
- PostgreSQL 18.6
- npm 11

Compose 配置使用 `postgres:18.6`。Docker Compose 会直接复用本机已有镜像。
数据库文件保存在项目根目录的 `./_data/postgres`，该目录不会被 Git 跟踪。

## 本地启动

1. 从示例生成本地环境变量文件：

```bash
cp .env.example .env
```

该命令创建不会被 Git 跟踪的 `.env`。首次启动前应检查数据库地址、JWT 密钥和 C 组开关。

2. 在后台启动 PostgreSQL 18.6：

```bash
sudo docker compose up -d postgres
```

数据库数据会持久化到 `./_data/postgres`。`-d` 表示容器在后台运行，`postgres` 表示只启动数据库服务。Docker Compose 会自动读取 `.env`。

3. 安装根项目及所有 workspace 的依赖：

```bash
npm ci
```

4. 执行尚未应用的数据库迁移：

```bash
npm run db:migrate
```

迁移命令会自动读取 `.env`，创建或升级数据库结构，并跳过已经应用的版本。

5. 写入开发所需的预置用户和服务账号：

```bash
npm run db:seed
```

seed 命令会自动读取 `.env`，并以可重复执行的方式准备 `admin`、`viewer` 和四个服务账号。

6. 启动全部开发服务：

```bash
npm run dev
```

该命令同时启动后端 API、Vite 前端、网关模拟器、Agent 模拟器，以及受 C 组开关控制的 LLM Agent。各 Node 服务会自动读取项目根目录的 `.env`。

如果操作系统环境变量或命令行已经提供同名变量，则已有值优先，`.env` 不会覆盖它。因此整个启动流程不需要执行 `set -a` 或 `source .env`。

浏览器访问 <http://localhost:5173>。预置账号：

- `admin / admin`：拥有全部权限
- `viewer / viewer`：只读权限

默认端口：后端 API `3000`、前端 `5173`、网关模拟器 `4100`、Agent 模拟器 `4200`、LLM Agent `4300`。

## C 组功能

`.env` 使用一个总开关控制 C1 和 C2：

```dotenv
ENABLE_C_FEATURES=true
```

开关关闭时，媒体事件仍会进入消息时间线，但不会下载文件，后端使用 `AGENT_URL` 指向的模拟 Agent。开关开启时：

- 媒体文件保存到 `MEDIA_DIR`，超过 `MEDIA_RETENTION_DAYS` 后自动清理。
- 后端切换到 `LLM_AGENT_URL` 指向的独立 LLM Agent。
- LLM Agent 通过 `LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL` 调用 OpenAI 兼容的 `/chat/completions` 接口。

例如连接本地 OpenAI 兼容服务：

```dotenv
ENABLE_C_FEATURES=true
LLM_BASE_URL=http://localhost:8000/v1
LLM_API_KEY=
LLM_MODEL=your-model-name
```

C3 是测试资产，不随服务常驻运行。首次执行前安装 Chromium：

```bash
npx playwright install chromium
```

该命令下载与当前 Playwright 版本匹配的 Chromium，仅需在首次安装或 Playwright 升级后执行。

运行完整端到端测试：

```bash
npm run test:e2e
```

该命令会启动 PostgreSQL、执行迁移和种子数据、启动开发服务，然后在 Chromium 中验证“登录 → 建群 → 触发 Agent → 查看运行步骤”。为保证结果稳定，端到端测试固定使用模拟 Agent。

## 质量检查

检查代码是否符合 ESLint 规则：

```bash
npm run lint
```

运行 Vitest 单元测试和数据库迁移测试：

```bash
npm test
```

对所有 workspace 执行 TypeScript 静态类型检查，不生成构建文件：

```bash
npm run typecheck
```

生成所有后端服务和前端的生产构建，用于验证发布产物能够正常编译：

```bash
npm run build
```

仅列出 Playwright 能发现的端到端测试，不启动浏览器和业务服务：

```bash
npx playwright test --list
```

## 模拟器控制接口

取得网关群组 ID 后，可以注入一条外部用户消息：

```bash
curl -X POST http://localhost:4100/__control/message \
  -H 'content-type: application/json' \
  -d '{"groupId":"grp-...","senderPlatformUserId":"external-1","text":"你好","duplicate":true}'
```

该请求用于测试入站消息、重复事件去重和 Agent 触发。`duplicate: true` 会让模拟网关重复投递同一个事件，以验证后端的 at-least-once 去重能力；将其改为 `false` 可只投递一次。

网关还提供以下控制接口：

- `POST /__control/account-status`：注入账号终态事件
- `POST /__control/group-writable`：切换群组是否可写

Agent 模拟器提供 `POST /__control/mode`。模式 `bad_then_unknown` 可以演示坏 JSON、未知工具调用及后续协议恢复。

## 架构说明

PostgreSQL 是唯一的正确性依赖。系统通过持久化 inbox/outbox、部分唯一索引、事务和 Worker 租约保证重启及多实例部署下的行为，不依赖 Redis 保存关键状态。

领域术语见 [CONTEXT.md](./CONTEXT.md)，关键架构取舍见 [ADR 0001](./docs/adr/0001-postgres-coordinates-work.md)。
