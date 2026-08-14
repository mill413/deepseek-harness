import { randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-cordis-host-runner'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { materializeAgentPresets } from './agent-presets.ts'
import { config } from './config.ts'
import { resolveCredential } from './credentials.ts'
import { pool } from './db.ts'
import { registerDistributedInteractions } from './distributed-interactions.ts'
import { HttpError, assertUuid, internalSessionId, splitInternalSessionId } from './identity.ts'
import { tenantModelConfig } from './model-config.ts'
import { registerRuntimeModels } from './runtime-models.ts'
import { bootUpstreamRuntime } from './upstream-runtime.ts'
import { workspaceRootPath } from './workspace-path.ts'

const BODY_LIMIT = 2 * 1024 * 1024
const PATH_TOOLS = new Map<string, string>([
  ['read', 'file_path'],
  ['write', 'file_path'],
  ['edit', 'file_path'],
  ['glob', 'path'],
  ['grep', 'path'],
  ['str_replace_editor', 'path'],
])

interface WorkspaceContext {
  ctx: Context
  root: string
  userPresetRoot: string
  sessions: Map<string, Promise<AgentHandle>>
}

interface AgentCommandRequest {
  tenantId: string
  workspaceId: string
  sessionId: string
  provider: string
  model: string
  agentPreset: string
  permissionPreset: string
  payload: { text?: string; action?: 'compact' }
}

interface DynamicCordisRequest {
  tenantId: string
  method: string
  args: Record<string, unknown>
}

interface SubagentRequest {
  tenantId: string
  workspaceId: string
  operation: 'list' | 'prompt' | 'interrupt'
  args: Record<string, unknown>
}

interface ToolRequest {
  tenantId: string
  workspaceId: string
  callId: string
  name: string
  arguments: unknown
  permissionPreset: string
}

interface WorkspaceSkill {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  content: string
  directory: string
}

const contexts = new Map<string, Promise<WorkspaceContext>>()
const activeAgents = new Map<string, AgentHandle['agent']>()
const inspectManifests = new Map<string, readonly unknown[]>()
const invalidatedTenants = new Set<string>()

function json(response: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  })
  response.end(data)
}

function authorized(request: IncomingMessage): boolean {
  const expected = Buffer.from(`Bearer ${config.workspaceServiceToken}`)
  const supplied = Buffer.from(request.headers.authorization ?? '')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<unknown>) {
    const buffer = typeof chunk === 'string'
      ? Buffer.from(chunk)
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : undefined
    if (buffer === undefined) throw new HttpError(400, 'request body contains an invalid chunk')
    size += buffer.length
    if (size > BODY_LIMIT) throw new HttpError(413, 'request body is too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'request body must be valid JSON')
  }
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'request body must be an object')
  }
  return value as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `${key} must be a non-empty string`)
  return value
}

function parseToolRequest(value: unknown): ToolRequest {
  const body = requestRecord(value)
  return {
    tenantId: assertUuid(requiredString(body, 'tenantId'), 'tenantId'),
    workspaceId: assertUuid(requiredString(body, 'workspaceId'), 'workspaceId'),
    callId: requiredString(body, 'callId'),
    name: requiredString(body, 'name'),
    arguments: body['arguments'],
    permissionPreset: requiredString(body, 'permissionPreset'),
  }
}

function parseAgentCommand(value: unknown): AgentCommandRequest {
  const body = requestRecord(value)
  const payload = requestRecord(body['payload'])
  const action = payload['action']
  if (action !== undefined && action !== 'compact') throw new HttpError(400, 'payload.action must be compact')
  const text = payload['text']
  if (text !== undefined && typeof text !== 'string') throw new HttpError(400, 'payload.text must be a string')
  return {
    tenantId: assertUuid(requiredString(body, 'tenantId'), 'tenantId'),
    workspaceId: assertUuid(requiredString(body, 'workspaceId'), 'workspaceId'),
    sessionId: assertUuid(requiredString(body, 'sessionId'), 'sessionId'),
    provider: requiredString(body, 'provider'),
    model: requiredString(body, 'model'),
    agentPreset: requiredString(body, 'agentPreset'),
    permissionPreset: requiredString(body, 'permissionPreset'),
    payload: {
      ...(text === undefined ? {} : { text }),
      ...(action === undefined ? {} : { action }),
    },
  }
}

