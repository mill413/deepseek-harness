# Distributed Harness

English | [中文](README.zh.md)

This app turns the in-process Harness into a small multi-tenant API–Redis–Worker deployment. PostgreSQL is authoritative for tenants, commands, session headers, and the append-only Harness event log; Redis Streams provides admission scheduling, Redis keys carry renewable session leases and worker heartbeats, and Redis Pub/Sub accelerates cancellation without becoming a source of truth.

```mermaid
flowchart LR
  B[Browser] --> W[Web / Nginx]
  C[REST client] --> A[API]
  W --> A
  A --> P[(PostgreSQL)]
  A --> R[(Redis)]
  R --> W1[Worker 1]
  R --> W2[Worker 2]
  W1 --> P
  W2 --> P
  W1 --> S[Workspace service]
  W2 --> S
  S --> V[(Persistent workspace volume)]
```

Browser users register or log in with a tenant slug, username, and password. The API stores scrypt password hashes and opaque browser-session hashes, then returns an HttpOnly, SameSite cookie that authenticates both HTTP and WebSocket traffic. Nginx removes caller-supplied identity headers. Every session, command, and event query includes the authenticated tenant key, and user-facing session operations also include the owner key. The direct API port retains `x-tenant-id` and `x-user-id` as a test/service identity adapter; do not expose it to untrusted networks.

## Run and test

From the repository root, start the fixed one-API/two-Worker topology and run the distributed scheduling test:

```sh
docker compose -f apps/distributed/docker-compose.yml up -d --build
node apps/distributed/scripts/e2e.mjs
docker compose -f apps/distributed/docker-compose.yml exec -T workspace node apps/distributed/scripts/workspace-e2e.mjs
docker compose -f apps/distributed/docker-compose.yml exec -T -e DSH_WEB_URL=http://web api-1 node apps/distributed/scripts/web-e2e.mjs
docker compose -f apps/distributed/docker-compose.yml --profile test up -d openai-mock
node apps/distributed/scripts/openai-e2e.mjs
```

The repository's native Web UI is available at `http://127.0.0.1:20810`. First use **Create tenant** to create a tenant administrator, then sign in with its tenant slug. Registration creates an isolated **Default** workspace; select it and type in the composer to start a conversation. Existing tenants and sessions are migrated into their own defaults. The independent Nginx container serves the built `apps/web` shell and the complete upstream Web client composition, forwards authenticated HTTP RPCs and WebSocket streams to the API, and never runs an Agent. The API also listens on `http://127.0.0.1:3101`. The working distributed adapters cover workspace and session management, durable history, prompts and cancellation, live events, tools, settings, encrypted credentials, model selection, agent presets, permission and plan modes, goals, message feedback, skills, and context compaction. The deterministic adapter deliberately makes a native `worker_probe` tool call before answering, while the `[workspace-e2e]` probe calls the remote `bash` tool, so tests cover the real Agent Loop, remote tool dispatch, checkpoint persistence, multi-Worker distribution, tenant isolation, session resume, and the Web–API compatibility protocol without consuming model credits.

One internal Workspace service owns the `workspace-data` volume. A PostgreSQL Workspace id maps deterministically to `/workspaces/<tenant-id>/<workspace-id>`; API and Worker containers do not mount that volume. Workers register RPC proxies for the upstream `read`, `write`, `edit`, `glob`, `grep`, `str_replace_editor`, `bash`, `job_output`, `job_list`, and `job_kill` definitions, and the original upstream implementations execute inside the Workspace container. Foreground and background shell processes, ripgrep searches, and file mutations therefore share the same persistent directory across both Workers and across Workspace-service restarts. Keep `WORKSPACE_SERVICE_TOKEN` equal on Workers and the Workspace service and do not publish port 3200.

