# Agent Note：以 PostgreSQL 为权威源的分布式准入

Status: implemented

[English](2026-08-14-distributed-api-redis-worker.md) | 中文

## Problem

Harness Agent Loop、会话存储和现有持久化实现都假定一个进程拥有存活 agent。直接把这套组合暴露为横向扩展 API 会产生三个耦合问题：API 进程同时成为连接所有者和执行器、同一会话的请求可能在不同副本并发运行、进程丢失可能使历史或工作搁置且没有持久命令身份。多租户又增加了一条独立边界：仅凭会话 id 不能授权读取或执行，队列元数据也不能成为租户状态的权威源。

## Decision

分布式应用把无状态 API 准入和 Worker 执行分开。PostgreSQL 管理租户、按所有者限定的会话、命令状态、Harness 会话头和追加式事件日志。每条命令行同时也是事务 outbox 记录。API 副本使用 `FOR UPDATE SKIP LOCKED` 选择未派发记录，将其追加到一个 Redis 消费组 Stream，然后标记为已派发；这个边界刻意允许崩溃产生重复投递。

Worker 先获取按租户和会话命名、可续租的 Redis 租约，再原子地把一条排队 PostgreSQL 命令转换为运行状态。命令状态是幂等门，而租约使会话成为跨进程单写者 actor。Worker 使用内部 `tenant/session` 身份创建或恢复普通 Harness Agent，运行原生 loop 和工具，在模型请求与工具副作用之前应用会话检查点策略，刷写事件日志，然后才完成命令。本 MVP 会为每条命令重建运行时，因此连续性由 PostgreSQL 恢复而非粘性路由负责。

Redis 只保存加速状态。Streams 调度准入，带过期时间的键承载租约和 Worker 心跳，Pub/Sub 唤醒取消。PostgreSQL 保留取消意图，并按单调连续序列提供事件读取和 SSE 追赶。活跃命令心跳允许 API 泵在两个租约窗口后把陈旧运行命令放回 outbox。四个应用副本同时启动时，advisory lock 会串行执行幂等 schema 迁移。

租户身份同时进入内部 Harness 会话 id 以及每个 PostgreSQL 主键或外键。面向用户的 API 读取和写入同时包含租户与所有者条件。浏览器认证使用 scrypt 密码哈希、仅在 PostgreSQL 保存哈希的随机不透明会话令牌，以及同时供 HTTP 与 WebSocket 使用的 HttpOnly SameSite Cookie。Nginx 在代理浏览器流量前会清除调用方提供的身份头。直连 API 端口只保留请求头身份作为测试/服务接缝，并且必须位于可信网络。

浏览器层是独立 Nginx 容器，负责提供静态组装的 `apps/web` shell 和依赖闭合的客户端插件图。一个轻量认证 shell 会拦截原生 Web 启动，提供租户注册、登录、退出与管理员模型配置对话框，然后加载官方会话 UI。Nginx 把普通 RPC 和两条经过认证的 WebSocket 下行流负载均衡到两个 API 副本，并独占 20810 端口。API 副本在 `/v1` 使用的同一套 PostgreSQL 命令与事件之上实现原生浏览器协议，因此 Web 进程不持有会话或 Agent 状态。

模型配置作为租户状态保存在 PostgreSQL。租户管理员可选择 Mock、DeepSeek 或 OpenAI-compatible Chat Completions、默认模型、端点，并可选配置租户密钥。API Key 使用部署密钥通过 AES-256-GCM 密封，接口永不返回明文。Worker 为每条命令读取并解密租户快照，绝不修改进程全局 API Key 环境变量。DeepSeek 会构造操作局部的直接 adapter；OpenAI-compatible 模式则挂载上游 pi-ai Cordis 插件，并提供只读的操作局部凭据 provider 与手工声明的 `openai-completions` 路由。这既能防止并发租户任务跨越凭据边界，也保留了上游的流式与工具调用转换。

原生输入框和工具运行时共同使用 PostgreSQL 管理的租户 Workspace 记录，以及会话归属与顺序。注册会创建默认 `/workspace` 记录，迁移则把全部已有会话挂到各租户默认工作区。Workspace RPC 与 host-stream 增量实现跨副本原生客户端契约。一个内部 Workspace 服务独占持久卷，并把所选数据库身份映射为 `/workspaces/<tenant-id>/<workspace-id>`；API 和 Worker 副本都不挂载该卷。Worker 在构建命令运行时时获取上游工具目录和指引，注册模型可见代理定义，并通过带认证的内部 HTTP 边界转发调用。Workspace 服务为每个工作区维护长生命周期 Cordis 上下文，并在其中运行原始文件系统、ripgrep 搜索、字符串编辑器、Bash 和后台任务插件，因此后续轮次即使落到另一个 Worker，命令执行和文件仍然共享。

分布式集成会保留上游插件的所有权。Workspace 运行时组合插件把原始本地 provider 和工具 consumer 挂载为子 Fiber，Worker 侧 Cordis 适配器则拥有远程工具目录监听器和代理注册。递归 dispose 会移除完整工具世代，无需自定义清理。依赖 Agent 作用域的上游插件仍然位于 Worker：`todo_write` 把快照记录到 PostgreSQL 支持的会话日志，重复调用提醒则会在连续相同调用后贡献其标准日志上下文。需要凭据、外部选择 provider 或子 Agent 所有权的插件，要等租户作用域配置和相应分布式生命周期存在后再挂载。

