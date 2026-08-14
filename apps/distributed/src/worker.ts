import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  CallId,
  createUserMessage,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import { apply as checkpointPolicy, inject as checkpointInject } from '@deepseek-ai/dsh-session-checkpoint-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { config } from './config.ts'
import { migrate, one, pool, tx } from './db.ts'
import { internalSessionId } from './identity.ts'
import { tenantModelConfig, type TenantModelConfig } from './model-config.ts'
import PostgresSessionPersistence from './postgres-persistence.ts'
import { connectRedis, ensureGroup, type RedisClient } from './redis.ts'
import * as WorkerExtensions from './worker-extensions.ts'
import { workspaceRootPath } from './workspace-path.ts'

interface Command {
  tenant_id: string
  id: string
  session_id: string
  payload: { text: string }
  status: string
  cancel_requested: boolean
  provider: string
  model: string
  header: unknown
  workspace_id: string
}

interface StreamBatch {
  messages: Array<{ id: string; message: Record<string, string> }>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseStreamBatches(value: unknown): StreamBatch[] | null {
  if (value === null) return null
  if (!Array.isArray(value)) throw new Error('Redis returned an invalid Stream batch')
  return (value as unknown[]).map((batchValue) => {
    const batch = record(batchValue)
    if (batch === undefined || !Array.isArray(batch['messages'])) throw new Error('Redis returned an invalid Stream batch')
    const messages = (batch['messages'] as unknown[]).map((messageValue) => {
      const entry = record(messageValue)
      const fields = record(entry?.['message'])
      if (typeof entry?.['id'] !== 'string' || fields === undefined) throw new Error('Redis returned an invalid Stream entry')
      const message: Record<string, string> = {}
      for (const [key, field] of Object.entries(fields)) {
        if (typeof field !== 'string') throw new Error('Redis returned a non-string Stream field')
        message[key] = field
      }
      return { id: entry['id'], message }
    })
    return { messages }
  })
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }, { once: true })
  })
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolChunks(callId: string, name = 'worker_probe', input: unknown = { input: 'distributed probe' }): StreamChunk[] {
  const id = CallId(callId)
  const args = JSON.stringify(input)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function todoChunks(callId: string): StreamChunk[] {
  return toolChunks(callId, 'todo_write', {
    todos: [
      { content: 'Verify upstream plugin adaptation', status: 'completed' },
    ],
  })
}

class DistributedMockAdapter extends LlmAdapter {
  private calls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 16_384 })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await delay(config.mockDelayMs, options.signal)
    const last = options.messages.at(-1)
    const hasToolResult = last?.content.some(block => block.type === 'tool-result') === true
    const requestsWorkspaceProbe = last?.content.some(block =>
      block.type === 'text' && block.text.includes('[workspace-e2e]')) === true
    const requestsTodoProbe = last?.content.some(block =>
      block.type === 'text' && block.text.includes('[todo-e2e]')) === true
    const chunks = hasToolResult
      ? textChunks(`completed by ${config.workerId}`)
      : requestsWorkspaceProbe
        ? toolChunks(`${config.workerId}-${++this.calls}-${randomUUID()}`, 'bash', {
          command: 'printf workspace-proxy-ok > worker-proxy.txt && pwd && printf workspace-proxy-ok',
          description: 'Verify shared workspace proxy execution',
        })
        : requestsTodoProbe
          ? todoChunks(`${config.workerId}-${++this.calls}-${randomUUID()}`)
          : toolChunks(`${config.workerId}-${++this.calls}-${randomUUID()}`)
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
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

