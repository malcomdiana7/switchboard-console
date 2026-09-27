# 领域术语

## 服务账号（Service account）

由 Switchboard 控制的账号，在消息网关中对应一个稳定的 `platformUserId`。账号生命周期状态是全局状态，与账号在各群中的成员关系相互独立。

## 终态账号（Terminal account）

状态为 `suspended` 或 `session_expired` 的服务账号。终态账号不能再发生状态转换，也不能保留群成员关系或排队中的任务。

## 网关事件（Gateway event）

由网关全局 `eventId` 标识、不可变的外部事实。接收事件与把事件应用到业务模型是两个独立的持久化阶段。

## 时间线消息（Timeline message）

群内的一条逻辑消息。出站消息及其网关回流事件最终合并为同一行，而不是两条消息。

## 投递（Delivery）

一条出站消息的持久化生命周期：`queued`、`accepted`，随后进入 `sent`、`failed`、`unknown` 或 `cancelled`。

## 运行（Run）

可持久化、可恢复的工作流。Agent Run 与 Sequence Run 的业务规则不同，但都能跨进程重启恢复，并且同一时刻只能由一个 Worker 持有租约。

## 前端事件（Frontend event）

带有全局递增 `seq` 的不可变内部事实。事件在通过 WebSocket 推送前持久化，使断线客户端能够补拉。

## 作业（Job）

持久化的建群或全员退群工作流，其执行进度和错误对操作员可见。

## 媒体归档（Media archive）

消息网关媒体文件在本地保存的可选副本。消息中的 `mediaUrl` 是外部来源，`localFilePath` 是归档成功后的本地引用；删除文件前必须先清除该引用。运行中的 Agent Run 所在群的媒体不参与过期清理。
