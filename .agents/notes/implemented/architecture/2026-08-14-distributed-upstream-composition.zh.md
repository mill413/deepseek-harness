# Agent Note: 由上游拥有 Web 组合并通过分布式能力适配器接入

Status: implemented

[English](2026-08-14-distributed-upstream-composition.md) | 中文

## Problem

分布式部署最初只组装了一份人工维护的 Web 客户端子集，并且只实现该子集所需的 RPC。这使页面外观和上游产品不一致，设置与模式控制会被静默遗漏，同时每次上游新增客户端插件都要复制到第二份清单。原样挂载上游进程内 Host 可以消除这种漂移，但它的文件系统设置、凭据、实时 agent 句柄和本地工具进程不具备租户或副本所有权。

## Decision

上游 `base` 与 `web-app` Cordis 组合拥有分布式 Web 清单。`apps/distributed/scripts/assemble-web.mjs` 会发现这些组合中具名、且包 manifest 声明了 Web `dsh.client` 配置项的全部包，加入远程 Host 所需的浏览器目录选择器，校验客户端注入依赖，并生成由 Web 容器提供的图。分布式应用不维护功能白名单。上游新增客户端时，会通过相同的组合文件与包 manifest 进入本部署，并由分布式构建和协议测试约束。

浏览器协议通过租户感知适配器实现，而不是 fork 进程内 Host。PostgreSQL 拥有工作区、会话元数据与事件、设置命名空间与修订号、加密凭据、复制的 agent 预设、目标、附件和消息反馈。API 提供上游会话、工作区、设置、凭据、模型、命令、目标、反馈、预设、skill、插件目录等 RPC 形状；WebSocket 投影和事件追赶读取相同的持久行。会话创建会在写入 UI 所有的事件前物化兼容上游的 `SessionHeader`，API 事件写入也会拒绝与活跃 Worker 轮次并发。

每条 Worker 命令都会组合上游 agent loop（智能体循环）、会话持久化与检查点策略、token 计量、基础上下文压缩（context compaction）、工具结果裁剪、计划模式、todo 工具、重复调用提醒、模型适配器和分布式工作区适配器。DeepSeek 使用上游 DeepSeek 适配器，OpenAI-compatible Chat Completions 使用上游 Pi AI 适配器。每条命令开始前都会解析租户模型设置与凭据写入，因此副本不会共享进程全局模型密钥。

一个内部 Workspace 容器拥有持久卷，并运行上游文件系统、搜索、编辑器、Bash、子进程和后台任务提供方。Worker 通过普通 Harness 工具注册公开这些 schema，并携带租户、工作区和权限身份转发执行。工作区内的 `.dsh/skills` 与 `.agents/skills` 目录提供 skill（技能）目录和指令正文。这是一层部署所有权适配器，不会 fork 面向模型的工具 schema 或展示转换器。

客户端组合一致不代表需要分布式所有权的能力已具备运行时一致性。交互式审批与用户提问、subagent 与工作流执行、MCP 服务生命周期、实时 Cordis 插件重配置、Web 搜索、LSP 以及硬沙箱隔离仍不可用，直至每项能力都有租户级控制面和持久跨进程协议。其上游客户端插件可以渲染由其他位置产生的持久事件或空状态，但 API 会对不支持的 RPC 返回明确失败，不会伪装操作成功。

## Verification

`apps/distributed/scripts/web-e2e.mjs` 通过 20810 端口验证认证、工作区选择、上游设置与模型页面、旧模型快捷入口的移除、设置修改、只写凭据、agent 预设、模式、权限、目标、消息反馈、共享工作区工具、上下文压缩、WebSocket 投递和租户隔离。`e2e.mjs`、`workspace-e2e.mjs` 与 `openai-e2e.mjs` 分别覆盖单 API/双 Worker 调度与恢复、原始工作区提供方和 OpenAI-compatible 适配器。TypeScript 构建和 Web 组装器的依赖校验会拒绝适配器或客户端图漂移。

## Alternatives considered

**保留人工筛选的分布式 Web 插件列表。** 否决，因为该列表已经移除了用户可见的上游控制，并使每次上游 UI 变化都成为第二项人工集成任务。

**在每个 API 副本旁原样运行上游 CLI Host。** 否决，因为文件系统设置、本地凭据、内存 agent 句柄和本地进程所有权会在副本之间分叉，也无法强制租户身份。

**为分布式 API fork 上游客户端插件。** 否决，因为这会重复 UI 行为和协议形状。分布式边界负责适配 Host RPC 所有权，上游客户端继续作为展示权威。

**把每个可见的上游插件都宣称为已支持。** 否决，因为客户端代码并不拥有执行语义。跨进程审批、subagent、MCP 与工作流需要明确的持久协议；空状态或明确不支持比丢失状态或跨租户的控制更安全。

## Consequences

- 设置、模式、权限、目标、模型、预设、反馈、skill、后台任务、轨迹、交付物、工作流、subagent 和插件视图使用上游客户端实现与样式。
- 上游客户端组合变化会被自动发现，而新增服务端能力仍需有意识地实现租户感知适配器并添加 e2e 断言。
- PostgreSQL 与 Redis 继续分别作为分布式真源和调度层；Cordis 继续作为 Worker 与 Workspace 进程内的组合和扩展机制。
- 共享 Workspace 容器优先保证 Worker 之间文件连续性。Bash 拥有该容器的能力，因此只提供逻辑路由，不构成敌对租户之间的安全边界。
- 不支持能力列表属于约定的一部分。新增能力时必须选择其持久所有者，而不能挂载状态会随下一条 Worker 命令消失的进程内插件。
