import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Duplex } from 'node:stream'
import {
  copyAgentPreset,
  hasAgentPreset,
  listAgentPresets,
  readAgentPreset,
  removeAgentPreset,
} from './agent-presets.ts'
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
import { describeCredentials, setCredential, unsetCredential } from './credentials.ts'
import { migrate, one, pool, tx } from './db.ts'
import { assertUuid, HttpError, internalSessionId } from './identity.ts'
import { publicModelConfig, saveTenantModelConfig, tenantModelConfig, type ModelMode } from './model-config.ts'
import { connectRedis, type RedisClient } from './redis.ts'
import {
  describeSettings,
  settingValue,
  synchronizeModelSetting,
  writeSetting,
  type SettingsPathOperation,
} from './settings.ts'
import { workspaceCatalogFor } from './workspace-client.ts'
import { workspaceRootPath } from './workspace-path.ts'

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
  title: string | null
  agent_preset: string
  permission_preset: string
  parent_session_id: string | null
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

function providerDisplayName(provider: string): string {
  if (provider === 'deepseek-official') return 'DeepSeek'
  if (provider === 'openai-compatible') return 'OpenAI-compatible Chat Completions'
  return provider
}

function modelGroup(provider: string, model: string): Record<string, unknown> {
  return {
    id: provider,
    name: providerDisplayName(provider),
    models: [{ id: model, name: model }],
  }
}

