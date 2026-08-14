# Agent Note: Upstream runtime parity in the singleton Workspace

Status: implemented

English | [中文](2026-08-14-distributed-runtime-parity.zh.md)

## Problem

The first distributed Web integration reused the upstream browser composition but executed a hand-selected tool subset through short-lived Worker runtimes. That split preserved the page while omitting runtime-owned behavior: preset-scoped schemas, Code Mode, questions and approvals, child agents, workflows, dynamic Cordis plugins, and tenant-authored preset execution. Adding one proxy per tool would permanently trail the upstream compositions and duplicate their lifecycle rules.

## Decision

The singleton Workspace process boots the upstream `base` and `web-app` Host compositions and the shipped `standard`, `code`, `minimal`, and `cordis` preset roster once per tenant Workspace. A queue Worker owns only Redis delivery, the session lease, cancellation forwarding, and command completion. It delegates the complete command to the retained upstream Agent handle in Workspace; PostgreSQL implements the upstream session-persistence interface and remains the durable event authority.

The model-visible catalog is therefore owned by the unmodified preset compositions. Standard mode exposes the upstream file, Bash, job, skill, goal, plan, todo, Web search, subagent, workflow, Ralph, and interaction tools. Code mode presents that same capability set through `run_code`; minimal mode keeps its upstream persistent-terminal `bash` and `str_replace_editor`; Cordis mode adds the seven upstream inspect, define, run, stop, and undefine tools. The Web host's upstream session-query service remains composed. MCP and LSP remain upstream opt-in composition packages rather than additions to the shipped presets; tenant-authored presets can mount them without changes to the distributed command protocol.

PostgreSQL also owns pending question and approval responses and materialized child-session lineage. The API and Workspace relay the official subagent list, history, continuation, and interrupt operations with tenant and direct-parent authorization. Browser-facing dynamic Cordis RPCs route to the Workspace process that owns the live Agent and plugin registry; inspect manifests are retained per tenant and replayed when a later Workspace context starts. Tenant-authored preset rows are materialized into a private user roster before each new Agent mount, so the official roster discovers copied or removed presets without a second preset loader.

Model and credential mutations retire the tenant's idle Workspace contexts. An active command finishes on its existing generation, after which the context is retired; the next command boots adapters from the new PostgreSQL configuration. This prevents API replicas and queue Workers from owning stale model secrets while preserving one execution owner per tenant Workspace.

## Verification

`apps/distributed/scripts/tool-parity-e2e.mjs` sends real commands through one API, Redis, two Workers, and Workspace. It compares all four model-visible preset catalogs, completes question response delivery, goal creation, Code Mode, child-agent and workflow runs, reads child history through the Web RPC, defines a dynamic Cordis package and reads it through browser inventory, and executes a PostgreSQL-authored preset. `e2e.mjs` verifies API ingress and two-Worker distribution, tenant isolation, official Bash and todo execution, PostgreSQL event ordering, and resume. `workspace-e2e.mjs` invokes the official Agent runtime directly and verifies two isolated persistent directories.

## Alternatives considered

**Maintain a distributed tool whitelist and forward each execution.** Rejected because preset composition, prompt sections, renderers, Code Mode, child lifecycles, and new upstream tools would still require parallel implementations.

**Boot the upstream Agent inside every queue Worker.** Rejected because Redis may assign successive turns to different Workers, splitting live jobs, Cordis registries, continuable children, and interaction ownership.

**Make API replicas own live Agents.** Rejected because stateless ingress scaling and WebSocket reconnection must not select the process that owns execution state.

**Add every opt-in package to the shipped standard preset.** Rejected because that would diverge from upstream defaults and force external MCP servers and language servers on tenants that did not configure them. Parity means preserving upstream composition choices and making their extension mechanism usable, not changing the official catalog.

## Consequences

- Upstream preset edits and tool additions reach the distributed runtime through the same composition files, with catalog e2e assertions detecting drift.
- Redis Workers remain horizontally scalable because they do not own Agent, tool, job, subagent, workflow, or Cordis state.
- Questions and approvals survive API replica changes; session events and child lineage survive Worker changes and Workspace restarts.
- Dynamic Cordis runs, background processes, and other process-local upstream state retain upstream process-lifetime semantics and stop when the singleton Workspace restarts.
- The singleton Workspace is a deliberate availability and trust boundary. It provides logical tenant path isolation, not hostile-tenant command isolation or horizontal execution scaling.
