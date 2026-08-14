import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'

const base = process.env.WORKSPACE_SERVICE_URL ?? 'http://127.0.0.1:3200'
const token = process.env.WORKSPACE_SERVICE_TOKEN ?? 'distributed-local-workspace-token-change-me'
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://dsh:dsh@postgres:5432/dsh'
const tenantId = randomUUID()
const workspaceA = randomUUID()
const workspaceB = randomUUID()
const sessionA = randomUUID()
const sessionB = randomUUID()
const owner = randomUUID()
const client = new pg.Client({ connectionString: databaseUrl })

async function post(path, body, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const value = await response.json()
  assert.equal(response.status, expected, JSON.stringify(value))
  return value
}

async function execute(workspaceId, sessionId, text) {
  return post('/internal/v1/agents/execute', {
    tenantId,
    workspaceId,
    sessionId,
    provider: 'distributed-mock',
    model: 'mock-agent',
    agentPreset: 'standard',
    permissionPreset: 'danger-full-access',
    payload: { text },
  })
}

const health = await fetch(`${base}/healthz`)
assert.equal(health.status, 200)

await client.connect()
try {
  await client.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [tenantId, 'Workspace e2e', `workspace-${tenantId}`])
  await client.query(`
    INSERT INTO tenant_workspaces (tenant_id, id, path, title, sort_order, is_default)
    VALUES ($1, $2, '/workspace-a', 'A', 0, true), ($1, $3, '/workspace-b', 'B', 1, false)
  `, [tenantId, workspaceA, workspaceB])
  for (const [sessionId, workspaceId] of [[sessionA, workspaceA], [sessionB, workspaceB]]) {
    const header = {
      version: 0,
      id: `${tenantId}/${sessionId}`,
      createdAt: Date.now(),
      cwd: `/workspaces/${tenantId}/${workspaceId}`,
      agentPreset: 'standard',
    }
    await client.query(`
      INSERT INTO sessions
        (tenant_id, id, owner_user_id, workspace_id, provider, model, agent_preset, permission_preset, header)
      VALUES ($1, $2, $3, $4, 'distributed-mock', 'mock-agent', 'standard', 'danger-full-access', $5::jsonb)
    `, [tenantId, sessionId, owner, workspaceId, JSON.stringify(header)])
  }

  const completedA = await execute(workspaceA, sessionA, '[workspace-e2e]')
  assert.match(completedA.finalText, /completed by worker-/u)
  const rootA = `/workspaces/${tenantId}/${workspaceA}`
  assert.equal(await readFile(`${rootA}/worker-proxy.txt`, 'utf8'), 'workspace-proxy-ok')

  const completedB = await execute(workspaceB, sessionB, '[workspace-e2e]')
  assert.match(completedB.finalText, /completed by worker-/u)
  const rootB = `/workspaces/${tenantId}/${workspaceB}`
  assert.equal(await readFile(`${rootB}/worker-proxy.txt`, 'utf8'), 'workspace-proxy-ok')
  assert.notEqual(rootA, rootB)

  const eventRows = await client.query(`
    SELECT session_id, event->>'type' AS type FROM session_events
    WHERE tenant_id = $1 AND session_id = ANY($2::uuid[])
  `, [tenantId, [sessionA, sessionB]])
  for (const sessionId of [sessionA, sessionB]) {
    const types = eventRows.rows.filter(row => row.session_id === sessionId).map(row => row.type)
    assert.ok(types.includes('tool/call'))
    assert.ok(types.includes('tool/result'))
    assert.ok(types.includes('assistant/message'))
  }

  console.log(JSON.stringify({ tenantId, workspaceA, workspaceB, rootA, rootB, mode: 'official-agent-runtime' }, null, 2))
} finally {
  await client.query('DELETE FROM sessions WHERE tenant_id = $1', [tenantId])
  await client.query('DELETE FROM tenants WHERE id = $1', [tenantId])
  await client.end()
}