function rpcSessionSummary(row: RpcSessionRow): Record<string, unknown> {
  return {
    sessionId: row.id,
    updatedAt: row.updated_at.getTime(),
    running: row.status === 'running',
    blank: Number(row.event_count) === 0,
    agentPreset: row.agent_preset,
    ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    ...(row.title === null ? {} : {
      projections: {
        asOfSeq: Number(row.last_seq ?? -1),
        values: { title: row.title },
      },
    }),
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
    `SELECT id, owner_user_id, workspace_id, provider, model, title, agent_preset,
       permission_preset, parent_session_id, status, created_at, updated_at
     FROM sessions WHERE tenant_id = $1 AND id = $2 AND owner_user_id = $3`,
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
    SELECT s.id, s.owner_user_id, s.workspace_id, s.provider, s.model, s.title, s.agent_preset,
      s.permission_preset, s.parent_session_id, s.status, s.created_at, s.updated_at,
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
  agentPreset = 'standard',
  permissionPreset = 'danger-full-access',
  parentSessionId?: string,
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
    const createdAt = Date.now()
    const header = {
      version: 0,
      id: internalSessionId(auth.tenantId, id),
      createdAt,
      cwd: workspaceRootPath(auth.tenantId, workspaceId),
      agentPreset,
      ...(parentSessionId === undefined ? {} : { parentSession: internalSessionId(auth.tenantId, parentSessionId) }),
    }
    await client.query(
      `INSERT INTO sessions
         (tenant_id, id, owner_user_id, workspace_id, workspace_order, provider, model,
          agent_preset, permission_preset, parent_session_id, header)
       VALUES ($1, $2, $3, $4, -floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
         $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [
        auth.tenantId,
        id,
        auth.userId,
        workspaceId,
        provider,
        model,
        agentPreset,
        permissionPreset,
        parentSessionId ?? null,
        JSON.stringify(header),
      ],
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

function settingsRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function assertAdministrator(auth: Identity): void {
  if (auth.role !== 'admin') throw new HttpError(403, 'tenant administrator role required')
}

async function defaultPreset(tenantId: string, modelConfig: Awaited<ReturnType<typeof tenantModelConfig>>): Promise<string> {
  const settings = settingsRecord(await settingValue(tenantId, modelConfig, 'agent-presets'))
  return typeof settings['default'] === 'string' ? settings['default'] : 'standard'
}

async function defaultPermission(tenantId: string, modelConfig: Awaited<ReturnType<typeof tenantModelConfig>>): Promise<string> {
  const settings = settingsRecord(await settingValue(tenantId, modelConfig, 'permission'))
  return typeof settings['defaultPreset'] === 'string' ? settings['defaultPreset'] : 'danger-full-access'
}

async function appendSessionEvent(
  tenantId: string,
  sessionId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<number> {
  return tx(async (client) => {
    const locked = await client.query<{
      id: string
      header: Record<string, unknown> | null
      workspace_id: string
      agent_preset: string
      parent_session_id: string | null
      status: string
      created_at: Date
    }>(`
      SELECT id, header, workspace_id, agent_preset, parent_session_id, status, created_at
      FROM sessions WHERE tenant_id = $1 AND id = $2 FOR UPDATE
    `, [tenantId, sessionId])
    if (locked.rowCount === 0) throw new HttpError(404, 'session not found')
    const session = locked.rows[0]
    if (session?.status === 'running') {
      throw new HttpError(409, 'session is running; retry the operation after the current turn finishes')
    }
    if (session?.header === null) {
      const header = {
        version: 0,
        id: internalSessionId(tenantId, sessionId),
        createdAt: session.created_at.getTime(),
        cwd: workspaceRootPath(tenantId, session.workspace_id),
        agentPreset: session.agent_preset,
        ...(session.parent_session_id === null
          ? {}
          : { parentSession: internalSessionId(tenantId, session.parent_session_id) }),
      }
      await client.query(
        'UPDATE sessions SET header = $3::jsonb WHERE tenant_id = $1 AND id = $2',
        [tenantId, sessionId, JSON.stringify(header)],
      )
    }
    const latest = await client.query<{ seq: string | null }>(
      'SELECT max(seq)::text AS seq FROM session_events WHERE tenant_id = $1 AND session_id = $2',
      [tenantId, sessionId],
    )
    const seq = Number(latest.rows[0]?.seq ?? -1) + 1
    const event = { type, seq, time: Date.now(), data }
    await client.query(
      'INSERT INTO session_events (tenant_id, session_id, seq, event) VALUES ($1, $2, $3, $4::jsonb)',
      [tenantId, sessionId, seq, JSON.stringify(event)],
    )
    await client.query(
      'UPDATE sessions SET revision = revision + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2',
      [tenantId, sessionId],
    )
    return seq
  })
}

function normalizedTitle(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'title is required')
  const title = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (title.length === 0) throw new HttpError(400, 'session title must contain visible characters')
  return Array.from(title).slice(0, 80).join('')
}

async function sessionProjections(tenantId: string, sessionId: string): Promise<Record<string, unknown>> {
  const [session, latest, goal, plan] = await Promise.all([
    one<{ title: string | null; permission_preset: string }>(
      'SELECT title, permission_preset FROM sessions WHERE tenant_id = $1 AND id = $2',
      [tenantId, sessionId],
    ),
    one<{ seq: string | null }>(
      'SELECT max(seq)::text AS seq FROM session_events WHERE tenant_id = $1 AND session_id = $2',
      [tenantId, sessionId],
    ),
    one<{ id: string; revision: number; objective: string; max_rounds: number | null; phase: string; created_at: Date; updated_at: Date }>(
      'SELECT id, revision, objective, max_rounds, phase, created_at, updated_at FROM session_goals WHERE tenant_id = $1 AND session_id = $2',
      [tenantId, sessionId],
    ),
    one<{ active: boolean }>(`
      SELECT (event->'data'->>'active')::boolean AS active FROM session_events
      WHERE tenant_id = $1 AND session_id = $2 AND event->>'type' = 'plan/mode'
      ORDER BY seq DESC LIMIT 1
    `, [tenantId, sessionId]),
  ])
  const values: Record<string, unknown> = {}
  if (session?.title !== null && session?.title !== undefined) values['title'] = session.title
  if (session !== undefined) {
    values['permissions'] = {
      options: [
        { value: 'read-only', name: 'Read only' },
        { value: 'workspace-write', name: 'Workspace write' },
        { value: 'danger-full-access', name: 'Full access' },
      ],
      currentValue: session.permission_preset,
    }
  }
  values['plan'] = { active: plan?.active ?? false, pending: false }
  if (goal !== undefined) {
    values['goal'] = {
      goal: {
        id: goal.id,
        revision: goal.revision,
        objective: goal.objective,
        maxGoalRounds: goal.max_rounds ?? 64,
        phase: goal.phase,
      },
      roundsStarted: 0,
      createdAt: goal.created_at.getTime(),
      updatedAt: goal.updated_at.getTime(),
    }
  } else values['goal'] = null
  return { asOfSeq: Number(latest?.seq ?? -1), values }
}

interface GoalRow {
  id: string
  revision: number
  objective: string
  max_rounds: number | null
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  created_at: Date
  updated_at: Date
}

interface FeedbackRow {
  message_id: string
  rating: 'positive' | 'negative'
  note: string | null
  version: string
  created_at: Date
  updated_at: Date
}

function feedbackView(row: FeedbackRow): Record<string, unknown> {
  return {
    messageId: row.message_id,
    rating: row.rating,
    ...(row.note === null ? {} : { note: row.note }),
    version: row.version,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  }
}

function goalView(row: GoalRow): Record<string, unknown> {
  return {
    id: row.id,
    revision: row.revision,
    objective: row.objective,
    phase: row.phase,
    maxGoalRounds: row.max_rounds ?? 64,
    roundsStarted: 0,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    activation: row.phase === 'active' ? 'armed' : 'disarmed',
  }
}

async function currentGoal(tenantId: string, sessionId: string): Promise<GoalRow | undefined> {
  return one<GoalRow>(`
    SELECT id, revision, objective, max_rounds, phase, created_at, updated_at
    FROM session_goals WHERE tenant_id = $1 AND session_id = $2
  `, [tenantId, sessionId])
}

async function appendGoalChange(
  tenantId: string,
  sessionId: string,
  operation: 'create' | 'edit' | 'pause' | 'resume' | 'complete',
  row: GoalRow,
): Promise<number> {
  const view = goalView(row)
  return appendSessionEvent(tenantId, sessionId, 'goal/change', {
    kind: 'goal/change',
    version: 1,
    operation,
    goal: {
      id: view['id'],
      revision: view['revision'],
      objective: view['objective'],
      phase: view['phase'],
      maxGoalRounds: view['maxGoalRounds'],
    },
    roundsStarted: 0,
    createdAt: view['createdAt'],
    updatedAt: view['updatedAt'],
  })
}

async function requireGoalRef(tenantId: string, sessionId: string, value: unknown): Promise<GoalRow> {
  const ref = settingsRecord(value)
  const row = await currentGoal(tenantId, sessionId)
  if (row === undefined) throw new HttpError(404, 'no current goal')
  if (ref['id'] !== row.id || ref['revision'] !== row.revision) throw new HttpError(409, 'goal revision is stale')
  return row
}

async function handleRpc(
  redis: RedisClient,
  auth: Identity,
  request: RpcRequestEnvelope,
): Promise<Record<string, unknown>> {
  const payload = request.payload
  const remoteArgs = settingsRecord(payload['args'])
  const modelConfig = await tenantModelConfig(auth.tenantId)
  const sessionIdValue = payload['sessionId']
  const sessionId = typeof sessionIdValue === 'string' ? assertUuid(sessionIdValue, 'sessionId') : undefined
  try {
    switch (request.method) {
      case 'session.list':
        return rpcSuccess(request.rpcId, { items: (await rpcSessions(auth)).map(rpcSessionSummary) })
      case 'session.search': {
        const query = typeof payload['query'] === 'string' ? payload['query'].trim() : ''
        if (query === '') return rpcSuccess(request.rpcId, { items: [], hasMore: false })
        const result = await pool.query<{ id: string; snippet: string }>(`
          SELECT s.id,
            left(coalesce(s.title, match.content, ''), 320) AS snippet
          FROM sessions s
          LEFT JOIN LATERAL (
            SELECT e.event::text AS content
            FROM session_events e
            WHERE e.tenant_id = s.tenant_id AND e.session_id = s.id
              AND e.event::text ILIKE '%' || $3 || '%'
            ORDER BY e.seq DESC LIMIT 1
          ) match ON true
          WHERE s.tenant_id = $1 AND s.owner_user_id = $2 AND s.archived = false
            AND (s.title ILIKE '%' || $3 || '%' OR match.content IS NOT NULL)
          ORDER BY s.updated_at DESC LIMIT 21
        `, [auth.tenantId, auth.userId, query])
        return rpcSuccess(request.rpcId, {
          items: result.rows.slice(0, 20).map(row => ({ sessionId: row.id, snippet: row.snippet })),
          hasMore: result.rows.length > 20,
        })
      }
      case 'session.create': {
        const requestedId = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined
        const requestedWorkspaceId = typeof payload['workspaceId'] === 'string' ? payload['workspaceId'] : undefined
        const requestedPreset = payload['agentPreset'] ?? await defaultPreset(auth.tenantId, modelConfig)
        const agentPreset = await hasAgentPreset(auth.tenantId, requestedPreset)
        const permissionPreset = await defaultPermission(auth.tenantId, modelConfig)
        const row = await createSession(
          auth,
          modelConfig.provider,
          modelConfig.defaultModel,
          requestedId,
          requestedWorkspaceId,
          agentPreset,
          permissionPreset,
        )
        return rpcSuccess(request.rpcId, { sessionId: row.id, agentPreset: row.agent_preset })
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
        const value: Record<string, unknown> = {
          events: result.rows.map(row => ({ event: row.event })),
          hasMore: false,
        }
        if (beforeSeq === undefined) value['projections'] = await sessionProjections(auth.tenantId, sessionId)
        return rpcSuccess(request.rpcId, value)
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
      case 'session.rename': {
        if (sessionId === undefined) throw new HttpError(400, 'sessionId is required')
        await ownedSession(auth.tenantId, auth.userId, sessionId)
        const title = normalizedTitle(payload['title'])
        const seq = await appendSessionEvent(auth.tenantId, sessionId, 'session/title', {
          title,
          messageSeqs: [],
          source: { kind: 'user' },
        })
        await pool.query('UPDATE sessions SET title = $3 WHERE tenant_id = $1 AND id = $2', [auth.tenantId, sessionId, title])
        return rpcSuccess(request.rpcId, { title, seq })
      }
      case 'session.fork': {
        if (sessionId === undefined) throw new HttpError(400, 'sessionId is required')
        const source = await ownedSession(auth.tenantId, auth.userId, sessionId)
        const atSeq = typeof payload['atSeq'] === 'number' ? payload['atSeq'] : -1
        const boundary = await one<{ seq: string }>(`
          SELECT seq::text FROM session_events
          WHERE tenant_id = $1 AND session_id = $2 AND event->>'type' = 'turn/end'
            AND ($3::bigint < 0 OR seq >= $3)
          ORDER BY CASE WHEN $3::bigint < 0 THEN seq END DESC,
            CASE WHEN $3::bigint >= 0 THEN seq END ASC
          LIMIT 1
        `, [auth.tenantId, sessionId, atSeq])
        if (boundary === undefined) throw new HttpError(409, 'the source has no completed turn to fork')
        const child = await createSession(
          auth,
          source.provider,
          source.model,
          undefined,
          source.workspace_id ?? undefined,
          source.agent_preset,
          source.permission_preset,
          source.id,
        )
        await tx(async (client) => {
          const sourceHeader = await client.query<{ header: Record<string, unknown> | null }>(
            'SELECT header FROM sessions WHERE tenant_id = $1 AND id = $2 FOR SHARE',
            [auth.tenantId, source.id],
          )
          const header = sourceHeader.rows[0]?.header
          if (header !== null && header !== undefined) {
            const childHeader = {
              ...header,
              id: internalSessionId(auth.tenantId, child.id),
              parentSession: internalSessionId(auth.tenantId, source.id),
            }
            await client.query(
              'UPDATE sessions SET header = $3::jsonb, revision = revision + 1 WHERE tenant_id = $1 AND id = $2',
              [auth.tenantId, child.id, JSON.stringify(childHeader)],
            )
          }
          await client.query(`
            INSERT INTO session_events (tenant_id, session_id, seq, event, created_at)
            SELECT tenant_id, $3, seq, event, created_at FROM session_events
            WHERE tenant_id = $1 AND session_id = $2 AND seq <= $4
          `, [auth.tenantId, source.id, child.id, Number(boundary.seq)])
          await client.query('UPDATE sessions SET title = $3 WHERE tenant_id = $1 AND id = $2', [auth.tenantId, child.id, source.title])
        })
        return rpcSuccess(request.rpcId, { sessionId: child.id })
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
      case 'session.attachment': {
        if (sessionId === undefined) throw new HttpError(400, 'sessionId is required')
        await ownedSession(auth.tenantId, auth.userId, sessionId)
        const attachmentId = typeof payload['attachmentId'] === 'string' ? assertUuid(payload['attachmentId'], 'attachmentId') : undefined
        if (attachmentId === undefined) throw new HttpError(400, 'attachmentId is required')
        const attachment = await one<{ media_type: string; name: string | null; content: Buffer }>(
          'SELECT media_type, name, content FROM session_attachments WHERE tenant_id = $1 AND session_id = $2 AND id = $3',
          [auth.tenantId, sessionId, attachmentId],
        )
        if (attachment === undefined) throw new HttpError(404, 'attachment not found')
        return rpcSuccess(request.rpcId, {
          attachment: {
            id: attachmentId,
            mediaType: attachment.media_type,
            bytes: attachment.content.length,
            ...(attachment.name === null ? {} : { name: attachment.name }),
          },
          data: attachment.content.toString('base64'),
        })
      }
      case 'session.updateQueue': {
        if (sessionId === undefined) throw new HttpError(400, 'sessionId is required')
        await ownedSession(auth.tenantId, auth.userId, sessionId)
        const itemId = payload['itemId']
        const action = settingsRecord(payload['action'])
        if (typeof itemId !== 'string') throw new HttpError(400, 'itemId is required')
        if (action['kind'] === 'remove') {
          await pool.query(
            `UPDATE agent_commands SET status = 'cancelled', cancel_requested = true, completed_at = now()
             WHERE tenant_id = $1 AND session_id = $2 AND id = $3 AND status = 'queued'`,
            [auth.tenantId, sessionId, itemId],
          )
        } else if (action['kind'] === 'edit') {
          const content = Array.isArray(action['content']) ? action['content'] : []
          const text = content.flatMap(part => settingsRecord(part)['type'] === 'text' ? [settingsRecord(part)['text']] : [])
            .filter((part): part is string => typeof part === 'string').join('\n')
          await pool.query(
            `UPDATE agent_commands SET payload = jsonb_build_object('text', $4::text)
             WHERE tenant_id = $1 AND session_id = $2 AND id = $3 AND status = 'queued'`,
            [auth.tenantId, sessionId, itemId, text],
          )
        } else if (action['kind'] !== 'steer') {
          throw new HttpError(400, 'unsupported queue action')
        }
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
      case 'host.pickDirectory':
        return rpcSuccess(request.rpcId, { path: null })
      case 'host.listDirectory': {
        const rawPath = typeof payload['path'] === 'string' ? payload['path'] : '/workspace'
        const path = `/${rawPath.split('/').filter(Boolean).join('/')}`
        if (!path.startsWith('/workspace')) throw new HttpError(400, 'distributed directory browsing is limited to /workspace')
        const rows = await workspaceRows(auth)
        const childNames = new Set<string>()
        const prefix = path === '/' ? '/' : `${path}/`
        for (const row of rows) {
          if (!row.path.startsWith(prefix)) continue
          const child = row.path.slice(prefix.length).split('/')[0]
          if (child !== undefined && child !== '') childNames.add(child)
        }
        const segments = path.split('/').filter(Boolean)
        const crumbs = [{ name: '/', path: '/', hidden: false }]
        let cursor = ''
        for (const segment of segments) {
          cursor += `/${segment}`
          crumbs.push({ name: cursor === '/workspace' ? 'Workspace' : segment, path: cursor, hidden: false })
        }
        return rpcSuccess(request.rpcId, {
          path,
          home: '/workspace',
          crumbs,
          entries: [...childNames].sort().map(name => ({ name, path: `${path === '/' ? '' : path}/${name}`, hidden: name.startsWith('.') })),
          truncated: false,
        })
      }
      case 'host.createDirectory': {
        const parent = typeof payload['path'] === 'string' ? payload['path'] : ''
        const name = typeof payload['name'] === 'string' ? payload['name'].trim() : ''
        if (!parent.startsWith('/workspace') || name === '' || name.includes('/') || name === '.' || name === '..') {
          throw new HttpError(400, 'invalid workspace directory')
        }
        const path = `${parent.replace(/\/$/u, '')}/${name}`
        await pool.query(`
          INSERT INTO tenant_workspaces (tenant_id, id, path, title, sort_order)
          VALUES ($1, $2, $3, $4,
            coalesce((SELECT max(sort_order) + 1 FROM tenant_workspaces WHERE tenant_id = $1), 0))
        `, [auth.tenantId, randomUUID(), path, name])
        return rpcSuccess(request.rpcId, { path })
      }
      case 'host.openPath':
        throw new HttpError(409, 'this distributed deployment cannot open paths on the browser desktop')
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
        const beforeExists = beforeWorkspaceId === undefined || rows.some(row => row.id === beforeWorkspaceId)
        if (!rows.some(row => row.id === workspaceId) || !beforeExists) {
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
      case 'commands/list': {
        const targetId = typeof remoteArgs['agentId'] === 'string' ? assertUuid(remoteArgs['agentId'], 'agentId') : undefined
        if (targetId === undefined) throw new HttpError(400, 'agentId is required')
        await ownedSession(auth.tenantId, auth.userId, targetId)
        return rpcSuccess(request.rpcId, [
          { name: 'compact', description: 'Compact older conversation history' },
          { name: 'goal', description: 'Set or view the goal for a long-running task', input: { hint: '[<objective>|clear|edit <objective>|pause|resume]' } },
          { name: 'permission', description: 'Switch the permission preset', input: { hint: '<preset>' } },
          { name: 'plan', description: 'Enter or leave plan mode', input: { hint: '[off|message]' } },
        ])
      }
      case 'commands/execute': {
        const targetId = typeof remoteArgs['agentId'] === 'string' ? assertUuid(remoteArgs['agentId'], 'agentId') : undefined
        const line = typeof remoteArgs['line'] === 'string' ? remoteArgs['line'] : ''
        if (targetId === undefined) throw new HttpError(400, 'agentId is required')
        const session = await ownedSession(auth.tenantId, auth.userId, targetId)
        const match = /^\/([a-z][a-z0-9-]*)([\s\S]*)$/u.exec(line.trim())
        if (match === null) return rpcSuccess(request.rpcId, undefined)
        const name = match[1] as string
        const args = (match[2] ?? '').trim()
        if (!['compact', 'goal', 'permission', 'plan'].includes(name)) return rpcSuccess(request.rpcId, undefined)
        const commandId = `cmd-${randomUUID()}`
        await appendSessionEvent(auth.tenantId, targetId, 'command/run', {
          commandId, name, args, source: { kind: 'user' },
        })
        let result: { kind: 'success' | 'error'; text?: string; sourceEventSeq?: number }
        try {
          if (name === 'plan') {
            const active = args !== 'off'
            const sourceEventSeq = await appendSessionEvent(auth.tenantId, targetId, 'plan/mode', { active })
            result = {
              kind: 'success',
              text: active ? 'Plan mode on. Use /plan off to leave.' : 'Plan mode off.',
              sourceEventSeq,
            }
          } else if (name === 'permission') {
            const allowed = ['read-only', 'workspace-write', 'danger-full-access']
            if (args === '') {
              result = { kind: 'success', text: `current preset ${session.permission_preset} (available: ${allowed.join(', ')})` }
            } else if (!allowed.includes(args)) {
              result = { kind: 'error', text: `unknown preset "${args}" (available: ${allowed.join(', ')})` }
            } else {
              await pool.query(
                'UPDATE sessions SET permission_preset = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2',
                [auth.tenantId, targetId, args],
              )
              const sourceEventSeq = await appendSessionEvent(auth.tenantId, targetId, 'permission/preset', { preset: args })
              await appendSessionEvent(auth.tenantId, targetId, 'sandbox/mode', { mode: args })
              await appendSessionEvent(auth.tenantId, targetId, 'approval/policy', { policy: args === 'danger-full-access' ? 'never' : 'ask' })
              result = { kind: 'success', text: `preset ${args}`, sourceEventSeq }
            }
          } else if (name === 'goal') {
            const existing = await currentGoal(auth.tenantId, targetId)
            if (args === '') {
              result = { kind: 'success', text: existing === undefined ? 'No goal is set.' : `${existing.phase}: ${existing.objective}` }
            } else if (args === 'clear') {
              if (existing !== undefined) {
                await pool.query('DELETE FROM session_goals WHERE tenant_id = $1 AND session_id = $2', [auth.tenantId, targetId])
                await appendSessionEvent(auth.tenantId, targetId, 'goal/change', { kind: 'goal/change', version: 1, operation: 'clear' })
              }
              result = { kind: 'success', text: existing === undefined ? 'No goal to clear.' : 'Goal cleared.' }
            } else if (args === 'pause' || args === 'resume') {
              if (existing === undefined) {
                result = { kind: 'error', text: `No goal to ${args}.` }
              } else {
                const phase = args === 'pause' ? 'paused' : 'active'
                const updated = await one<GoalRow>(`
                  UPDATE session_goals SET phase = $3, revision = revision + 1, updated_at = now()
                  WHERE tenant_id = $1 AND session_id = $2
                  RETURNING id, revision, objective, max_rounds, phase, created_at, updated_at
                `, [auth.tenantId, targetId, phase])
                const sourceEventSeq = await appendGoalChange(auth.tenantId, targetId, args, updated as GoalRow)
                result = { kind: 'success', text: `Goal ${args === 'pause' ? 'paused' : 'resumed'}.`, sourceEventSeq }
              }
            } else {
              const objective = args.startsWith('edit ') ? args.slice(5).trim() : args
              if (objective === '') {
                result = { kind: 'error', text: 'Goal objective is required.' }
              } else if (existing === undefined || existing.phase === 'complete') {
                const created = await one<GoalRow>(`
                  INSERT INTO session_goals (tenant_id, session_id, id, objective, max_rounds)
                  VALUES ($1, $2, $3, $4, 64)
                  ON CONFLICT (tenant_id, session_id) DO UPDATE SET
                    id = EXCLUDED.id, objective = EXCLUDED.objective, max_rounds = EXCLUDED.max_rounds,
                    phase = 'active', revision = session_goals.revision + 1, updated_at = now()
                  RETURNING id, revision, objective, max_rounds, phase, created_at, updated_at
                `, [auth.tenantId, targetId, randomUUID(), objective])
                const sourceEventSeq = await appendGoalChange(auth.tenantId, targetId, 'create', created as GoalRow)
                result = { kind: 'success', text: 'Goal created.', sourceEventSeq }
              } else {
                const updated = await one<GoalRow>(`
                  UPDATE session_goals SET objective = $3, revision = revision + 1, updated_at = now()
                  WHERE tenant_id = $1 AND session_id = $2
                  RETURNING id, revision, objective, max_rounds, phase, created_at, updated_at
                `, [auth.tenantId, targetId, objective])
                const sourceEventSeq = await appendGoalChange(auth.tenantId, targetId, 'edit', updated as GoalRow)
                result = { kind: 'success', text: 'Goal updated.', sourceEventSeq }
              }
            }
          } else {
            const compactId = randomUUID()
            await pool.query(`
              INSERT INTO agent_commands (tenant_id, id, session_id, user_id, kind, payload)
              VALUES ($1, $2, $3, $4, 'message', $5::jsonb)
            `, [auth.tenantId, compactId, targetId, auth.userId, JSON.stringify({ action: 'compact' })])
            await pumpOutbox(redis)
            let settled: CommandRow | undefined
            const deadline = Date.now() + 120_000
            while (Date.now() < deadline) {
              settled = await one<CommandRow>(
                'SELECT * FROM agent_commands WHERE tenant_id = $1 AND id = $2',
                [auth.tenantId, compactId],
              )
              if (settled !== undefined && ['completed', 'failed', 'cancelled'].includes(settled.status)) break
              await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
            }
            if (settled?.status === 'completed') result = { kind: 'success', text: settled.final_text ?? 'Compaction completed.' }
            else if (settled === undefined || !['failed', 'cancelled'].includes(settled.status)) result = { kind: 'error', text: 'Compaction timed out.' }
            else {
              const message = settingsRecord(settled.error)['message']
              result = { kind: 'error', text: typeof message === 'string' ? message : 'Compaction failed.' }
            }
          }
        } catch (error) {
          result = { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
        await appendSessionEvent(auth.tenantId, targetId, 'command/done', { commandId, ...result })
        return rpcSuccess(request.rpcId, { commandId, result })
      }
      case 'goal.create':
      case 'goals/create': {
        const targetId = request.method === 'goals/create'
          ? typeof remoteArgs['agentId'] === 'string' ? assertUuid(remoteArgs['agentId'], 'agentId') : undefined
          : sessionId
        if (targetId === undefined) throw new HttpError(400, 'sessionId is required')
        await ownedSession(auth.tenantId, auth.userId, targetId)
        const source = request.method === 'goals/create' ? settingsRecord(remoteArgs['request']) : payload
        const objective = typeof source['objective'] === 'string' ? source['objective'].trim() : ''
        if (objective === '') throw new HttpError(400, 'goal objective is required')
        const maxRounds = typeof source['maxGoalRounds'] === 'number' ? source['maxGoalRounds'] : 64
        if (!Number.isSafeInteger(maxRounds) || maxRounds <= 0) throw new HttpError(400, 'maxGoalRounds must be positive')
        const id = randomUUID()
        const result = await pool.query<GoalRow>(`
          INSERT INTO session_goals (tenant_id, session_id, id, objective, max_rounds)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (tenant_id, session_id) DO NOTHING
          RETURNING id, revision, objective, max_rounds, phase, created_at, updated_at
        `, [auth.tenantId, targetId, id, objective, maxRounds])
        const goal = result.rows[0]
        if (goal === undefined) throw new HttpError(409, 'this session already has a goal')
        await appendGoalChange(auth.tenantId, targetId, 'create', goal)
        return rpcSuccess(request.rpcId, { ref: { id: goal.id, revision: goal.revision } })
      }
      case 'goal.edit':
      case 'goals/edit': {
        const targetId = request.method === 'goals/edit'
          ? typeof remoteArgs['agentId'] === 'string' ? assertUuid(remoteArgs['agentId'], 'agentId') : undefined
          : sessionId
        if (targetId === undefined) throw new HttpError(400, 'sessionId is required')
        await ownedSession(auth.tenantId, auth.userId, targetId)
        const previous = await requireGoalRef(auth.tenantId, targetId, request.method === 'goals/edit' ? remoteArgs['ref'] : payload['ref'])
        const update = request.method === 'goals/edit' ? settingsRecord(remoteArgs['request']) : payload
        const objective = typeof update['objective'] === 'string' ? update['objective'].trim() : previous.objective
        const maxRounds = typeof update['maxGoalRounds'] === 'number' ? update['maxGoalRounds'] : previous.max_rounds ?? 64
        if (objective === '' || !Number.isSafeInteger(maxRounds) || maxRounds <= 0) throw new HttpError(400, 'invalid goal edit')
        const result = await pool.query<GoalRow>(`
          UPDATE session_goals SET objective = $5, max_rounds = $6, revision = revision + 1, updated_at = now()
          WHERE tenant_id = $1 AND session_id = $2 AND id = $3 AND revision = $4
          RETURNING id, revision, objective, max_rounds, phase, created_at, updated_at
        `, [auth.tenantId, targetId, previous.id, previous.revision, objective, maxRounds])
        const goal = result.rows[0]
        if (goal === undefined) throw new HttpError(409, 'goal revision is stale')
        await appendGoalChange(auth.tenantId, targetId, 'edit', goal)
        return rpcSuccess(request.rpcId, request.method === 'goals/edit' ? goalView(goal) : { ref: { id: goal.id, revision: goal.revision } })
      }
      case 'goal.pause':
      case 'goal.resume':
      case 'goal.complete':
      case 'goals/pause':
      case 'goals/resume':
      case 'goals/complete': {
        const remote = request.method.startsWith('goals/')
        const targetId = remote
          ? typeof remoteArgs['agentId'] === 'string' ? assertUuid(remoteArgs['agentId'], 'agentId') : undefined
          : sessionId
        if (targetId === undefined) throw new HttpError(400, 'sessionId is required')
        await ownedSession(auth.tenantId, auth.userId, targetId)
        const previous = await requireGoalRef(auth.tenantId, targetId, remote ? remoteArgs['ref'] : payload['ref'])
        const operation = request.method.split(/[./]/u).at(-1) as 'pause' | 'resume' | 'complete'
        const phase = operation === 'pause' ? 'paused' : operation === 'resume' ? 'active' : 'complete'
        const result = await pool.query<GoalRow>(`
          UPDATE session_goals SET phase = $5, revision = revision + 1, updated_at = now()
          WHERE tenant_id = $1 AND session_id = $2 AND id = $3 AND revision = $4
          RETURNING id, revision, objective, max_rounds, phase, created_at, updated_at
        `, [auth.tenantId, targetId, previous.id, previous.revision, phase])
        const goal = result.rows[0]
        if (goal === undefined) throw new HttpError(409, 'goal revision is stale')
        await appendGoalChange(auth.tenantId, targetId, operation, goal)
        return rpcSuccess(request.rpcId, remote ? goalView(goal) : { ref: { id: goal.id, revision: goal.revision } })
      }
      case 'goal.clear':
      case 'goals/clear': {
        const remote = request.method === 'goals/clear'
        const targetId = remote
          ? typeof remoteArgs['agentId'] === 'string' ? assertUuid(remoteArgs['agentId'], 'agentId') : undefined
          : sessionId
        if (targetId === undefined) throw new HttpError(400, 'sessionId is required')
        await ownedSession(auth.tenantId, auth.userId, targetId)
        const previous = await requireGoalRef(auth.tenantId, targetId, remote ? remoteArgs['ref'] : payload['ref'])
        const deleted = await pool.query(
          'DELETE FROM session_goals WHERE tenant_id = $1 AND session_id = $2 AND id = $3 AND revision = $4',
          [auth.tenantId, targetId, previous.id, previous.revision],
        )
        if (deleted.rowCount !== 1) throw new HttpError(409, 'goal revision is stale')
        const cleared = { id: previous.id, revision: previous.revision + 1 }
        await appendSessionEvent(auth.tenantId, targetId, 'goal/change', {
          kind: 'goal/change', version: 1, operation: 'clear', cleared, clearedAt: Date.now(),
        })
        return rpcSuccess(request.rpcId, remote ? cleared : { cleared: true })
      }
      case 'skill.list': {
        if (sessionId === undefined) throw new HttpError(400, 'sessionId is required')
        const target = await ownedSession(auth.tenantId, auth.userId, sessionId)
        if (target.workspace_id === null) return rpcSuccess(request.rpcId, { skills: [] })
        const catalog = await workspaceCatalogFor(auth.tenantId, target.workspace_id)
        return rpcSuccess(request.rpcId, {
          skills: catalog.skills.map(skill => ({
            name: skill.name,
            description: skill.description,
            ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
            modelInvocable: skill.modelInvocable,
          })),
        })
      }
      case 'agentPreset.list': {
        const selected = await defaultPreset(auth.tenantId, modelConfig)
        return rpcSuccess(request.rpcId, {
          presets: await listAgentPresets(auth.tenantId, selected),
          authorable: auth.role === 'admin',
          hasDocument: false,
        })
      }
      case 'agentPreset.select': {
        if (sessionId === undefined) throw new HttpError(400, 'sessionId is required')
        const preset = await hasAgentPreset(auth.tenantId, payload['agentPreset'])
        const session = await ownedSession(auth.tenantId, auth.userId, sessionId)
        const count = await one<{ count: string }>(
          `SELECT count(*)::text AS count FROM session_events
           WHERE tenant_id = $1 AND session_id = $2 AND event->>'type' = 'turn/start'`,
          [auth.tenantId, sessionId],
        )
        if (Number(count?.count ?? 0) > 0) throw new HttpError(409, 'agent preset can only change before the first turn')
        if (session.status === 'running') throw new HttpError(409, 'agent preset cannot change while the session is running')
        await pool.query('UPDATE sessions SET agent_preset = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2', [auth.tenantId, sessionId, preset])
        return rpcSuccess(request.rpcId, { agentPreset: preset })
      }
      case 'agentPreset.read': {
        assertAdministrator(auth)
        return rpcSuccess(request.rpcId, await readAgentPreset(auth.tenantId, payload['agentPreset']))
      }
      case 'agentPreset.copy': {
        assertAdministrator(auth)
        return rpcSuccess(request.rpcId, {
          agentPreset: await copyAgentPreset(
            auth.tenantId,
            auth.userId,
            payload['from'],
            payload['agentPreset'],
            payload['name'],
          ),
        })
      }
      case 'agentPreset.openDocument': {
        assertAdministrator(auth)
        const preset = await readAgentPreset(auth.tenantId, payload['agentPreset'])
        return rpcSuccess(request.rpcId, {
          opened: false,
          path: preset.trust === 'system'
            ? `apps/cli/config/agent-presets/${preset.agentPreset}`
            : `postgres://tenant-agent-presets/${preset.agentPreset}`,
        })
      }
      case 'agentPreset.remove': {
        assertAdministrator(auth)
        await removeAgentPreset(auth.tenantId, payload['agentPreset'])
        return rpcSuccess(request.rpcId, {})
      }
      case 'settings.describe':
        return rpcSuccess(request.rpcId, {
          writable: auth.role === 'admin',
          hasDocument: false,
          namespaces: await describeSettings(auth.tenantId, modelConfig),
        })
      case 'settings.openDocument':
        throw new HttpError(409, 'settings are stored in PostgreSQL and have no local document')
      case 'settings.update':
      case 'settings.replace':
      case 'settings.mutate': {
        assertAdministrator(auth)
        const namespace = typeof payload['ns'] === 'string' ? payload['ns'] : ''
        const expectedRevision = typeof payload['expectedRevision'] === 'number' ? payload['expectedRevision'] : undefined
        const written = request.method === 'settings.update'
          ? await writeSetting(auth.tenantId, auth.userId, modelConfig, namespace, {
            kind: 'update', patch: settingsRecord(payload['patch']),
          }, expectedRevision)
          : request.method === 'settings.replace'
            ? await writeSetting(auth.tenantId, auth.userId, modelConfig, namespace, {
              kind: 'replace', section: settingsRecord(payload['section']),
            }, expectedRevision)
            : await writeSetting(auth.tenantId, auth.userId, modelConfig, namespace, {
              kind: 'mutate',
              operations: Array.isArray(payload['ops']) ? payload['ops'].map((operation) => {
                const value = settingsRecord(operation)
                return {
                  op: value['op'],
                  path: value['path'],
                  ...Object.hasOwn(value, 'value') ? { value: value['value'] } : {},
                } as SettingsPathOperation
              }) : [],
            }, expectedRevision)
        if (namespace !== 'llm-deepseek' && namespace !== 'llm-pi-ai') {
          return rpcSuccess(request.rpcId, written)
        }
        const synchronized = await synchronizeModelSetting(auth.tenantId, auth.userId, modelConfig, namespace)
        const refreshed = (await describeSettings(auth.tenantId, synchronized))
          .find(candidate => candidate['ns'] === namespace)
        return rpcSuccess(request.rpcId, refreshed ?? written)
      }
      case 'credentials.describe': {
        const refs = Array.isArray(payload['refs']) ? payload['refs'] : []
        return rpcSuccess(request.rpcId, {
          credentials: await describeCredentials(auth.tenantId, modelConfig, refs),
        })
      }
      case 'credentials.set': {
        assertAdministrator(auth)
        await setCredential(auth.tenantId, auth.userId, modelConfig, payload['ref'], payload['value'])
        return rpcSuccess(request.rpcId, {})
      }
      case 'credentials.unset': {
        assertAdministrator(auth)
        await unsetCredential(auth.tenantId, auth.userId, modelConfig, payload['ref'])
        return rpcSuccess(request.rpcId, {})
      }
      case 'llm.providers':
        return rpcSuccess(request.rpcId, {
          providers: [
            {
              provider: 'deepseek-official',
              displayName: 'DeepSeek',
              settingsNs: 'llm-deepseek',
              settingsPath: [],
              active: modelConfig.mode === 'deepseek',
            },
            {
              provider: 'openai-compatible',
              displayName: 'OpenAI-compatible Chat Completions',
              settingsNs: 'llm-pi-ai',
              settingsPath: ['providers', 'openai-compatible'],
              active: modelConfig.mode === 'openai',
              declared: true,
            },
          ],
        })
      case 'llm.models':
        return rpcSuccess(request.rpcId, {
          groups: [modelGroup(modelConfig.provider, modelConfig.defaultModel)],
          failures: [],
        })
      case 'llm.discoverModels': {
        assertAdministrator(auth)
        const raw = typeof payload['baseURL'] === 'string' && payload['baseURL'].trim() !== ''
          ? payload['baseURL'].trim()
          : modelConfig.baseUrl
        if (raw === null) throw new HttpError(400, 'baseURL is required')
        let endpoint: URL
        try {
          endpoint = new URL(raw)
        } catch {
          throw new HttpError(400, 'baseURL must be a valid URL')
        }
        if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
          throw new HttpError(400, 'baseURL must use http or https')
        }
        endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/models`
        const draftKey = typeof payload['apiKey'] === 'string' && payload['apiKey'].trim() !== ''
          ? payload['apiKey'].trim()
          : modelConfig.apiKey
        const response = await fetch(endpoint, {
          headers: draftKey === null ? {} : { authorization: `Bearer ${draftKey}` },
          signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) throw new HttpError(502, `model discovery returned HTTP ${response.status}`)
        const document: unknown = await response.json()
        const root = settingsRecord(document)
        const rows = Array.isArray(root['data']) ? root['data'] : Array.isArray(document) ? document : []
        const models = rows.flatMap((candidate) => {
          const item = settingsRecord(candidate)
          const id = item['id']
          if (typeof id !== 'string' || id.trim() === '') return []
          return [{ id: id.trim(), ...(typeof item['name'] === 'string' ? { name: item['name'] } : {}) }]
        })
        return rpcSuccess(request.rpcId, { models })
      }
      case 'pluginInventory/list':
        return rpcSuccess(request.rpcId, {
          entries: [
            ['api-gateway', '@deepseek-ai/dsh-distributed/api'],
            ['postgres-session-persistence', '@deepseek-ai/dsh-distributed/postgres-persistence'],
            ['redis-command-transport', '@deepseek-ai/dsh-distributed/redis'],
            ['workspace-proxy', '@deepseek-ai/dsh-distributed/workspace-service'],
            ['agent-loop', '@deepseek-ai/dsh-agent-loop'],
            ['llm-deepseek', '@deepseek-ai/dsh-llm-deepseek'],
            ['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai'],
            ['session-checkpoint-policy', '@deepseek-ai/dsh-session-checkpoint-policy'],
            ['system-prompt', '@deepseek-ai/dsh-system-prompt'],
            ['tools', '@deepseek-ai/dsh-tools'],
          ].map(([entryId, moduleName]) => ({ entryId, moduleName, enabled: true, fiberPhase: 'active' })),
        })
      case 'dynamicCordisRunner/syncInspectManifest':
        // The distributed runtime does not execute dynamic Cordis packages yet,
        // but the complete upstream client still publishes its read-only inspect
        // provider directory during boot. Accepting the snapshot keeps that
        // compatibility handshake quiet without claiming execution support.
        return rpcSuccess(request.rpcId, null)
      case 'dynamicCordisRunner/inventory':
        // No distributed owner exists for dynamic package definitions. An empty
        // successful inventory lets the upstream panel render its honest empty
        // state; mutating runner methods continue to fail explicitly below.
        return rpcSuccess(request.rpcId, [])
      case 'messageFeedback/list':
      case 'messageFeedback/put':
      case 'messageFeedback/delete': {
        const source = settingsRecord(remoteArgs['request'])
        const targetId = typeof source['sessionId'] === 'string' ? assertUuid(source['sessionId'], 'sessionId') : undefined
        if (targetId === undefined) throw new HttpError(400, 'sessionId is required')
        await ownedSession(auth.tenantId, auth.userId, targetId)
        if (request.method === 'messageFeedback/list') {
          const rows = await pool.query<FeedbackRow>(`
            SELECT message_id, rating, note, version::text, created_at, updated_at
            FROM session_message_feedback WHERE tenant_id = $1 AND session_id = $2 ORDER BY created_at
          `, [auth.tenantId, targetId])
          return rpcSuccess(request.rpcId, { ok: true, value: { items: rows.rows.map(feedbackView) } })
        }
        const messageId = typeof source['messageId'] === 'string' && source['messageId'] !== '' ? source['messageId'] : undefined
        if (messageId === undefined) throw new HttpError(400, 'messageId is required')
        const existing = await one<FeedbackRow>(`
          SELECT message_id, rating, note, version::text, created_at, updated_at
          FROM session_message_feedback WHERE tenant_id = $1 AND session_id = $2 AND message_id = $3
        `, [auth.tenantId, targetId, messageId])
        if (request.method === 'messageFeedback/delete') {
          if (existing === undefined) return rpcSuccess(request.rpcId, { ok: true, value: { absent: true } })
          if (source['ifVersion'] !== existing.version) {
            return rpcSuccess(request.rpcId, { ok: false, error: { code: 'version-conflict', current: feedbackView(existing) } })
          }
          await pool.query(
            'DELETE FROM session_message_feedback WHERE tenant_id = $1 AND session_id = $2 AND message_id = $3 AND version = $4',
            [auth.tenantId, targetId, messageId, existing.version],
          )
          return rpcSuccess(request.rpcId, { ok: true, value: { absent: true } })
        }
        const rating = source['rating']
        if (rating !== 'positive' && rating !== 'negative') throw new HttpError(400, 'rating must be positive or negative')
        const note = typeof source['note'] === 'string' ? source['note'] : undefined
        if (note !== undefined && note.trim() === '') {
          return rpcSuccess(request.rpcId, { ok: false, error: { code: 'note-blank' } })
        }
        if (note !== undefined && Buffer.byteLength(note) > 16_384) {
          return rpcSuccess(request.rpcId, {
            ok: false,
            error: { code: 'note-too-large', maxBytes: 16_384, actualBytes: Buffer.byteLength(note) },
          })
        }
        if (source['ifVersion'] !== (existing?.version ?? null)) {
          return rpcSuccess(request.rpcId, {
            ok: false,
            error: { code: 'version-conflict', current: existing === undefined ? null : feedbackView(existing) },
          })
        }
        const version = randomUUID()
        const updated = await one<FeedbackRow>(`
          INSERT INTO session_message_feedback
            (tenant_id, session_id, message_id, rating, note, version)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (tenant_id, session_id, message_id) DO UPDATE SET
            rating = EXCLUDED.rating, note = EXCLUDED.note, version = EXCLUDED.version, updated_at = now()
          RETURNING message_id, rating, note, version::text, created_at, updated_at
        `, [auth.tenantId, targetId, messageId, rating, note ?? null, version])
        return rpcSuccess(request.rpcId, { ok: true, value: feedbackView(updated as FeedbackRow) })
      }
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
  mode: ModelMode
  defaultModel: string
  baseUrl: string | null
  apiKey?: string
  clearApiKey: boolean
} {
  const mode = input['mode']
  if (mode !== 'mock' && mode !== 'deepseek' && mode !== 'openai') {
    throw new HttpError(400, 'mode must be mock, deepseek, or openai')
  }
  const defaultModel = requiredText(input, 'defaultModel', 1, 128)
  let baseUrl: string | null = null
  if (mode !== 'mock') {
    const raw = requiredText(input, 'baseUrl', 8, 2048)
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new HttpError(400, 'baseUrl must be a valid URL')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new HttpError(400, 'baseUrl must use http or https')
    parsed.pathname = parsed.pathname.replace(/\/chat\/completions\/?$/u, '') || '/'
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
  if (request.method === 'GET' && url.pathname === '/plugins/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(': distributed static client graph\n\n')
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': keepalive\n\n')
    }, 15_000)
    const cleanup = (): void => { clearInterval(heartbeat) }
    request.once('close', cleanup)
    response.once('close', cleanup)
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

async function emitProjectionForEvent(
  socket: WebSocketConnection,
  tenantId: string,
  sessionId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const seq = event['seq']
  const type = event['type']
  const data = settingsRecord(event['data'])
  if (typeof seq !== 'number' || typeof type !== 'string') return
  if (type === 'session/title' && typeof data['title'] === 'string') {
    websocketFrame(socket, { type: 'session/projection', sessionId, key: 'title', value: data['title'], seq })
    return
  }
  if (type === 'plan/mode') {
    websocketFrame(socket, {
      type: 'session/projection', sessionId, key: 'plan',
      value: { active: data['active'] === true, pending: false }, seq,
    })
    return
  }
  if (type !== 'permission/preset' && type !== 'goal/change') return
  const projections = settingsRecord(await sessionProjections(tenantId, sessionId))
  const values = settingsRecord(projections['values'])
  const key = type === 'permission/preset' ? 'permissions' : 'goal'
  websocketFrame(socket, { type: 'session/projection', sessionId, key, value: values[key] ?? null, seq })
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
                  await emitProjectionForEvent(websocket, auth.tenantId, session.id, event)
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
                    agentPreset: session.agent_preset,
                    ...(session.parent_session_id === null ? {} : { parentSessionId: session.parent_session_id }),
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
