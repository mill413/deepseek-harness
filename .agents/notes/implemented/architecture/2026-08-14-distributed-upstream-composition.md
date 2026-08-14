# Agent Note: Upstream-owned Web composition with distributed capability adapters

Status: implemented

English | [中文](2026-08-14-distributed-upstream-composition.zh.md)

## Problem

The distributed deployment originally assembled a hand-maintained subset of the Web client and implemented only the RPCs needed by that subset. This made the page look unlike the upstream product, silently dropped settings and mode controls, and required every upstream client-plugin addition to be copied into a second roster. Mounting the upstream in-process Host unchanged would remove that drift, but its filesystem settings, credentials, live Agent handles, and local tool processes do not provide tenant or replica ownership.

## Decision

The upstream `base` and `web-app` Cordis compositions own the distributed Web roster. `apps/distributed/scripts/assemble-web.mjs` discovers every named package in those compositions whose manifest declares a Web `dsh.client` entry, adds the browser directory picker required by a remote Host, validates client injection dependencies, and emits the graph served by the Web container. The distributed app does not maintain a feature whitelist. An upstream client addition reaches this deployment through the same composition files and package manifest, subject to the distributed build and protocol tests.

The browser protocol is implemented as tenant-aware adapters instead of an in-process Host fork. PostgreSQL owns workspaces, session metadata and events, settings namespaces and revisions, encrypted credentials, copied agent presets, goals, attachments, and message feedback. API replicas expose the upstream session, workspace, settings, credentials, model, command, goal, feedback, preset, skill, and plugin-inventory RPC shapes; WebSocket projections and event catch-up read the same durable rows. Session creation materializes an upstream-compatible `SessionHeader` before UI-owned events can be appended, and API event writes refuse to race an active Worker turn.

Each Worker command composes the upstream Agent loop, session persistence and checkpoint policy, token meter, basic context compaction, tool-result pruning, plan mode, todo tool, repeat-call reminder, model adapter, and distributed workspace adapter. DeepSeek uses the upstream DeepSeek adapter and OpenAI-compatible Chat Completions uses the upstream Pi AI adapter. Tenant model settings and credential writes are resolved before each command, so replicas do not share process-global model secrets.

One internal Workspace container owns the persistent volume and runs the upstream filesystem, search, editor, Bash, subprocess, and background-job providers. Workers expose those schemas through ordinary Harness tool registrations and forward execution with tenant, workspace, and permission identity. Workspace-local `.dsh/skills` and `.agents/skills` directories supply the skill catalog and instruction bodies. This is a deployment ownership adapter: it does not fork the model-facing tool schemas or renderers.

Client composition parity does not assert runtime parity for capabilities that need a distributed owner. Interactive approvals and user questions, subagent and workflow execution, MCP server lifecycle, live Cordis plugin reconfiguration, Web search, LSP, and hard sandbox isolation remain unavailable until a tenant-scoped control plane and durable cross-process protocol exist for each one. Their upstream client plugins may render durable events produced elsewhere or an empty state, but the API returns an explicit failure for unsupported RPCs instead of pretending that an operation succeeded.

## Verification

`apps/distributed/scripts/web-e2e.mjs` exercises authentication, workspace selection, the upstream settings and model pages, settings mutation, write-only credentials, agent presets, modes, permissions, goals, message feedback, shared workspace tools, context compaction, WebSocket delivery, and tenant isolation through port 20810. `e2e.mjs`, `workspace-e2e.mjs`, and `openai-e2e.mjs` cover two-API/two-Worker scheduling and resume, original workspace providers, and the OpenAI-compatible adapter respectively. The TypeScript build and the Web assembler's dependency validation reject adapter or client-graph drift.

## Alternatives considered

**Keep a curated distributed Web plugin list.** Rejected because the list already removed user-visible upstream controls and made every upstream UI change a second manual integration task.

**Run the upstream CLI Host unchanged beside each API replica.** Rejected because filesystem settings, local credentials, in-memory Agent handles, and local process ownership would diverge between replicas and would not enforce tenant identity.

**Fork upstream client plugins for the distributed API.** Rejected because it duplicates UI behavior and wire shapes. The distributed boundary adapts Host RPC ownership while the upstream clients remain the presentation authority.

**Claim every visible upstream plugin as supported.** Rejected because client code is not the owner of execution semantics. Cross-process approvals, subagents, MCP, and workflows require explicit durable protocols; empty or explicit unsupported behavior is safer than a control that loses state or crosses tenants.

## Consequences

- Settings, mode, permission, goal, model, preset, feedback, skill, job, trajectory, deliverable, workflow, subagent, and plugin views use the upstream client implementations and styling.
- Upstream client composition changes are discovered automatically, while a new server capability still requires a deliberate tenant-aware adapter and an e2e assertion.
- PostgreSQL and Redis remain the distributed truth and scheduling layers; Cordis remains the composition and extension mechanism inside Worker and Workspace processes.
- The shared Workspace container favors simple file continuity across Workers. Bash has the power of that container and therefore provides logical routing, not a security boundary between hostile tenants.
- The unsupported capability list is part of the contract. Adding one requires choosing its durable owner rather than mounting an in-process plugin whose state disappears on the next Worker command.