内部服务会校验租户与工作区 UUID，通过数据库身份派生存储路径而不信任逻辑展示路径，拒绝已有规范祖先逃逸所选根目录的文件/搜索/编辑器路径，转发取消信号，并用共享服务令牌保护不对外开放的 3200 端口。这是刻意的逻辑路由，而不是对恶意代码租户隔离的承诺：单容器内的任意 Bash 工具仍构成共享信任边界。强隔离需要把 Workspace provider 放置方式改成按信任域分配容器或微虚拟机，同时保留 Worker 代理契约。

## Alternatives considered

- **把 agent 保留在 API 副本并使用粘性会话**：拒绝，因为 API 生命周期仍与执行器生命周期耦合，故障转移依赖负载均衡亲和性，副本丢失后仍然需要持久恢复协议。
- **让 Redis 成为命令和 transcript 权威源**：拒绝，因为 Stream 保留、Pub/Sub 丢失和 Redis 故障转移语义不适合作为租户记录与追加式 Harness 历史的所有权边界。
- **把租户和队列概念加入 Agent Loop**：拒绝，因为它们属于部署关注点；原生 loop 应保持可复用，其模型、工具和检查点行为也应能独立测试。
- **在一个 Worker 保持长生命周期 Session Actor**：暂缓，因为它能降低延迟，但需要 actor 放置、移交、mailbox 排空和停机 fencing。先用按命令重建证明持久化和租约边界。
- **承诺队列恰好一次投递**：拒绝，因为 outbox 到 Redis 的边界无法原子化。至少一次调度加 PostgreSQL 原子命令认领，无需分布式事务即可获得所需执行行为。
- **把 Web UI 嵌入 API 副本一**：拒绝，因为这会让一个 API 成为特殊入口副本，绕过 API 负载均衡，并把前端发布和健康状态与准入容量耦合。
- **把共享卷直接挂载到每个 Worker**：拒绝，因为模型控制的文件与命令副作用会分散到多个执行容器，Worker 替换还会兼任存储挂载管理，并且边界更难审计。所有工作区 I/O 由一个工具服务负责。
- **立即为每个租户创建独立 Workspace 容器**：暂缓，因为它能提供更强安全边界，但需要放置、生命周期、配额、清理、路由和镜像编排，超出首个共享工作空间阶段。内部代理接口保留了这条迁移路径。
- **在分布式应用中再实现一个直接 Chat Completions 客户端**：否决，因为上游 pi-ai 适配器已经负责 OpenAI-compatible 流式输出、工具调用、取消、用量和错误转换。分布式层只需提供租户级配置与凭据。

## Consequences

- 两个 API 和两个 Worker 可以并发处理独立会话，而单个会话保持串行，并可通过另一个 API 和另一个 Worker 恢复。
- 原生 Harness 上下文管理、工具调用、检查点顺序和事件回放保持不变；Redis 和租户信息不会进入模型可见上下文。
- 仓库原生 Web shell 可以通过任一 API 副本创建会话、选择已配置模型路由、提交和取消提示、恢复历史，并渲染实时模型与工具事件。
- 浏览器用户可以创建相互隔离的租户并使用数据库会话认证；租户管理员无需重建容器即可修改模型配置。
- 同一个租户模型入口可以路由到 OpenAI 官方端点、OpenAI-compatible 网关或无需密钥的本地 Chat Completions 服务，而不需要引入第二套 wire 协议实现。
- 每个租户都有可选择的默认 Workspace，因此官方输入框可以创建绑定工作区的会话并直接开始对话，无需绕过 Web 协议。
- Agent 会接收上游 `read`、`write`、`edit`、`glob`、`grep`、`str_replace_editor`、`bash`、`job_output`、`job_list` 和 `job_kill` schema 与指引，而对应文件和进程工作全部在持有卷的 Workspace 容器中执行。
- Agent 还会在 Worker 进程中获得上游 `todo_write` 工具和重复调用提醒；它们的会话事件使用与其余对话相同的 PostgreSQL 持久化和跨 API 回放路径。
- Workspace 文件可跨 Workspace 服务和 Worker 重启保留，两个 Worker 也能看到同一个所选目录；后台任务注册表状态仍局限于 Workspace 服务进程，不能跨该服务重启。
- 面向文件的 RPC 调用具备规范根目录检查，但任意 Bash 执行使单容器拓扑成为一个信任域，而不是硬多租户沙箱。
- PostgreSQL 负载与按命令构建运行时的成本高于粘性 actor 设计，但恢复行为明确且可测试。
- 进程崩溃可能留下旧 Redis pending 项；SQL 恢复会发出新项，命令门会阻止重复执行，但生产运维仍需要 pending 回收、Stream 裁剪、死信策略、指标和告警。
- 密码找回、邀请与用户生命周期管理、MFA/SSO、配额执行、审计日志、粗粒度陈旧超时、审批流程、分布式 subagent、密钥轮换流程、TLS 入口加固和 PostgreSQL 行级安全在此 MVP 中尚未达到生产完备。
