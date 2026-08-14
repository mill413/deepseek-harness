import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Duplex } from 'node:stream'
import {
  authenticate,
  clearSessionCookie,
  createBrowserSession,
  identityView,
  login,
  logout,
  registerTenant,
  setSessionCookie,
  type Identity,
} from './auth.ts'
import { config } from './config.ts'
import { migrate, one, pool, tx } from './db.ts'
import { assertUuid, HttpError } from './identity.ts'
import { publicModelConfig, saveTenantModelConfig, tenantModelConfig } from './model-config.ts'
import { connectRedis, type RedisClient } from './redis.ts'

interface WebSocketConnection {
  readonly readyState: number
  send(data: string): void
  close(): void
  once(event: 'close', listener: () => void): void
}

interface WebSocketServerInstance {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (websocket: WebSocketConnection) => void,
  ): void
  emit(event: 'connection', websocket: WebSocketConnection, request: IncomingMessage): boolean
  close(): void
}

interface WebSocketServerConstructor {
  new(options: { noServer: true }): WebSocketServerInstance
}

const require = createRequire(import.meta.url)
const webSocketModule = require('ws') as {
  WebSocket: { OPEN: number }
  WebSocketServer: WebSocketServerConstructor
}
const WebSocketRuntime = webSocketModule.WebSocket
const WebSocketServer = webSocketModule.WebSocketServer

interface SessionRow {
  id: string
  owner_user_id: string
  workspace_id: string | null
  provider: string
  model: string
  status: string
  created_at: Date
  updated_at: Date
}

interface CommandRow {
  id: string
  session_id: string
  status: string
  worker_id: string | null
  final_text: string | null
  error: unknown
  cancel_requested: boolean
  attempt: number
  created_at: Date
  started_at: Date | null
  completed_at: Date | null
}

interface RpcRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: Record<string, unknown>
}

interface RpcSessionRow extends SessionRow {
  event_count: string
  last_seq: string | null
  cwd: string | null
  archived: boolean
}

interface WorkspaceRow {
  id: string
  path: string
  title: string
  session_ids: string[]
  created_at: Date
  updated_at: Date
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 1_000_000) throw new HttpError(413, 'request body is too large')
    chunks.push(bytes)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('object required')
    return value as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'request body must be a JSON object')
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const encoded = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(encoded) })
  response.end(encoded)
}

function sessionView(row: SessionRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    provider: row.provider,
    model: row.model,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function commandView(row: CommandRow): Record<string, unknown> {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    workerId: row.worker_id,
    finalText: row.final_text,
    error: row.error,
    cancelRequested: row.cancel_requested,
    attempt: row.attempt,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

function rpcSuccess(rpcId: string, value: unknown): Record<string, unknown> {
  return { type: 'server-response', rpcId, result: { ok: true, value } }
}

function rpcFailure(rpcId: string, message: string): Record<string, unknown> {
  return {
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code: 'internal', message, details: {} } },
  }
}

function rpcRequest(input: Record<string, unknown>, pathMethod: string): RpcRequestEnvelope {
  if (input['type'] !== 'client-request'
    || typeof input['rpcId'] !== 'string'
    || typeof input['method'] !== 'string'
    || input['method'] !== pathMethod
    || typeof input['payload'] !== 'object'
    || input['payload'] === null
    || Array.isArray(input['payload'])) {
    throw new HttpError(400, 'invalid RPC request envelope')
  }
  return input as unknown as RpcRequestEnvelope
}

function modelGroup(provider: string, model: string): Record<string, unknown> {
  return {
    id: provider,
    name: provider === 'deepseek-official' ? 'DeepSeek' : provider,
    models: [{ id: model, name: model }],
  }
}

function rpcSessionSummary(row: RpcSessionRow): Record<string, unknown> {
  return {
    sessionId: row.id,
    updatedAt: row.updated_at.getTime(),
    running: row.status === 'running',
    blank: Number(row.event_count) === 0,
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
  }
}