async function buildHarness(modelConfig: TenantModelConfig, tenantId: string, workspaceId: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(PostgresSessionPersistence)
  await ctx.plugin({ name: 'session-checkpoint-policy', inject: [...checkpointInject], apply: checkpointPolicy })
  await ctx.plugin(WorkerExtensions, { tenantId, workspaceId })
  ctx.llm.registerAdapter(['distributed-mock'], new DistributedMockAdapter())
  if (modelConfig.mode === 'deepseek') {
    const options = resolveAdapterOptions({
      baseURL: modelConfig.baseUrl ?? config.deepSeekBaseUrl,
      models: [{ id: modelConfig.defaultModel, name: modelConfig.defaultModel }],
    })
    ctx.llm.registerAdapter(['deepseek-official'], new DeepSeekAdapter({
      options: () => options,
      resolveApiKey: () => {
        if (modelConfig.apiKey === null) {
          throw new LlmError('No DeepSeek API key is configured for this tenant', 'MISSING_CREDENTIAL')
        }
        return Promise.resolve(modelConfig.apiKey)
      },
      resolveUserId: () => getOrCreateAnonymousUserId(),
    }))
  }
  ctx.tools.register(defineTool({
    name: 'worker_probe',
    description: 'Return the worker identity to verify native distributed tool execution.',
    parameters: {
      input: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        properties: { workerId: { type: 'string' }, input: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args) {
      return Promise.resolve({ workerId: config.workerId, input: args.input })
    },
  }))
  return ctx
}

async function acquireLease(redis: RedisClient, tenantId: string, sessionId: string, token: string): Promise<boolean> {
  const result = await redis.set(`dsh:lease:${tenantId}:${sessionId}`, token, {
    condition: 'NX',
    expiration: { type: 'EX', value: config.leaseSeconds },
  })
  return result === 'OK'
}

async function refreshLease(redis: RedisClient, key: string, token: string): Promise<void> {
  await redis.eval(
    'if redis.call(\'GET\', KEYS[1]) == ARGV[1] then return redis.call(\'EXPIRE\', KEYS[1], ARGV[2]) else return 0 end',
    { keys: [key], arguments: [token, String(config.leaseSeconds)] },
  )
}

async function releaseLease(redis: RedisClient, key: string, token: string): Promise<void> {
  await redis.eval(
    'if redis.call(\'GET\', KEYS[1]) == ARGV[1] then return redis.call(\'DEL\', KEYS[1]) else return 0 end',
    { keys: [key], arguments: [token] },
  )
}

async function loadCommand(tenantId: string, commandId: string): Promise<Command | undefined> {
  return one<Command>(`
    SELECT c.tenant_id, c.id, c.session_id, c.payload, c.status, c.cancel_requested,
      s.provider, s.model, s.header, s.workspace_id
    FROM agent_commands c
    JOIN sessions s ON s.tenant_id = c.tenant_id AND s.id = c.session_id
    JOIN tenant_workspaces w ON w.tenant_id = s.tenant_id AND w.id = s.workspace_id
    WHERE c.tenant_id = $1 AND c.id = $2
  `, [tenantId, commandId])
}

async function requeue(command: Command): Promise<void> {
  await pool.query(`
    UPDATE agent_commands SET dispatched_at = NULL, next_dispatch_at = now() + interval '250 milliseconds'
    WHERE tenant_id = $1 AND id = $2 AND status = 'queued'
  `, [command.tenant_id, command.id])
}

const activeAgents = new Map<string, Agent>()

async function executeCommand(redis: RedisClient, command: Command): Promise<void> {
  const leaseKey = `dsh:lease:${command.tenant_id}:${command.session_id}`
  const leaseToken = `${config.workerId}:${command.id}`
  const claimed = await tx(async (client) => {
    const result = await client.query<{ cancel_requested: boolean }>(`
      SELECT cancel_requested FROM agent_commands WHERE tenant_id = $1 AND id = $2 FOR UPDATE
    `, [command.tenant_id, command.id])
    const row = result.rows[0]
    if (row === undefined) return false
    if (row.cancel_requested) {
      await client.query('UPDATE agent_commands SET status = \'cancelled\', completed_at = now() WHERE tenant_id = $1 AND id = $2 AND status = \'queued\'', [command.tenant_id, command.id])
      return false
    }
    const update = await client.query(`
      UPDATE agent_commands SET status = 'running', worker_id = $3, attempt = attempt + 1,
        started_at = now(), heartbeat_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'queued'
    `, [command.tenant_id, command.id, config.workerId])
    if (update.rowCount !== 1) return false
    await client.query('UPDATE sessions SET status = \'running\', updated_at = now() WHERE tenant_id = $1 AND id = $2', [command.tenant_id, command.session_id])
    return true
  })
  if (!claimed) {
    await releaseLease(redis, leaseKey, leaseToken)
    return
  }
  const heartbeat = setInterval(() => {
    void Promise.all([
      refreshLease(redis, leaseKey, leaseToken),
      pool.query('UPDATE agent_commands SET heartbeat_at = now() WHERE tenant_id = $1 AND id = $2 AND status = \'running\' AND worker_id = $3', [command.tenant_id, command.id, config.workerId]),
      redis.set(`dsh:worker:${config.workerId}`, new Date().toISOString(), { expiration: { type: 'EX', value: config.heartbeatSeconds * 3 } }),
    ]).catch((error: unknown) => { console.error('worker heartbeat failed', error) })
  }, config.heartbeatSeconds * 1000)

  let ctx: Context | undefined
  try {
    ctx = await buildHarness(await tenantModelConfig(command.tenant_id), command.tenant_id, command.workspace_id)
    const id = internalSessionId(command.tenant_id, command.session_id)
    const handle = command.header === null
      ? await ctx.agents.create({
        sessionId: id,
        meta: { cwd: workspaceRootPath(command.tenant_id, command.workspace_id) },
        agentOptions: { provider: command.provider, model: command.model },
      })
      : await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: command.provider, model: command.model } })
    activeAgents.set(`${command.tenant_id}/${command.session_id}`, handle.agent)
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: command.payload.text }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    await ctx.sessions.flush(handle.agent.session)
    const turnEnd = handle.agent.session.events.findLast(event => event.type === 'turn/end')
    if (turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'error') {
      throw new Error(turnEnd.data.reason.error.message)
    }
    const finalText = finalAssistantText(handle.agent.session.events)
    if (finalText === '') throw new Error('agent completed without assistant text')
    await pool.query(`
      UPDATE agent_commands SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'completed' END,
        final_text = $4, heartbeat_at = now(), completed_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND worker_id = $3
    `, [command.tenant_id, command.id, config.workerId, finalText])
    await pool.query('UPDATE sessions SET status = \'idle\', updated_at = now() WHERE tenant_id = $1 AND id = $2', [command.tenant_id, command.session_id])
    activeAgents.delete(`${command.tenant_id}/${command.session_id}`)
    await handle.dispose()
  } catch (error) {
    activeAgents.delete(`${command.tenant_id}/${command.session_id}`)
    console.error(`command ${command.id} failed`, error)
    await pool.query(`
      UPDATE agent_commands SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
        error = $4::jsonb, completed_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND worker_id = $3
    `, [command.tenant_id, command.id, config.workerId, JSON.stringify({ message: error instanceof Error ? error.message : String(error) })])
    await pool.query('UPDATE sessions SET status = \'failed\', updated_at = now() WHERE tenant_id = $1 AND id = $2', [command.tenant_id, command.session_id])
  } finally {
    clearInterval(heartbeat)
    if (ctx !== undefined) await ctx.fiber.dispose().catch((error: unknown) => { console.error('harness disposal failed', error) })
    await releaseLease(redis, leaseKey, leaseToken)
  }
}

