# Agent Note: 单例 Workspace 中的上游运行时一致性

Status: implemented

[English](2026-08-14-distributed-runtime-parity.md) | 中文

## Problem

第一版分布式 Web 接入复用了上游浏览器组合，但通过短生命周期 Worker 运行时执行人工筛选的工具子集。该拆分保留了页面，却遗漏了由运行时拥有的行为：预设作用域 schema、Code Mode、提问与审批、子 agent、工作流、动态 Cordis 插件和租户自定义预设执行。逐工具增加代理会永久落后于上游组合，并重复其生命周期规则。

## Decision

单例 Workspace 进程按租户工作区启动上游 `base`、`web-app` Host 组合以及发布的 `standard`、`code`、`minimal`、`cordis` 预设清单。队列 Worker 只拥有 Redis 投递、会话租约、取消转发和命令完成状态。它把完整命令委托给 Workspace 中保留的上游 Agent 句柄；PostgreSQL 实现上游会话持久化接口，并继续作为持久事件权威。

因此，面向模型的目录由未经修改的预设组合拥有。标准模式公开上游文件、Bash、后台任务、skill、目标、计划、todo、联网搜索、subagent、工作流、Ralph 和交互工具。Code 模式通过 `run_code` 展示同一组能力；minimal 模式保留上游基于持久终端的 `bash` 与 `str_replace_editor`；Cordis 模式增加七个上游检查、定义、运行、停止与删除工具。Web Host 的上游会话查询服务继续参与组合。MCP 与 LSP 仍是上游选择启用的组合包，而不是发布预设的默认内容；租户自定义预设无需修改分布式命令协议即可挂载它们。

PostgreSQL 同时拥有待处理提问与审批响应，以及物化的子会话谱系。API 与 Workspace 中继正式的 subagent 列表、历史、续聊和中断操作，并校验租户与直接父会话权限。浏览器侧动态 Cordis RPC 路由到持有实时 Agent 与插件注册表的 Workspace 进程；检查器清单按租户保留，并在后创建的 Workspace 上下文启动时重放。租户自定义预设行会在每次新 Agent 挂载前物化到私有用户清单，因此正式预设清单无需第二套加载器即可发现复制或删除的预设。

模型与凭据修改会淘汰该租户的空闲 Workspace 上下文。活跃命令会在原有代际上完成，随后上下文被淘汰；下一条命令使用 PostgreSQL 中的新配置启动适配器。这样 API 副本和队列 Worker 不会拥有陈旧模型密钥，同时每个租户工作区仍只有一个执行所有者。

## Verification

`apps/distributed/scripts/tool-parity-e2e.mjs` 会让真实命令依次经过单 API、Redis、双 Worker 和 Workspace。它对比四个面向模型的预设工具目录，完成提问响应、目标创建、Code Mode、子 agent 与工作流运行，通过 Web RPC 读取子会话历史，定义动态 Cordis Package 并从浏览器 inventory 读取，还会执行 PostgreSQL 中创建的预设。`e2e.mjs` 验证 API 入口与双 Worker 分流、租户隔离、正式 Bash 与 todo 执行、PostgreSQL 事件顺序和恢复。`workspace-e2e.mjs` 直接调用正式 Agent 运行时，并验证两个相互隔离的持久目录。

## Alternatives considered

**维护分布式工具白名单并逐个转发执行。** 否决，因为预设组合、提示词段、渲染器、Code Mode、子会话生命周期和新增上游工具仍需平行实现。

**在每个队列 Worker 内启动上游 Agent。** 否决，因为 Redis 可能把连续轮次分配给不同 Worker，导致实时任务、Cordis 注册表、可续聊子会话和交互所有权分裂。

**让 API 副本拥有实时 Agent。** 否决，因为无状态入口扩缩容和 WebSocket 重连不应决定哪个进程持有执行状态。

**把每个选择启用的包都加入发布的 standard 预设。** 否决，因为这会偏离上游默认值，并强制没有配置的租户启动外部 MCP 服务和语言服务器。一致性意味着保留上游组合选择并让其扩展机制可用，而不是更改正式目录。

## Consequences

- 上游预设修改和工具新增通过相同组合文件进入分布式运行时，目录 e2e 断言会检测漂移。
- Redis Worker 不拥有 Agent、工具、后台任务、subagent、工作流或 Cordis 状态，因此仍可横向扩展。
- 提问与审批可跨 API 副本变化；会话事件与子会话谱系可跨 Worker 变化和 Workspace 重启。
- 动态 Cordis 运行、后台进程和其他进程内上游状态保留上游的进程生命周期语义，并会在单例 Workspace 重启时停止。
- 单例 Workspace 是有意选择的可用性与信任边界。它提供逻辑租户路径隔离，不提供敌对租户命令隔离或横向执行扩展。