function workspaceView(row: WorkspaceRow): Record<string, unknown> {
  return {
    workspaceId: row.id,
    path: row.path,
    title: row.title,
    sessionIds: row.session_ids,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

async function ownedSession(tenantId: string, userId: string, sessionId: string): Promise<SessionRow> {
  const row = await one<SessionRow>(
    'SELECT id, owner_user_id, workspace_id, provider, model, status, created_at, updated_at FROM sessions WHERE tenant_id = $1 AND id = $2 AND owner_user_id = $3',
    [tenantId, sessionId, userId],
  )
  if (row === undefined) throw new HttpError(404, 'session not found')
  return row
}

async function events(tenantId: string, sessionId: string, afterSeq: number): Promise<unknown[]> {
  const result = await pool.query<{ event: unknown }>(
    'SELECT event FROM session_events WHERE tenant_id = $1 AND session_id = $2 AND seq > $3 ORDER BY seq LIMIT 500',
    [tenantId, sessionId, afterSeq],
  )
  return result.rows.map(row => row.event)
}

async function rpcSessions(auth: Identity): Promise<RpcSessionRow[]> {
  const result = await pool.query<RpcSessionRow>(`
    SELECT s.id, s.owner_user_id, s.workspace_id, s.provider, s.model, s.status, s.created_at, s.updated_at,
      s.archived, w.path AS cwd, count(e.seq)::text AS event_count, max(e.seq)::text AS last_seq
    FROM sessions s
    LEFT JOIN tenant_workspaces w ON w.tenant_id = s.tenant_id AND w.id = s.workspace_id
    LEFT JOIN session_events e ON e.tenant_id = s.tenant_id AND e.session_id = s.id
    WHERE s.tenant_id = $1 AND s.owner_user_id = $2
    GROUP BY s.tenant_id, s.id, w.path
    ORDER BY s.updated_at DESC
    LIMIT 100
  `, [auth.tenantId, auth.userId])
  return result.rows
}

async function workspaceRows(auth: Identity): Promise<WorkspaceRow[]> {
  const result = await pool.query<WorkspaceRow>(`
    SELECT w.id, w.path, w.title, w.created_at, w.updated_at,
      coalesce(array_agg(s.id::text ORDER BY s.workspace_order, s.created_at)
        FILTER (WHERE s.id IS NOT NULL), ARRAY[]::text[]) AS session_ids
    FROM tenant_workspaces w
    LEFT JOIN sessions s ON s.tenant_id = w.tenant_id AND s.workspace_id = w.id AND s.owner_user_id = $2
    WHERE w.tenant_id = $1
    GROUP BY w.tenant_id, w.id
    ORDER BY w.sort_order, w.created_at
  `, [auth.tenantId, auth.userId])
  return result.rows
}

async function workspaceById(auth: Identity, workspaceId: string): Promise<WorkspaceRow> {
  const row = (await workspaceRows(auth)).find(candidate => candidate.id === workspaceId)
  if (row === undefined) throw new HttpError(404, 'workspace not found')
  return row
}

async function createSession(
  auth: Identity,
  provider: string,
  model: string,
  requestedId?: string,
  requestedWorkspaceId?: string,
): Promise<SessionRow> {
  const id = requestedId === undefined ? randomUUID() : assertUuid(requestedId, 'sessionId')
  await tx(async (client) => {
    await client.query(
      'INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [auth.tenantId, `tenant-${auth.tenantId.slice(0, 8)}`, `tenant-${auth.tenantId.replaceAll('-', '')}`],
    )
    await client.query(`
      INSERT INTO tenant_workspaces (tenant_id, id, path, title, sort_order, is_default)
      SELECT $1, $2, '/workspace', 'Default', 0, true
      WHERE NOT EXISTS (SELECT 1 FROM tenant_workspaces WHERE tenant_id = $1 AND is_default)
    `, [auth.tenantId, randomUUID()])
    const workspace = requestedWorkspaceId === undefined
      ? await client.query<{ id: string }>('SELECT id FROM tenant_workspaces WHERE tenant_id = $1 AND is_default', [auth.tenantId])
      : await client.query<{ id: string }>('SELECT id FROM tenant_workspaces WHERE tenant_id = $1 AND id = $2', [auth.tenantId, assertUuid(requestedWorkspaceId, 'workspaceId')])
    const workspaceId = workspace.rows[0]?.id
    if (workspaceId === undefined) throw new HttpError(404, 'workspace not found')
    await client.query(
      `INSERT INTO sessions (tenant_id, id, owner_user_id, workspace_id, workspace_order, provider, model)
       VALUES ($1, $2, $3, $4, -floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint, $5, $6)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [auth.tenantId, id, auth.userId, workspaceId, provider, model],
    )
  })
  return ownedSession(auth.tenantId, auth.userId, id)
}

async function enqueueMessage(
  redis: RedisClient,
  auth: Identity,
  sessionId: string,
  text: string,
): Promise<CommandRow> {
  const commandId = randomUUID()
  await pool.query(
    `INSERT INTO agent_commands (tenant_id, id, session_id, user_id, kind, payload)
     VALUES ($1, $2, $3, $4, 'message', $5::jsonb)`,
    [auth.tenantId, commandId, sessionId, auth.userId, JSON.stringify({ text })],
  )
  void pumpOutbox(redis).catch((error: unknown) => { console.error('outbox pump failed', error) })
  return await one<CommandRow>(
    'SELECT * FROM agent_commands WHERE tenant_id = $1 AND id = $2',
    [auth.tenantId, commandId],
  ) as CommandRow
}

async function cancelSession(redis: RedisClient, auth: Identity, sessionId: string): Promise<string[]> {
  const result = await pool.query<{ id: string }>(`
    UPDATE agent_commands SET cancel_requested = true
    WHERE tenant_id = $1 AND session_id = $2 AND status IN ('queued', 'running')
    RETURNING id
  `, [auth.tenantId, sessionId])
  await redis.publish('dsh:agent:cancel', JSON.stringify({ tenantId: auth.tenantId, sessionId }))
  return result.rows.map(row => row.id)
}

async function handleRpc(
  redis: RedisClient,
  auth: Identity,
  request: RpcRequestEnvelope,
): Promise<Record<string, unknown>> {
  const payload = request.payload
  const modelConfig = await tenantModelConfig(auth.tenantId)
  const sessionIdValue = payload['sessionId']
  const sessionId = typeof sessionIdValue === 'string' ? assertUuid(sessionIdValue, 'sessionId') : undefined
  try {
    switch (request.method) {
      case 'session.list':
        return rpcSuccess(request.rpcId, { items: (await rpcSessions(auth)).map(rpcSessionSummary) })
      case 'session.search':
        return rpcSuccess(request.rpcId, { items: [], hasMore: false })
      case 'session.create': {
        const requestedId = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined
        const requestedWorkspaceId = typeof payload['workspaceId'] === 'string' ? payload['workspaceId'] : undefined
        const row = await createSession(auth, modelConfig.provider, modelConfig.defaultModel, requestedId, requestedWorkspaceId)
        return rpcSuccess(request.rpcId, { sessionId: row.id })
      }
      case 'session.history': {
        if (sessionId === undefined) throw new HttpError(400, 'sessionId is required')
        await ownedSession(auth.tenantId, auth.userId, sessionId)
        const beforeSeq = typeof payload['beforeSeq'] === 'number' ? payload['beforeSeq'] : undefined
        const result = await pool.query<{ event: unknown }>(`
          SELECT event FROM session_events
          WHERE tenant_id = $1 AND session_id = $2 AND ($3::bigint IS NULL OR seq < $3)
          ORDER BY seq ASC LIMIT 1000
        `, [auth.tenantId, sessionId, beforeSeq ?? null])
        return rpcSuccess(request.rpcId, {
          events: result.rows.map(row => ({ event: row.event })),
          hasMore: false,
        })
      }
      case 'session.models': {
        if (sessionId === undefined) throw new HttpError(400, 'sessionId is required')
        const row = await ownedSession(auth.tenantId, auth.userId, sessionId)
        return rpcSuccess(request.rpcId, {
          current: { provider: row.provider, model: row.model },
          routable: row.provider === modelConfig.provider,
          groups: [modelGroup(modelConfig.provider, modelConfig.defaultModel)],
          failures: [],
        })
      }
      case 'session.selectModel': {
        if (sessionId === undefined) throw new HttpError(400, 'sessionId is required')
        const provider = payload['provider']
        const model = payload['model']
        if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
          throw new HttpError(400, 'provider and model are required')
        }
        if (provider !== modelConfig.provider || model !== modelConfig.defaultModel) {
          throw new HttpError(400, 'the selected model is not enabled for this tenant')
        }
        await ownedSession(auth.tenantId, auth.userId, sessionId)
        await pool.query(
          'UPDATE sessions SET provider = $3, model = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2',
          [auth.tenantId, sessionId, provider, model],
        )
        return rpcSuccess(request.rpcId, { selected: { provider, model } })
      }
      case 'session.prompt': {
        if (sessionId === undefined) throw new HttpError(400, 'sessionId is required')
        await ownedSession(auth.tenantId, auth.userId, sessionId)
        const content = payload['content']
        if (!Array.isArray(content)) throw new HttpError(400, 'content is required')
        const text = content.flatMap((part) => {
          if (typeof part !== 'object' || part === null) return []
          const value = part as Record<string, unknown>
          return value['type'] === 'text' && typeof value['text'] === 'string' ? [value['text']] : []
        }).join('\n').trim()
        if (text === '') throw new HttpError(400, 'text content is required')
        await enqueueMessage(redis, auth, sessionId, text)
        return rpcSuccess(request.rpcId, { accepted: true })
      }
      case 'session.cancel': {
        if (sessionId === undefined) throw new HttpError(400, 'sessionId is required')
        await ownedSession(auth.tenantId, auth.userId, sessionId)
        await cancelSession(redis, auth, sessionId)
        return rpcSuccess(request.rpcId, { accepted: true })
      }
      case 'host.describe': {
        const sessions = await rpcSessions(auth)
        return rpcSuccess(request.rpcId, {
          version: 'distributed-v1',
          cwd: '/workspace',
          provider: modelConfig.provider,
          model: modelConfig.defaultModel,
          attachedSessions: sessions.filter(row => row.status === 'running').length,
          canOpenPath: false,
        })
      }
      case 'workspace.list': {
        const archived = (await rpcSessions(auth)).filter(row => row.archived).map(row => row.id)
        return rpcSuccess(request.rpcId, { items: (await workspaceRows(auth)).map(workspaceView), archivedSessionIds: archived })
      }
      case 'workspace.create': {
        const rawPath = payload['path']
        if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) throw new HttpError(400, 'workspace path must be absolute')
        const normalized = `/${rawPath.split('/').filter(Boolean).join('/')}`
        const existing = await one<{ id: string }>('SELECT id FROM tenant_workspaces WHERE tenant_id = $1 AND path = $2', [auth.tenantId, normalized])
        if (existing !== undefined) {
          return rpcSuccess(request.rpcId, { workspace: workspaceView(await workspaceById(auth, existing.id)), created: false })
        }
        const workspaceId = randomUUID()
        const title = normalized.split('/').filter(Boolean).at(-1) ?? 'Workspace'
        await pool.query(`
          INSERT INTO tenant_workspaces (tenant_id, id, path, title, sort_order)
          VALUES ($1, $2, $3, $4,
            coalesce((SELECT max(sort_order) + 1 FROM tenant_workspaces WHERE tenant_id = $1), 0))
        `, [auth.tenantId, workspaceId, normalized, title])
        return rpcSuccess(request.rpcId, { workspace: workspaceView(await workspaceById(auth, workspaceId)), created: true })
      }
      case 'workspace.rename': {
        const workspaceId = typeof payload['workspaceId'] === 'string' ? assertUuid(payload['workspaceId'], 'workspaceId') : undefined
        const title = typeof payload['title'] === 'string' ? payload['title'].trim() : ''
        if (workspaceId === undefined || title === '') throw new HttpError(400, 'workspaceId and title are required')
        await workspaceById(auth, workspaceId)
        const conflict = await one<{ id: string }>(
          'SELECT id FROM tenant_workspaces WHERE tenant_id = $1 AND id <> $2 AND lower(title) = lower($3)',
          [auth.tenantId, workspaceId, title],
        )
        if (conflict !== undefined) throw new HttpError(409, 'workspace title already exists')
        await pool.query('UPDATE tenant_workspaces SET title = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2', [auth.tenantId, workspaceId, title])
        return rpcSuccess(request.rpcId, { workspace: workspaceView(await workspaceById(auth, workspaceId)) })
      }
      case 'workspace.delete': {
        const workspaceId = typeof payload['workspaceId'] === 'string' ? assertUuid(payload['workspaceId'], 'workspaceId') : undefined
        if (workspaceId === undefined) throw new HttpError(400, 'workspaceId is required')
        const target = await one<{ is_default: boolean }>('SELECT is_default FROM tenant_workspaces WHERE tenant_id = $1 AND id = $2', [auth.tenantId, workspaceId])
        if (target === undefined) throw new HttpError(404, 'workspace not found')
        if (target.is_default) throw new HttpError(409, 'the default workspace cannot be deleted')
        await pool.query('DELETE FROM tenant_workspaces WHERE tenant_id = $1 AND id = $2', [auth.tenantId, workspaceId])
        return rpcSuccess(request.rpcId, { deleted: true })
      }
      case 'workspace.insertBefore': {
        const workspaceId = typeof payload['workspaceId'] === 'string' ? assertUuid(payload['workspaceId'], 'workspaceId') : undefined
        const beforeWorkspaceId = typeof payload['beforeWorkspaceId'] === 'string' ? assertUuid(payload['beforeWorkspaceId'], 'beforeWorkspaceId') : undefined
        if (workspaceId === undefined) throw new HttpError(400, 'workspaceId is required')
        const rows = await workspaceRows(auth)
        if (!rows.some(row => row.id === workspaceId) || (beforeWorkspaceId !== undefined && !rows.some(row => row.id === beforeWorkspaceId))) {
          throw new HttpError(404, 'workspace not found')
        }
        const ids = rows.map(row => row.id).filter(id => id !== workspaceId)
        const at = beforeWorkspaceId === undefined ? ids.length : ids.indexOf(beforeWorkspaceId)
        ids.splice(at, 0, workspaceId)
        await tx(async (client) => {
          for (const [index, id] of ids.entries()) {
            await client.query('UPDATE tenant_workspaces SET sort_order = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2', [auth.tenantId, id, index])
          }
        })
        return rpcSuccess(request.rpcId, { workspaceIds: ids })
      }
      case 'workspace.insertSessionBefore': {
        const workspaceId = typeof payload['workspaceId'] === 'string' ? assertUuid(payload['workspaceId'], 'workspaceId') : undefined
        const movingSessionId = typeof payload['sessionId'] === 'string' ? assertUuid(payload['sessionId'], 'sessionId') : undefined
        const beforeSessionId = typeof payload['beforeSessionId'] === 'string' ? assertUuid(payload['beforeSessionId'], 'beforeSessionId') : undefined
        if (workspaceId === undefined || movingSessionId === undefined) throw new HttpError(400, 'workspaceId and sessionId are required')
        const workspace = await workspaceById(auth, workspaceId)
        if (!workspace.session_ids.includes(movingSessionId)
          || (beforeSessionId !== undefined && !workspace.session_ids.includes(beforeSessionId))) {
          throw new HttpError(400, 'session or anchor is not in this workspace')
        }
        const ids = workspace.session_ids.filter(id => id !== movingSessionId)
        const at = beforeSessionId === undefined ? ids.length : ids.indexOf(beforeSessionId)
        ids.splice(at, 0, movingSessionId)
        await tx(async (client) => {
          for (const [index, id] of ids.entries()) {
            await client.query(`
              UPDATE sessions SET workspace_order = $4
              WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3 AND owner_user_id = $5
            `, [auth.tenantId, workspaceId, id, index, auth.userId])
          }
          await client.query('UPDATE tenant_workspaces SET updated_at = now() WHERE tenant_id = $1 AND id = $2', [auth.tenantId, workspaceId])
        })
        return rpcSuccess(request.rpcId, { workspace: workspaceView(await workspaceById(auth, workspaceId)) })
      }
      case 'workspace.archiveSession': {
        if (sessionId === undefined) throw new HttpError(400, 'sessionId is required')
        await ownedSession(auth.tenantId, auth.userId, sessionId)
        await pool.query('UPDATE sessions SET archived = true, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND owner_user_id = $3', [auth.tenantId, sessionId, auth.userId])
        const archived = (await rpcSessions(auth)).filter(row => row.archived).map(row => row.id)
        return rpcSuccess(request.rpcId, { archivedSessionIds: archived })
      }
      case 'skill.list':
        return rpcSuccess(request.rpcId, { skills: [] })
      case 'agentPreset.list':
        return rpcSuccess(request.rpcId, { presets: [], authorable: false, hasDocument: false })
      case 'settings.describe':
        return rpcSuccess(request.rpcId, { writable: false, hasDocument: false, namespaces: [] })
      case 'credentials.describe': {
        const refs = Array.isArray(payload['refs']) ? payload['refs'] : []
        return rpcSuccess(request.rpcId, {
          credentials: Object.fromEntries(refs.filter(ref => typeof ref === 'string').map(ref => [ref, {
            configured: modelConfig.apiKeyConfigured,
            writable: false,
          }])),
        })
      }
      case 'llm.providers':
        return rpcSuccess(request.rpcId, {
          providers: [{
            provider: modelConfig.provider,
            displayName: modelConfig.provider === 'deepseek-official' ? 'DeepSeek' : modelConfig.provider,
            settingsNs: '',
            settingsPath: [],
            active: true,
          }],
        })
      case 'llm.models':
        return rpcSuccess(request.rpcId, {
          groups: [modelGroup(modelConfig.provider, modelConfig.defaultModel)],
          failures: [],
        })
      case 'subagent.list':
        return rpcSuccess(request.rpcId, { entries: [], parentAvailable: true })
      default:
        return rpcFailure(request.rpcId, `${request.method} is not available in distributed Web phase 1`)
    }
  } catch (error) {
    return rpcFailure(request.rpcId, error instanceof Error ? error.message : String(error))
  }
}

async function pumpOutbox(redis: RedisClient): Promise<void> {
  await tx(async (client) => {
    await client.query(`
      UPDATE agent_commands SET status = 'queued', worker_id = NULL, dispatched_at = NULL,
        next_dispatch_at = now(), started_at = NULL, heartbeat_at = NULL
      WHERE status = 'running' AND heartbeat_at < now() - ($1 * interval '1 second')
    `, [config.leaseSeconds * 2])
    const result = await client.query<{ tenant_id: string; id: string; session_id: string }>(`
      SELECT tenant_id, id, session_id FROM agent_commands
      WHERE status = 'queued' AND dispatched_at IS NULL AND next_dispatch_at <= now()
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED LIMIT 50
    `)
    for (const row of result.rows) {
      await redis.xAdd(config.stream, '*', { tenantId: row.tenant_id, commandId: row.id, sessionId: row.session_id })
      await client.query(
        'UPDATE agent_commands SET dispatched_at = now() WHERE tenant_id = $1 AND id = $2 AND status = $3',
        [row.tenant_id, row.id, 'queued'],
      )
    }
  })
}

function requiredText(input: Record<string, unknown>, key: string, minimum: number, maximum: number): string {
  const value = input[key]
  if (typeof value !== 'string') throw new HttpError(400, `${key} is required`)
  const trimmed = value.trim()
  if (trimmed.length < minimum || trimmed.length > maximum) {
    throw new HttpError(400, `${key} must contain ${minimum}-${maximum} characters`)
  }
  return trimmed
}

function authRegistration(input: Record<string, unknown>): { tenantName: string; tenantSlug: string; username: string; password: string } {
  const tenantName = requiredText(input, 'tenantName', 2, 80)
  const tenantSlug = requiredText(input, 'tenantSlug', 3, 32).toLocaleLowerCase('en-US')
  const username = requiredText(input, 'username', 2, 64)
  const password = requiredText(input, 'password', 8, 256)
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/u.test(tenantSlug)) {
    throw new HttpError(400, 'tenantSlug may contain lowercase letters, numbers, and hyphens')
  }
  return { tenantName, tenantSlug, username, password }
}

function authLogin(input: Record<string, unknown>): { tenantSlug: string; username: string; password: string } {
  return {
    tenantSlug: requiredText(input, 'tenantSlug', 3, 32).toLocaleLowerCase('en-US'),
    username: requiredText(input, 'username', 2, 64),
    password: requiredText(input, 'password', 1, 256),
  }
}

function modelConfigUpdate(input: Record<string, unknown>): {
  mode: 'mock' | 'deepseek'
  defaultModel: string
  baseUrl: string | null
  apiKey?: string
  clearApiKey: boolean
} {
  const mode = input['mode']
  if (mode !== 'mock' && mode !== 'deepseek') throw new HttpError(400, 'mode must be mock or deepseek')
  const defaultModel = requiredText(input, 'defaultModel', 1, 128)
  let baseUrl: string | null = null
  if (mode === 'deepseek') {
    const raw = requiredText(input, 'baseUrl', 8, 2048)
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new HttpError(400, 'baseUrl must be a valid URL')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new HttpError(400, 'baseUrl must use http or https')
    baseUrl = parsed.toString().replace(/\/$/u, '')
  }
  const apiKeyValue = input['apiKey']
  const apiKey = typeof apiKeyValue === 'string' && apiKeyValue.trim() !== '' ? apiKeyValue.trim() : undefined
  return { mode, defaultModel, baseUrl, ...(apiKey === undefined ? {} : { apiKey }), clearApiKey: input['clearApiKey'] === true }
}

async function route(request: IncomingMessage, response: ServerResponse, redis: RedisClient): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (request.method === 'GET' && url.pathname === '/healthz') {
    await pool.query('SELECT 1')
    const pong = await redis.ping()
    send(response, 200, { ok: true, role: 'api', instanceId: config.apiInstanceId, postgres: 'ok', redis: pong })
    return
  }

  if (request.method === 'POST' && url.pathname === '/auth/register') {
    const auth = await registerTenant(authRegistration(await body(request)))
    setSessionCookie(response, await createBrowserSession(auth))
    send(response, 201, identityView(auth))
    return
  }
  if (request.method === 'POST' && url.pathname === '/auth/login') {
    const auth = await login(authLogin(await body(request)))
    setSessionCookie(response, await createBrowserSession(auth))
    send(response, 200, identityView(auth))
    return
  }
  if (request.method === 'POST' && url.pathname === '/auth/logout') {
    await logout(request)
    clearSessionCookie(response)
    send(response, 200, { ok: true })
    return
  }

  const auth = await authenticate(request)
  if (request.method === 'GET' && url.pathname === '/auth/session') {
    send(response, 200, identityView(auth))
    return
  }
  if (url.pathname === '/admin/model-config') {
    if (auth.role !== 'admin') throw new HttpError(403, 'tenant administrator role required')
    if (request.method === 'GET') {
      send(response, 200, publicModelConfig(await tenantModelConfig(auth.tenantId)))
      return
    }
    if (request.method === 'PUT') {
      const updated = await saveTenantModelConfig(auth.tenantId, auth.userId, modelConfigUpdate(await body(request)))
      send(response, 200, publicModelConfig(updated))
      return
    }
  }
  const rpcMatch = request.method === 'POST' ? /^\/api\/(.+)$/.exec(url.pathname) : null
  if (rpcMatch !== null) {
    const method = rpcMatch[1] as string
    const input = await body(request)
    const envelope = rpcRequest(input, method)
    send(response, 200, await handleRpc(redis, auth, envelope))
    return
  }
  if (request.method === 'POST' && url.pathname === '/v1/sessions') {
    const input = await body(request)
    const effective = await tenantModelConfig(auth.tenantId)
    const provider = typeof input['provider'] === 'string' ? input['provider'] : effective.provider
    const model = typeof input['model'] === 'string' ? input['model'] : effective.defaultModel
    const row = await createSession(auth, provider, model)
    send(response, 201, sessionView(row))
    return
  }

  if (request.method === 'GET' && url.pathname === '/v1/sessions') {
    const result = await pool.query<SessionRow>(
      'SELECT id, owner_user_id, workspace_id, provider, model, status, created_at, updated_at FROM sessions WHERE tenant_id = $1 AND owner_user_id = $2 ORDER BY created_at DESC LIMIT 100',
      [auth.tenantId, auth.userId],
    )
    send(response, 200, { sessions: result.rows.map(sessionView) })
    return
  }

  const sessionMatch = /^\/v1\/sessions\/([^/]+)(?:\/(messages|cancel|events|stream))?$/.exec(url.pathname)
  if (sessionMatch !== null) {
    const sessionId = assertUuid(sessionMatch[1] ?? '', 'session id')
    const action = sessionMatch[2]
    const session = await ownedSession(auth.tenantId, auth.userId, sessionId)
    if (request.method === 'GET' && action === undefined) {
      send(response, 200, sessionView(session))
      return
    }
    if (request.method === 'POST' && action === 'messages') {
      const input = await body(request)
      const text = input['text']
      if (typeof text !== 'string' || text.trim() === '') throw new HttpError(400, 'text must be a non-empty string')
      const command = await enqueueMessage(redis, auth, sessionId, text.trim())
      send(response, 202, commandView(command))
      return
    }
    if (request.method === 'POST' && action === 'cancel') {
      send(response, 202, { cancelledCommands: await cancelSession(redis, auth, sessionId) })
      return
    }
    if (request.method === 'GET' && action === 'events') {
      const afterSeq = Number(url.searchParams.get('afterSeq') ?? '-1')
      if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw new HttpError(400, 'afterSeq must be an integer at least -1')
      send(response, 200, { events: await events(auth.tenantId, sessionId, afterSeq) })
      return
    }
    if (request.method === 'GET' && action === 'stream') {
      let afterSeq = Number(url.searchParams.get('afterSeq') ?? '-1')
      if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw new HttpError(400, 'afterSeq must be an integer at least -1')
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const timer = setInterval(() => {
        void events(auth.tenantId, sessionId, afterSeq).then((batch) => {
          for (const event of batch as Array<{ seq: number }>) {
            afterSeq = event.seq
            response.write(`id: ${event.seq}\nevent: session-event\ndata: ${JSON.stringify(event)}\n\n`)
          }
        }).catch(() => { response.end() })
      }, 250)
      request.on('close', () => { clearInterval(timer) })
      return
    }
  }

  const commandMatch = /^\/v1\/commands\/([^/]+)$/.exec(url.pathname)
  if (request.method === 'GET' && commandMatch !== null) {
    const commandId = assertUuid(commandMatch[1] ?? '', 'command id')
    const row = await one<CommandRow>(
      `SELECT c.* FROM agent_commands c JOIN sessions s ON s.tenant_id = c.tenant_id AND s.id = c.session_id
       WHERE c.tenant_id = $1 AND c.id = $2 AND s.owner_user_id = $3`,
      [auth.tenantId, commandId, auth.userId],
    )
    if (row === undefined) throw new HttpError(404, 'command not found')
    send(response, 200, commandView(row))
    return
  }

  throw new HttpError(404, 'route not found')
}

function websocketFrame(socket: WebSocketConnection, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocketRuntime.OPEN) return
  socket.send(JSON.stringify({
    type: 'server-request',
    rpcId: randomUUID(),
    method: payload['type'],
    payload,
  }))
}

function attachWebSockets(server: Server): WebSocketServerInstance {
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/api/events.mux' && url.pathname !== '/api/events.host') {
      socket.destroy()
      return
    }
    void authenticate(request).then((auth) => {
      sockets.handleUpgrade(request, socket, head, (websocket) => {
      sockets.emit('connection', websocket, request)
      if (url.pathname === '/api/events.mux') {
        const cursors = new Map<string, number>()
        let polling = false
        const poll = async (): Promise<void> => {
          if (polling || websocket.readyState !== WebSocketRuntime.OPEN) return
          polling = true
          try {
            const sessions = await rpcSessions(auth)
            for (const session of sessions) {
              if (!cursors.has(session.id)) {
                const lastSeq = session.last_seq === null ? -1 : Number(session.last_seq)
                cursors.set(session.id, lastSeq)
                websocketFrame(websocket, {
                  type: 'session/subscribed',
                  sessionId: session.id,
                  lastSeq,
                })
                continue
              }
              const afterSeq = cursors.get(session.id) as number
              const batch = await events(auth.tenantId, session.id, afterSeq) as Array<Record<string, unknown>>
              for (const event of batch) {
                if (typeof event['seq'] === 'number') cursors.set(session.id, event['seq'])
                websocketFrame(websocket, { type: 'session/event', sessionId: session.id, event })
              }
            }
          } catch (error) {
            console.error('mux WebSocket poll failed', error)
            websocket.close()
          } finally {
            polling = false
          }
        }
        void poll()
        const timer = setInterval(() => void poll(), 250)
        websocket.once('close', () => { clearInterval(timer) })
      } else {
        const known = new Map<string, string>()
        const knownWorkspaces = new Map<string, string>()
        let knownArchived = ''
        let polling = false
        const poll = async (): Promise<void> => {
          if (polling || websocket.readyState !== WebSocketRuntime.OPEN) return
          polling = true
          try {
            const sessions = await rpcSessions(auth)
            const current = new Set(sessions.map(session => session.id))
            for (const session of sessions) {
              const status = session.status
              const previous = known.get(session.id)
              if (previous === undefined) {
                known.set(session.id, status)
                websocketFrame(websocket, {
                  type: 'host/session-added',
                  sessionId: session.id,
                  blank: Number(session.event_count) === 0,
                  ...(session.cwd === null ? {} : { cwd: session.cwd }),
                })
              } else if (previous !== status) {
                known.set(session.id, status)
                websocketFrame(websocket, {
                  type: 'host/session-status',
                  sessionId: session.id,
                  running: status === 'running',
                })
                if (status === 'failed') {
                  websocketFrame(websocket, {
                    type: 'host/agent-error',
                    sessionId: session.id,
                    message: 'The distributed worker failed this turn.',
                  })
                }
              }
            }
            for (const sessionId of known.keys()) {
              if (current.has(sessionId)) continue
              known.delete(sessionId)
              websocketFrame(websocket, { type: 'host/session-removed', sessionId })
            }
            const workspaces = await workspaceRows(auth)
            const currentWorkspaces = new Set(workspaces.map(workspace => workspace.id))
            for (const workspace of workspaces) {
              const view = workspaceView(workspace)
              const signature = JSON.stringify(view)
              if (knownWorkspaces.get(workspace.id) !== signature) {
                knownWorkspaces.set(workspace.id, signature)
                websocketFrame(websocket, { type: 'host/workspace-changed', workspace: view })
              }
            }
            for (const workspaceId of knownWorkspaces.keys()) {
              if (currentWorkspaces.has(workspaceId)) continue
              knownWorkspaces.delete(workspaceId)
              websocketFrame(websocket, { type: 'host/workspace-removed', workspaceId })
            }
            const archived = sessions.filter(session => session.archived).map(session => session.id)
            const archivedSignature = JSON.stringify(archived)
            if (knownArchived !== archivedSignature) {
              knownArchived = archivedSignature
              websocketFrame(websocket, { type: 'host/archived-sessions-changed', archivedSessionIds: archived })
            }
          } catch (error) {
            console.error('host WebSocket poll failed', error)
            websocket.close()
          } finally {
            polling = false
          }
        }
        void poll()
        const timer = setInterval(() => void poll(), 500)
        websocket.once('close', () => { clearInterval(timer) })
      }
      })
    }).catch(() => {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
    })
  })
  return sockets
}

await migrate()
const redis = await connectRedis()
const server = createServer((request, response) => {
  void route(request, response, redis).catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : 500
    if (status === 500) console.error(error)
    if (!response.headersSent) send(response, status, { error: error instanceof Error ? error.message : String(error) })
    else response.end()
  })
})
const sockets = attachWebSockets(server)

const outboxTimer = setInterval(() => void pumpOutbox(redis).catch((error: unknown) => { console.error('outbox pump failed', error) }), config.outboxIntervalMs)
server.listen(config.apiPort, '0.0.0.0', () => { console.log(`${config.apiInstanceId} listening on ${config.apiPort}`) })

async function shutdown(): Promise<void> {
  clearInterval(outboxTimer)
  sockets.close()
  server.close()
  await redis.close()
  await pool.end()
}

process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