The distributed adapters are Cordis plugins rather than forks of the upstream tools. The Workspace runtime plugin composes the original filesystem, search, editor, Bash, and Jobs providers under one workspace-scoped lifecycle; the Worker adapter owns the remote catalog listener and proxy registrations. Each non-minimal command runtime mounts the upstream token meter, basic compaction, tool-result pruner, plan mode, `todo_write` tool, and repeat-call reminder. Workspace-local `.dsh/skills` and `.agents/skills` files are cataloged and can be loaded through the model-facing `skill` tool. The Web assembler derives its complete client roster from the upstream `base` and `web-app` Cordis compositions instead of maintaining a distributed whitelist. The [architecture decision](../../.agents/notes/implemented/architecture/2026-08-14-distributed-upstream-composition.md) distinguishes this client-composition parity from advanced capabilities that still need a distributed owner.

Tenant administrators configure models from **Settings → Models**. Choose Mock for credit-free testing, DeepSeek API, or OpenAI-compatible Chat Completions, then enter the default model, base URL, and optional API key. The earlier distributed shortcut was removed so the upstream settings view is the single UI owner; `GET` and `PUT /admin/model-config` remain available for automation and backward compatibility. OpenAI-compatible mode accepts either a base such as `https://api.openai.com/v1` or a complete `/chat/completions` URL and normalizes the latter to its base. General UI settings, model settings, credential references, and agent-preset defaults are tenant scoped; revisions use compare-and-set writes. Credential values are encrypted with AES-256-GCM in PostgreSQL and are never returned by the API. Each Worker resolves this tenant-scoped snapshot before a command starts, so keys are not placed in process-global environment variables.

OpenAI-compatible mode mounts the upstream `@deepseek-ai/dsh-llm-pi-ai` Cordis plugin under the `openai-compatible` provider route with the `openai-completions` protocol. Its streaming text, native tool calls, usage, finish reasons, cancellation, and error conversion therefore use the upstream adapter rather than a distributed-app protocol fork. The configured model id is passed through to the endpoint; local gateways that do not require authentication may leave the key empty.

The following deployment variables provide initial/fallback defaults:

```dotenv
DISTRIBUTED_LLM_MODE=deepseek
DEFAULT_PROVIDER=deepseek-official
DEFAULT_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=replace-me
DEEPSEEK_BASE_URL=https://api.deepseek.com
OPENAI_API_KEY=replace-me
OPENAI_BASE_URL=https://api.openai.com/v1
MODEL_CONFIG_ENCRYPTION_KEY=replace-with-a-long-random-production-secret
```

```sh
docker compose --env-file apps/distributed/.env -f apps/distributed/docker-compose.yml up -d --build
```

New sessions receive the tenant's configured default; existing sessions retain their stored provider and model until selected again. Keep `MODEL_CONFIG_ENCRYPTION_KEY` stable across the API and all Workers and across restarts, or stored tenant keys cannot be decrypted. Use a secret manager in production rather than the Compose development default.

## API surface

- `POST /auth/register`, `POST /auth/login`, `GET /auth/session`, and `POST /auth/logout` implement browser authentication.
- `GET` and `PUT /admin/model-config` manage the authenticated administrator's tenant model without returning its secret.
- `/api/workspace.*` manages tenant-isolated logical workspaces, manual ordering, session attachment, and archival state.
- `/api/session.*`, `/api/host.describe`, and the `/api/events.mux` and `/api/events.host` WebSockets provide the native Web client compatibility layer.
- `/api/settings.*` and `/api/credentials.*` provide revision-fenced tenant settings and write-only encrypted credentials.
- `/api/commands/*`, `/api/goals/*`, `/api/agentPreset.*`, `/api/messageFeedback/*`, `/api/skill.list`, and `/api/pluginInventory/list` back the corresponding upstream Web plugins.
- `POST /v1/sessions` creates a tenant-owned session.
- `GET /v1/sessions` and `GET /v1/sessions/:id` read owned sessions.
- `POST /v1/sessions/:id/messages` creates an idempotently claimable command and returns `202`.
- `GET /v1/commands/:id` reports command state, Worker identity, final text, and error.
- `GET /v1/sessions/:id/events?afterSeq=N` reads the durable event suffix.
- `GET /v1/sessions/:id/stream?afterSeq=N` streams the same PostgreSQL-backed events over SSE.
- `POST /v1/sessions/:id/cancel` records durable cancellation intent and publishes a best-effort wake-up.
- `GET /healthz` checks the API, PostgreSQL, and Redis connections.

