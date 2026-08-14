import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const base = process.env.WORKSPACE_SERVICE_URL ?? 'http://127.0.0.1:3200'
const token = process.env.WORKSPACE_SERVICE_TOKEN ?? 'distributed-local-workspace-token-change-me'
const tenantId = randomUUID()
const workspaceA = randomUUID()
const workspaceB = randomUUID()

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

async function execute(workspaceId, name, args) {
  const result = await post('/internal/v1/tools/execute', {
    tenantId,
    workspaceId,
    callId: randomUUID(),
    name,
    arguments: args,
    permissionPreset: 'danger-full-access',
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result
}

const health = await fetch(`${base}/healthz`)
assert.equal(health.status, 200)

const catalogA = await post('/internal/v1/catalog', { tenantId, workspaceId: workspaceA })
const names = new Set(catalogA.tools.map(tool => tool.name))
for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'str_replace_editor', 'bash', 'job_output', 'job_list', 'job_kill']) {
  assert.ok(names.has(name), `missing upstream tool ${name}`)
}

await execute(workspaceA, 'write', { file_path: 'shared.txt', content: 'tenant A' })
await execute(workspaceA, 'edit', { file_path: 'shared.txt', old_string: 'tenant A', new_string: 'tenant A edited' })
const readA = await execute(workspaceA, 'read', { file_path: 'shared.txt' })
assert.match(JSON.stringify(readA.content), /tenant A edited/u)

await execute(workspaceA, 'str_replace_editor', {
  command: 'create',
  path: `${catalogA.root}/editor.txt`,
  file_text: 'alpha beta',
})
await execute(workspaceA, 'str_replace_editor', {
  command: 'str_replace',
  path: `${catalogA.root}/editor.txt`,
  old_str: 'beta',
  new_str: 'gamma',
})
const editorView = await execute(workspaceA, 'str_replace_editor', { command: 'view', path: `${catalogA.root}/editor.txt` })
assert.match(JSON.stringify(editorView.content), /alpha gamma/u)

const glob = await execute(workspaceA, 'glob', { pattern: '*.txt' })
assert.match(JSON.stringify(glob.value), /shared\.txt/u)
const grep = await execute(workspaceA, 'grep', { pattern: 'edited', include: '*.txt' })
assert.match(JSON.stringify(grep.value), /shared\.txt/u)

const bash = await execute(workspaceA, 'bash', {
  command: 'pwd && git --version && printf shell-ok > shell.txt && printf shell-ok',
  description: 'Verify foreground workspace shell execution',
})
assert.match(JSON.stringify(bash.content), /shell-ok/u)
assert.match(JSON.stringify(bash.content), /git version/u)
assert.match(JSON.stringify(bash.content), new RegExp(catalogA.root.replaceAll('/', '\\/'), 'u'))

const background = await execute(workspaceA, 'bash', {
  command: 'printf background-ok',
  description: 'Verify background workspace shell execution',
  run_in_background: true,
})
const job = await execute(workspaceA, 'job_output', {
  job_id: background.value.jobId,
  wait: true,
  timeout_ms: 10_000,
})
assert.match(JSON.stringify(job.content), /background-ok/u)

const missingInB = await post('/internal/v1/tools/execute', {
  tenantId,
  workspaceId: workspaceB,
  callId: randomUUID(),
  name: 'read',
  arguments: { file_path: 'shared.txt' },
  permissionPreset: 'danger-full-access',
})
assert.equal(missingInB.isError, true)
await execute(workspaceB, 'write', { file_path: 'shared.txt', content: 'tenant B' })
const stillA = await execute(workspaceA, 'read', { file_path: 'shared.txt' })
assert.match(JSON.stringify(stillA.content), /tenant A edited/u)
assert.doesNotMatch(JSON.stringify(stillA.content), /tenant B/u)

await post('/internal/v1/tools/execute', {
  tenantId,
  workspaceId: workspaceA,
  callId: randomUUID(),
  name: 'read',
  arguments: { file_path: '/etc/passwd' },
  permissionPreset: 'danger-full-access',
}, 400)

console.log(JSON.stringify({
  tenantId,
  workspaceA,
  workspaceB,
  root: catalogA.root,
  tools: [...names].sort(),
}, null, 2))