await migrate()
const redis = await connectRedis()
await ensureGroup(redis)
await redis.set(`dsh:worker:${config.workerId}`, new Date().toISOString(), { expiration: { type: 'EX', value: config.heartbeatSeconds * 3 } })
const subscriber = await connectRedis()
await subscriber.subscribe('dsh:agent:cancel', (raw) => {
  try {
    const message = JSON.parse(raw) as { tenantId: string; sessionId: string }
    activeAgents.get(`${message.tenantId}/${message.sessionId}`)?.cancel({ kind: 'user' })
  } catch (error) {
    console.error('invalid cancellation message', error)
  }
})

let stopping = false
console.log(`${config.workerId} consuming ${config.stream}`)
while (!stopping) {
  const rawBatches: unknown = await redis.xReadGroup(config.group, config.workerId, [{ key: config.stream, id: '>' }], { COUNT: 1, BLOCK: 1000 })
  const batches = parseStreamBatches(rawBatches)
  if (batches === null) continue
  for (const batch of batches) {
    for (const message of batch.messages) {
      const tenantId = message.message['tenantId']
      const commandId = message.message['commandId']
      if (tenantId === undefined || commandId === undefined) {
        await redis.xAck(config.stream, config.group, message.id)
        continue
      }
      const command = await loadCommand(tenantId, commandId)
      if (command === undefined || ['completed', 'failed', 'cancelled'].includes(command.status)) {
        await redis.xAck(config.stream, config.group, message.id)
        continue
      }
      const token = `${config.workerId}:${command.id}`
      if (!await acquireLease(redis, command.tenant_id, command.session_id, token)) {
        await requeue(command)
        await redis.xAck(config.stream, config.group, message.id)
        continue
      }
      await executeCommand(redis, command)
      await redis.xAck(config.stream, config.group, message.id)
    }
  }
}

async function shutdown(): Promise<void> {
  stopping = true
  for (const agent of activeAgents.values()) agent.cancel({ kind: 'disposed' })
  await subscriber.close()
  await redis.close()
  await pool.end()
}

process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