## Delivery and recovery contract

The API pumps queued PostgreSQL command rows to one Redis consumer-group stream with `FOR UPDATE SKIP LOCKED`. Delivery is at least once: a crash after `XADD` and before the SQL update may duplicate a stream entry, while the atomic command claim prevents duplicate execution. A Worker must hold the Redis lease for `tenant/session` before claiming work, so one session has only one active turn across the cluster. Harness semantic checkpoints durably flush the request prefix before model calls and top-level tool side effects.

A Worker updates both its Redis heartbeat and the active command heartbeat. API pumps return stale running commands to the outbox after two lease windows. Worker startup and request handling use one advisory-locked idempotent migration. Events are served from PostgreSQL, so lost Redis notifications do not lose transcript data.

## Limitations

- The MVP creates a fresh Harness runtime for each command rather than keeping a sticky long-lived Session Actor; this favors simple failover over latency.
- Redis pending entries left by a process crash are not compacted with `XAUTOCLAIM`; SQL recovery creates a fresh schedulable entry, so a long-running deployment needs pending-entry reclamation and stream trimming.
- The stale-command timeout is a coarse lease-based policy. Production deployments need workload-specific deadlines, retry classification, poison-command handling, and a dead-letter workflow.
- Interactive approvals and questions, distributed subagent and workflow ownership, MCP server lifecycle, live Cordis plugin reconfiguration, Web search, LSP, tenant quotas, audit logging, user invitation/management, password recovery, MFA, and PostgreSQL row-level security are not implemented by the distributed adapters. Their upstream client views may show durable events or an empty state; unsupported mutations fail explicitly. The static deployment still serves the upstream HMR client's idle SSE endpoint and accepts the dynamic Cordis inspect-manifest/empty-inventory read handshake so these intentionally empty views do not emit transport errors.
- Shared persistent files, workspace skills, upstream file/search/edit/Bash/job tools, directory browsing, session rename and fork, and attachment metadata are implemented. Repository clone lifecycle, browser upload/download, image-content delivery to models, and deliverable storage still need distributed ownership.
- The single Workspace container is one shared trust boundary. RPC path checks prevent ordinary file/search/editor traversal, but arbitrary Bash commands are intentionally powerful and can inspect the container; this topology provides logical tenant routing, not a hard sandbox for mutually untrusted tenants. Use one container or microVM per trust domain when strong tenant isolation is required.
- Background jobs survive Worker command runtimes but not a Workspace-service restart, and remote job completion does not yet wake an idle Agent automatically; the model can collect known jobs with `job_output` on a later turn.
- Queue editing accepts the upstream RPC but does not yet steer a live per-command Agent actor; a running turn must finish or be cancelled before an API-owned session event such as a mode change can be written. Subagent history/prompt/interrupt operations remain unsupported, while the catalog correctly stays empty until distributed child sessions exist.
- Browser login and tenant isolation are functional, but production operation still requires TLS, cookie `Secure` policy at ingress, CSRF hardening for broader cross-origin deployments, session revocation administration, rate limits, and external identity-provider integration where required.
- The SSE implementation polls PostgreSQL and is intentionally simple; production fan-out should use committed-event notifications as an acceleration path while retaining sequence-based database catch-up.

## Model Experience

The distribution layer adds no model-visible tenant, Redis, Worker, or Workspace RPC protocol. The model sees the ordinary Harness system prompt, durable conversation history, upstream tool guidance, and registered tool schemas. The Worker-side definitions are transparent RPC proxies; their successful model-facing content comes from the original tool renderer in the Workspace service. The deterministic test adapter calls `worker_probe` or the explicit Workspace probe; official DeepSeek and OpenAI-compatible modes receive the same Harness-level context and tool contract. Distribution metadata stays in command rows and infrastructure keys rather than entering prompts, so routing changes do not invalidate the model prefix by themselves.