function parseDynamicCordisRequest(value: unknown): DynamicCordisRequest {
  const body = requestRecord(value)
  return {
    tenantId: assertUuid(requiredString(body, 'tenantId'), 'tenantId'),
    method: requiredString(body, 'method'),
    args: requestRecord(body['args']),
  }
}

function parseSubagentRequest(value: unknown): SubagentRequest {
  const body = requestRecord(value)
  const operation = requiredString(body, 'operation')
  if (operation !== 'list' && operation !== 'prompt' && operation !== 'interrupt') {
    throw new HttpError(400, 'unsupported subagent operation')
  }
  return {
    tenantId: assertUuid(requiredString(body, 'tenantId'), 'tenantId'),
    workspaceId: assertUuid(requiredString(body, 'workspaceId'), 'workspaceId'),
    operation,
    args: requestRecord(body['args']),
  }
}

function isContained(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** Resolve the deepest existing ancestor so a symlink cannot redirect a file tool outside its workspace. */
async function containedPath(root: string, supplied: string): Promise<string> {
  const target = resolve(root, supplied)
  if (!isContained(root, target)) throw new HttpError(400, 'tool path must stay inside the selected workspace')
  const missing: string[] = []
  let existing = target
  while (true) {
    try {
      const canonical = resolve(await realpath(existing), ...missing)
      if (!isContained(root, canonical)) throw new HttpError(400, 'tool path resolves outside the selected workspace')
      return target
    } catch (error) {
      if (error instanceof HttpError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      missing.unshift(basename(existing))
      existing = parent
    }
  }
}

async function normalizedArguments(root: string, name: string, value: unknown): Promise<unknown> {
  const source = requestRecord(value)
  const args = { ...source }
  const pathField = PATH_TOOLS.get(name)
  if (pathField !== undefined) {
    const supplied = args[pathField]
    if (supplied === undefined && (name === 'glob' || name === 'grep')) {
      args[pathField] = root
    } else if (typeof supplied === 'string' && supplied.length > 0) {
      args[pathField] = await containedPath(root, supplied)
    } else {
      throw new HttpError(400, `${pathField} must be a non-empty string`)
    }
  }
  if (name === 'bash') {
    const workdir = args['workdir']
    if (workdir !== undefined && (typeof workdir !== 'string' || workdir.length === 0)) {
      throw new HttpError(400, 'workdir must be a non-empty string')
    }
    args['workdir'] = await containedPath(root, typeof workdir === 'string' ? workdir : root)
  }
  return args
}

async function createWorkspaceContext(tenantId: string, workspaceId: string): Promise<WorkspaceContext> {
  const requestedRoot = workspaceRootPath(tenantId, workspaceId)
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
  const root = await realpath(requestedRoot)
  const stateRoot = resolve(config.workspaceRoot, '.runtime', tenantId, workspaceId)
  const userPresetRoot = resolve(stateRoot, 'agent-presets')
  let ctx: Context | undefined
  try {
    await materializeAgentPresets(tenantId, userPresetRoot)
    const [modelConfig, storedSearchKey] = await Promise.all([
      tenantModelConfig(tenantId),
      resolveCredential(tenantId, 'DEEPSEEK_API_KEY'),
    ])
    const deepSeekApiKey = storedSearchKey ?? (modelConfig.mode === 'deepseek' ? modelConfig.apiKey ?? undefined : undefined)
    ctx = await bootUpstreamRuntime({
      tenantId,
      workspaceId,
      root,
      stateRoot,
      userPresetRoot,
      ...(deepSeekApiKey === undefined ? {} : { deepSeekApiKey }),
    })
    await registerRuntimeModels(ctx, modelConfig)
    registerDistributedInteractions(ctx, tenantId)
    const inspectManifest = inspectManifests.get(tenantId)
    if (inspectManifest !== undefined) {
      ctx.dynamicCordisRunner.syncInspectManifest(inspectManifest as never)
    }
    return { ctx, root, userPresetRoot, sessions: new Map() }
  } catch (error) {
    await ctx?.fiber.dispose().catch((disposeError: unknown) => {
      console.error('failed workspace context cleanup', disposeError)
    })
    throw error
  }
}

function finalAssistantText(events: readonly SessionEvent[]): string {
  const event = events.findLast(candidate => candidate.type === 'assistant/message')
  if (event?.type !== 'assistant/message') return ''
  return event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

async function sessionHandle(workspace: WorkspaceContext, command: AgentCommandRequest): Promise<AgentHandle> {
  let pending = workspace.sessions.get(command.sessionId)
  if (pending === undefined) {
    await materializeAgentPresets(command.tenantId, workspace.userPresetRoot)
    const id = internalSessionId(command.tenantId, command.sessionId)
    pending = workspace.ctx.agents.resume({
      resumeSessionId: id,
      agentOptions: { provider: command.provider, model: command.model },
      setup: agentCtx => workspace.ctx.agentPresets.mount(agentCtx, command.agentPreset).then(() => undefined),
    })
    workspace.sessions.set(command.sessionId, pending)
    void pending.catch(() => { workspace.sessions.delete(command.sessionId) })
  }
  return pending
}

async function executeAgentCommand(command: AgentCommandRequest): Promise<string> {
  const workspace = await workspaceContext(command.tenantId, command.workspaceId)
  const handle = await sessionHandle(workspace, command)
  const activeKey = `${command.tenantId}/${command.sessionId}`
  activeAgents.set(activeKey, handle.agent)
  try {
    if (command.payload.action === 'compact') {
      const definition = workspace.ctx.commands.find(handle.agent, 'compact')
      if (definition === undefined) throw new Error('compaction is not enabled for this agent preset')
      const result = await definition.handler({
        commandId: `distributed-compact-${randomUUID()}` as never,
        agent: handle.agent,
        rawInput: '',
        signal: new AbortController().signal,
      })
      await workspace.ctx.sessions.flush(handle.agent.session)
      if (result.kind === 'error') throw new Error(result.text)
      return result.text ?? 'Compaction completed.'
    }
    const prompt = command.payload.text
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('message command has no text')
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    const turnEnd = handle.agent.session.events.findLast(event => event.type === 'turn/end')
    if (turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'error') {
      throw new Error(turnEnd.data.reason.error.message)
    }
    const finalText = finalAssistantText(handle.agent.session.events)
    if (finalText === '') throw new Error('agent completed without assistant text')
    await workspace.ctx.sessions.flush(handle.agent.session)
    return finalText
  } finally {
    activeAgents.delete(activeKey)
    if (invalidatedTenants.has(command.tenantId)) {
      void invalidateTenant(command.tenantId).catch((error) => { console.error('tenant runtime invalidation failed', error) })
    }
  }
}

async function disposeWorkspaceContext(workspace: WorkspaceContext): Promise<void> {
  await Promise.allSettled([...workspace.sessions.values()].map(async session => (await session).dispose()))
  await workspace.ctx.fiber.dispose()
}

async function invalidateTenant(tenantId: string): Promise<boolean> {
  if ([...activeAgents.keys()].some(key => key.startsWith(`${tenantId}/`))) {
    invalidatedTenants.add(tenantId)
    return false
  }
  invalidatedTenants.delete(tenantId)
  const retiring = [...contexts.entries()].filter(([key]) => key.startsWith(`${tenantId}/`))
  for (const [key] of retiring) contexts.delete(key)
  await Promise.allSettled(retiring.map(async ([, pending]) => disposeWorkspaceContext(await pending)))
  return true
}

async function workspaceContext(tenantId: string, workspaceId: string): Promise<WorkspaceContext> {
  if (invalidatedTenants.has(tenantId)) await invalidateTenant(tenantId)
  const key = `${tenantId}/${workspaceId}`
  let pending = contexts.get(key)
  if (pending === undefined) {
    pending = createWorkspaceContext(tenantId, workspaceId)
    contexts.set(key, pending)
    void pending.catch(() => { contexts.delete(key) })
  }
  return pending
}

async function tenantWorkspaces(tenantId: string): Promise<WorkspaceContext[]> {
  return Promise.all([...contexts.entries()]
    .filter(([key]) => key.startsWith(`${tenantId}/`))
    .map(([, pending]) => pending))
}

async function dynamicAgent(tenantId: string, agentId: unknown): Promise<{ workspace: WorkspaceContext; handle: AgentHandle }> {
  if (typeof agentId !== 'string') throw new HttpError(400, 'agentId must be a session UUID')
  const sessionId = assertUuid(agentId, 'agentId')
  const result = await pool.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM sessions WHERE tenant_id = $1 AND id = $2 AND workspace_id IS NOT NULL',
    [tenantId, sessionId],
  )
  const workspaceId = result.rows[0]?.workspace_id
  if (workspaceId === undefined) throw new HttpError(404, 'dynamic Cordis agent session was not found')
  const workspace = await workspaceContext(tenantId, workspaceId)
  const pending = workspace.sessions.get(sessionId)
  if (pending === undefined) throw new HttpError(409, 'dynamic Cordis requires the live owning Agent')
  return { workspace, handle: await pending }
}

async function dynamicCordis(request: DynamicCordisRequest): Promise<unknown> {
  const args = request.args
  if (request.method === 'inventory') {
    const inventory = (await tenantWorkspaces(request.tenantId)).flatMap(workspace => (
      workspace.ctx.dynamicCordisRunner.inventory()
    ))
    return inventory.map(row => ({
      ...row,
      agentId: splitInternalSessionId(row.agentId).sessionId,
    }))
  }
  if (request.method === 'syncInspectManifest') {
    const providers = Array.isArray(args['providers']) ? args['providers'] : []
    inspectManifests.set(request.tenantId, providers)
    for (const workspace of await tenantWorkspaces(request.tenantId)) {
      workspace.ctx.dynamicCordisRunner.syncInspectManifest(providers as never)
    }
    return null
  }
  if (request.method === 'invoke') {
    for (const workspace of await tenantWorkspaces(request.tenantId)) {
      if (!workspace.ctx.dynamicCordisRunner.inventory().some(row => row.pluginId === args['pluginId'])) continue
      return workspace.ctx.dynamicCordisRunner.invoke(
        args['pluginId'] as never,
        args['pluginRunId'] as never,
        requiredString(args, 'method'),
        args['args'] as never,
      )
    }
    return { ok: false, code: 'plugin-not-running', message: 'dynamic Cordis plugin is not running' }
  }
  if (request.method === 'resolveRequestRun') {
    for (const workspace of await tenantWorkspaces(request.tenantId)) {
      const result = await workspace.ctx.dynamicCordisRunner.resolveRequestRun(
        args['requestId'] as never,
        args['resolution'] as never,
      )
      if (result.accepted) return result
    }
    return { accepted: false }
  }
  const { workspace, handle } = await dynamicAgent(request.tenantId, args['agentId'])
  const runner = workspace.ctx.dynamicCordisRunner
  switch (request.method) {
    case 'stopFromPanel':
      return runner.stopFromPanel(handle.agent, args['pluginId'] as never)
    case 'undefineFromPanel':
      return runner.undefineFromPanel(handle.agent, args['pluginId'] as never)
    case 'runHostHalf':
      return runner.runHostHalf(
        handle.agent,
        args['pluginId'] as never,
        args['packageId'] as never,
        args['mode'] as never,
        args['requestId'] as never,
        args['approveFutureVersions'] === true,
      )
    case 'getClientCode':
      return runner.getClientCode(handle.agent, args['pluginId'] as never, args['pluginRunId'] as never)
    case 'settleUserRun':
      return runner.settleUserRun(handle.agent, args['pluginId'] as never, args['resolution'] as never)
    case 'resolveInspectQuery':
      return runner.resolveInspectQuery(handle.agent, args['requestId'] as never, args['resolution'] as never)
    case 'reportRenderFailure':
      return runner.reportRenderFailure(
        handle.agent,
        args['pluginId'] as never,
        args['pluginRunId'] as never,
        args['failure'] as never,
      )
    case 'reportClientGuardFailure':
      return runner.reportClientGuardFailure(
        handle.agent,
        args['pluginId'] as never,
        args['pluginRunId'] as never,
        args['failure'] as never,
      )
    default:
      throw new HttpError(400, `unsupported dynamic Cordis method ${request.method}`)
  }
}

function publicSessionId(value: string): string {
  return value.includes('/') ? splitInternalSessionId(value as never).sessionId : value
}

async function subagentOperation(request: SubagentRequest, signal: AbortSignal): Promise<unknown> {
  const workspace = await workspaceContext(request.tenantId, request.workspaceId)
  const parentSessionId = assertUuid(requiredString(request.args, 'parentSessionId'), 'parentSessionId')
  const internalParentId = internalSessionId(request.tenantId, parentSessionId)
  if (request.operation === 'list') {
    const entries = await workspace.ctx.subagents.listChildren(internalParentId as never, signal)
    return {
      entries: entries.map(entry => ({
        ...entry,
        id: publicSessionId(String(entry.id)),
        ...entry.kind === 'child' ? {
          activity: workspace.ctx.agents.get(entry.id)?.status === 'running' ? 'running' : 'inactive',
        } : {},
      })),
      parentAvailable: workspace.sessions.has(parentSessionId),
    }
  }
  const childSessionId = assertUuid(requiredString(request.args, 'childSessionId'), 'childSessionId')
  if (request.operation === 'interrupt') {
    workspace.ctx.subagents.interrupt(childSessionId as never, {
      kind: 'user',
      parentSessionId: internalParentId as never,
    })
    return { accepted: true }
  }
  const pending = workspace.sessions.get(parentSessionId)
  if (pending === undefined) throw new HttpError(409, 'subagent parent is not live in the owning Workspace')
  const content = request.args['content']
  if (!Array.isArray(content)) throw new HttpError(400, 'content must be an array')
  const rpcId = requiredString(request.args, 'rpcId')
  const messageId = await workspace.ctx.subagents.followup(
    (await pending).agent,
    childSessionId as never,
    content as ContentBlock[],
    { source: { kind: 'user', rpcId } as never, signal },
  )
  return { messageId }
}

async function catalog(tenantId: string, workspaceId: string): Promise<unknown> {
  const { ctx, root } = await workspaceContext(tenantId, workspaceId)
  const assembly = await ctx.systemPrompt.assemble()
  return {
    root,
    tools: ctx.tools.schemas(),
    skills: await workspaceSkills(root),
    guidance: assembly.sections
      .filter(section => section.name.startsWith('tool:'))
      .map(section => ({ name: section.name, order: assembly.sections.indexOf(section) + 100, text: section.text })),
  }
}

function fiberPhase(state: number | undefined): 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null {
  if (state === undefined || state === 4) return null
  if (state === 0) return 'pending'
  if (state === 1) return 'loading'
  if (state === 2) return 'active'
  if (state === 3) return 'failed'
  if (state === 5) return 'unloading'
  return null
}

/** Project the live Loader tree instead of maintaining a distributed plugin whitelist. */
async function pluginInventory(tenantId: string, workspaceId: string): Promise<unknown> {
  const { ctx } = await workspaceContext(tenantId, workspaceId)
  const entries = []
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    entries.push({
      entryId: entry.id,
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      fiberPhase: fiberPhase(entry.fiber?.state),
    })
  }
  return { entries }
}

function frontmatter(content: string): { attributes: Record<string, string>; body: string } {
  if (!content.startsWith('---\n')) return { attributes: {}, body: content }
  const end = content.indexOf('\n---\n', 4)
  if (end < 0) return { attributes: {}, body: content }
  const attributes: Record<string, string> = {}
  for (const line of content.slice(4, end).split('\n')) {
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/u.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      attributes[match[1]] = match[2].trim().replace(/^['"]|['"]$/gu, '')
    }
  }
  return { attributes, body: content.slice(end + 5).trim() }
}

async function workspaceSkills(root: string): Promise<WorkspaceSkill[]> {
  const winners = new Map<string, WorkspaceSkill>()
  for (const relativeRoot of ['.dsh/skills', '.agents/skills']) {
    const skillsRoot = resolve(root, relativeRoot)
    let entries
    try {
      entries = await readdir(skillsRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = entry.isDirectory()
        ? resolve(skillsRoot, entry.name, 'SKILL.md')
        : entry.isFile() && entry.name.endsWith('.md')
          ? resolve(skillsRoot, entry.name)
          : undefined
      if (path === undefined) continue
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const parsed = frontmatter(raw)
      const fallback = entry.isDirectory() ? entry.name : entry.name.slice(0, -3)
      const name = parsed.attributes['name'] ?? fallback
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || winners.has(name)) continue
      const description = parsed.attributes['description'] ?? `Workspace skill ${name}`
      winners.set(name, {
        name,
        description,
        ...(parsed.attributes['when-to-use'] === undefined ? {} : { whenToUse: parsed.attributes['when-to-use'] }),
        modelInvocable: parsed.attributes['disable-model-invocation'] !== 'true',
        content: parsed.body,
        directory: dirname(path),
      })
    }
  }
  return [...winners.values()].sort((left, right) => left.name.localeCompare(right.name))
}

async function executeTool(tool: ToolRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
  if (tool.permissionPreset === 'read-only'
    && ['bash', 'write', 'edit', 'str_replace_editor'].includes(tool.name)) {
    throw new HttpError(403, `tool ${tool.name} is unavailable in read-only mode`)
  }
  const workspace = await workspaceContext(tool.tenantId, tool.workspaceId)
  const args = await normalizedArguments(workspace.root, tool.name, tool.arguments)
  return workspace.ctx.tools.execute({
    callId: tool.callId as never,
    name: tool.name,
    arguments: args,
    signal,
  })
}

const server = createServer((request, response) => {
  void (async () => {
    if (request.method === 'GET' && request.url === '/healthz') {
      json(response, 200, { ok: true, service: 'workspace', contexts: contexts.size })
      return
    }
    if (!authorized(request)) throw new HttpError(401, 'unauthorized')
    if (request.method === 'POST' && request.url === '/internal/v1/agents/execute') {
      json(response, 200, { finalText: await executeAgentCommand(parseAgentCommand(await readJson(request))) })
      return
    }
    if (request.method === 'POST' && request.url === '/internal/v1/agents/cancel') {
      const body = requestRecord(await readJson(request))
      const tenantId = assertUuid(requiredString(body, 'tenantId'), 'tenantId')
      const sessionId = assertUuid(requiredString(body, 'sessionId'), 'sessionId')
      activeAgents.get(`${tenantId}/${sessionId}`)?.cancel({ kind: 'user' })
      json(response, 200, { cancelled: true })
      return
    }
    if (request.method === 'POST' && request.url === '/internal/v1/dynamic-cordis') {
      json(response, 200, await dynamicCordis(parseDynamicCordisRequest(await readJson(request))))
      return
    }
    if (request.method === 'POST' && request.url === '/internal/v1/subagents') {
      const controller = new AbortController()
      request.once('aborted', () => { controller.abort(new Error('subagent client disconnected')) })
      json(response, 200, await subagentOperation(parseSubagentRequest(await readJson(request)), controller.signal))
      return
    }
    if (request.method === 'POST' && request.url === '/internal/v1/runtime/invalidate') {
      const body = requestRecord(await readJson(request))
      const tenantId = assertUuid(requiredString(body, 'tenantId'), 'tenantId')
      json(response, 200, { invalidated: await invalidateTenant(tenantId) })
      return
    }
    if (request.method === 'POST' && request.url === '/internal/v1/catalog') {
      const body = requestRecord(await readJson(request))
      json(response, 200, await catalog(
        assertUuid(requiredString(body, 'tenantId'), 'tenantId'),
        assertUuid(requiredString(body, 'workspaceId'), 'workspaceId'),
      ))
      return
    }
    if (request.method === 'POST' && request.url === '/internal/v1/plugin-inventory') {
      const body = requestRecord(await readJson(request))
      json(response, 200, await pluginInventory(
        assertUuid(requiredString(body, 'tenantId'), 'tenantId'),
        assertUuid(requiredString(body, 'workspaceId'), 'workspaceId'),
      ))
      return
    }
    if (request.method === 'POST' && request.url === '/internal/v1/tools/execute') {
      const controller = new AbortController()
      request.once('aborted', () => {
        controller.abort(new Error('workspace tool client disconnected'))
      })
      response.once('close', () => {
        if (!response.writableEnded) controller.abort(new Error('workspace tool client disconnected'))
      })
      json(response, 200, await executeTool(parseToolRequest(await readJson(request)), controller.signal))
      return
    }
    throw new HttpError(404, 'not found')
  })().catch((error: unknown) => {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const status = error instanceof HttpError ? error.status : 500
    if (status === 500) console.error('workspace request failed', error)
    json(response, status, { error: { message: error instanceof Error ? error.message : String(error) } })
  })
})

server.listen(config.workspacePort, '0.0.0.0', () => {
  console.log(`workspace service listening on ${config.workspacePort} with root ${config.workspaceRoot}`)
})

async function shutdown(): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => { if (error === undefined) resolveClose(); else rejectClose(error) })
  })
  const settled = await Promise.allSettled([...contexts.values()].map(async (pending) => {
    await disposeWorkspaceContext(await pending)
  }))
  const failures: unknown[] = []
  for (const result of settled) {
    if (result.status === 'rejected') failures.push(result.reason as unknown)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'workspace shutdown failed')
}

function handleShutdown(): void {
  void shutdown().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}

process.once('SIGTERM', handleShutdown)
process.once('SIGINT', handleShutdown)
