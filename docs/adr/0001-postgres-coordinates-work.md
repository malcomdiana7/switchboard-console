# ADR 0001：使用 PostgreSQL 协调持久化任务

## 状态

已接受

## 背景

网关事件、消息投递、Job、Agent Run、Sequence Run、登录会话撤销和前端事件补发，都必须在服务重启及多实例部署后保持正确。缓存不能成为这些保证的事实来源。

## 决策

使用 PostgreSQL 作为事实来源和任务协调机制：

- Worker 通过租约和 `FOR UPDATE SKIP LOCKED` 领取任务。
- 部分唯一索引保证同一个群最多只有一个运行中的 Agent Run 或 Sequence Run。
- Inbox 与 outbox 分离外部事件接收、业务状态变更和事件推送。
- Redis 不参与正确性保证。

## 影响

项目只有一个必须运行的有状态依赖。Worker 吞吐量受 PostgreSQL 限制，但足以满足操作控制台的使用规模。即使可选缓存丢失，也不会改变系统对外可观察的正确性。
