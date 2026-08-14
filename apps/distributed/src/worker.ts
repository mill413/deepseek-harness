import { config } from './config.ts'
import { migrate, one, pool, tx } from './db.ts'
import { connectRedis, ensureGroup, type RedisClient } from './redis.ts'
import { cancelWorkspaceAgent, executeWorkspaceAgentCommand } from './workspace-client.ts'

interface Command {
  tenant_id: string
  id: string
  session_id: string
  payload: { text?: string; action?: 'compact' }
  status: string
  cancel_requested: boolean
  provider: string
  model: string
  header: unknown
  workspace_id: string
  agent_preset: string
  permission_preset: string
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
      s.provider, s.model, s.header, s.workspace_id, s.agent_preset, s.permission_preset
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

  try {
    const finalText = await executeWorkspaceAgentCommand({
      tenantId: command.tenant_id,
      workspaceId: command.workspace_id,
      sessionId: command.session_id,
      provider: command.provider,
      model: command.model,
      agentPreset: command.agent_preset,
      permissionPreset: command.permission_preset,
      payload: command.payload,
    })
    await pool.query(`
      UPDATE agent_commands SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'completed' END,
        final_text = $4, heartbeat_at = now(), completed_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND worker_id = $3
    `, [command.tenant_id, command.id, config.workerId, finalText])
    await pool.query('UPDATE sessions SET status = \'idle\', updated_at = now() WHERE tenant_id = $1 AND id = $2', [command.tenant_id, command.session_id])
  } catch (error) {
    console.error(`command ${command.id} failed`, error)
    await pool.query(`
      UPDATE agent_commands SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
        error = $4::jsonb, completed_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND worker_id = $3
    `, [command.tenant_id, command.id, config.workerId, JSON.stringify({ message: error instanceof Error ? error.message : String(error) })])
    await pool.query('UPDATE sessions SET status = \'failed\', updated_at = now() WHERE tenant_id = $1 AND id = $2', [command.tenant_id, command.session_id])
  } finally {
    clearInterval(heartbeat)
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
    void cancelWorkspaceAgent(message.tenantId, message.sessionId).catch((error: unknown) => {
      console.error('workspace cancellation failed', error)
    })
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
  await subscriber.close()
  await redis.close()
  await pool.end()
}

process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
