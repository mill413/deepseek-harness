import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { WebSocket } = require('ws')
const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:20810'
const websocketBase = baseUrl.replace(/^http/u, 'ws')
let cookie = ''

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }), ...(options.headers ?? {}) },
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie !== null) cookie = setCookie.split(';')[0]
  const value = await response.json().catch(() => ({}))
  return { response, value }
}

async function rpc(method, payload) {
  const rpcId = randomUUID()
  const { response, value: envelope } = await jsonRequest(`/api/${method}`, {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  assert.equal(response.status, 200)
  assert.equal(envelope.rpcId, rpcId)
  assert.equal(envelope.result.ok, true, JSON.stringify(envelope))
  return envelope.result.value
}

function openFrames(path) {
  const frames = []
  const socket = new WebSocket(`${websocketBase}${path}`, { headers: { cookie } })
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.on('message', message => frames.push(JSON.parse(String(message))))
  return { socket, frames, opened }
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const value = predicate()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}`)
}

const indexResponse = await fetch(baseUrl)
assert.equal(indexResponse.status, 200)
const index = await indexResponse.text()
assert.match(index, /window\.__DSH_BOOT__/u)
assert.match(index, /distributed-auth\.js/u)
assert.match(index, /@deepseek-ai\/dsh-client-ui-conversation/u)

const unauthenticated = await jsonRequest('/api/session.list', {
  method: 'POST',
  headers: { 'x-tenant-id': randomUUID(), 'x-user-id': 'spoofed-browser-user' },
  body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session.list', payload: {} }),
})
assert.equal(unauthenticated.response.status, 401, 'Nginx must strip spoofed tenant identity headers')

const suffix = randomUUID().slice(0, 8)
const registration = await jsonRequest('/auth/register', {
  method: 'POST',
  body: JSON.stringify({ tenantName: `Web E2E ${suffix}`, tenantSlug: `web-${suffix}`, username: 'admin', password: 'correct-horse-20810' }),
})
assert.equal(registration.response.status, 201, JSON.stringify(registration.value))
assert.match(cookie, /^dsh_session=/u)
assert.equal(registration.value.user.role, 'admin')

const currentSession = await jsonRequest('/auth/session')
assert.equal(currentSession.response.status, 200)
assert.equal(currentSession.value.tenant.slug, `web-${suffix}`)

const initialModel = await jsonRequest('/admin/model-config')
assert.equal(initialModel.response.status, 200)
assert.equal(Object.hasOwn(initialModel.value, 'apiKey'), false, 'API key must never be returned')
const configuredModel = await jsonRequest('/admin/model-config', {
  method: 'PUT',
  body: JSON.stringify({ mode: 'mock', defaultModel: 'mock-agent', baseUrl: '', apiKey: `secret-${suffix}`, clearApiKey: false }),
})
assert.equal(configuredModel.response.status, 200, JSON.stringify(configuredModel.value))
assert.equal(configuredModel.value.apiKeyConfigured, true)
assert.equal(Object.hasOwn(configuredModel.value, 'apiKey'), false)

const initialWorkspaces = await rpc('workspace.list', {})
assert.equal(initialWorkspaces.items.length, 1)
const workspaceId = initialWorkspaces.items[0].workspaceId
assert.equal(initialWorkspaces.items[0].path, '/workspace')
const renamedWorkspace = await rpc('workspace.rename', { workspaceId, title: 'Main workspace' })
assert.equal(renamedWorkspace.workspace.title, 'Main workspace')
const extraWorkspace = await rpc('workspace.create', { path: '/workspace/research' })
assert.equal(extraWorkspace.created, true)
const reordered = await rpc('workspace.insertBefore', {
  workspaceId: extraWorkspace.workspace.workspaceId,
  beforeWorkspaceId: workspaceId,
})
assert.deepEqual(reordered.workspaceIds, [extraWorkspace.workspace.workspaceId, workspaceId])
const deletedWorkspace = await rpc('workspace.delete', { workspaceId: extraWorkspace.workspace.workspaceId })
assert.equal(deletedWorkspace.deleted, true)

const mux = openFrames('/api/events.mux')
const host = openFrames('/api/events.host')
await Promise.all([mux.opened, host.opened])

const description = await rpc('host.describe', {})
assert.equal(description.version, 'distributed-v1')
assert.equal(description.provider, 'distributed-mock')

const created = await rpc('session.create', { workspaceId })
const sessionId = created.sessionId
assert.equal(typeof sessionId, 'string')

const summary = await waitFor(() => host.frames.find(frame =>
  frame.payload?.type === 'host/session-added' && frame.payload.sessionId === sessionId), 'host/session-added')
assert.equal(summary.payload.blank, true)
assert.equal(summary.payload.cwd, '/workspace')

await waitFor(() => host.frames.find(frame =>
  frame.payload?.type === 'host/workspace-changed'
  && frame.payload.workspace.workspaceId === workspaceId
  && frame.payload.workspace.sessionIds.includes(sessionId)), 'workspace session attachment')

const models = await rpc('session.models', { sessionId })
assert.equal(models.routable, true)
assert.equal(models.current.provider, description.provider)
assert.equal(models.current.model, description.model)

await rpc('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: 'Authenticated multi-tenant Web API worker probe' }],
  clientTimeZone: 'Asia/Shanghai',
})

await waitFor(() => mux.frames.find(frame =>
  frame.payload?.type === 'session/event'
  && frame.payload.sessionId === sessionId
  && frame.payload.event?.type === 'assistant/message'), 'assistant/message WebSocket frame')

const history = await rpc('session.history', { sessionId, maxMessages: 50 })
assert.ok(history.events.some(entry => entry.event.type === 'user/message'))
assert.ok(history.events.some(entry => entry.event.type === 'tool/call'))
assert.ok(history.events.some(entry => entry.event.type === 'tool/result'))
assert.ok(history.events.some(entry => entry.event.type === 'assistant/message'))

await rpc('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '[workspace-e2e] run the shared workspace proxy probe' }],
  clientTimeZone: 'Asia/Shanghai',
})
const workspaceDeadline = Date.now() + 30_000
let workspaceEvents = (await rpc('session.history', { sessionId, maxMessages: 100 })).events
while (!JSON.stringify(workspaceEvents).includes('workspace-proxy-ok') && Date.now() < workspaceDeadline) {
  await new Promise(resolve => setTimeout(resolve, 200))
  workspaceEvents = (await rpc('session.history', { sessionId, maxMessages: 100 })).events
}
assert.match(JSON.stringify(workspaceEvents), /"name":"bash"/u)
assert.match(JSON.stringify(workspaceEvents), /workspace-proxy-ok/u)

const tenantACookie = cookie
cookie = ''
const tenantB = await jsonRequest('/auth/register', {
  method: 'POST',
  body: JSON.stringify({ tenantName: `Isolated ${suffix}`, tenantSlug: `isolated-${suffix}`, username: 'admin', password: 'correct-horse-20810' }),
})
assert.equal(tenantB.response.status, 201)
const isolatedList = await rpc('session.list', {})
assert.equal(isolatedList.items.some(item => item.sessionId === sessionId), false, 'tenant B must not see tenant A sessions')
const isolatedWorkspaces = await rpc('workspace.list', {})
assert.equal(isolatedWorkspaces.items.length, 1)
assert.notEqual(isolatedWorkspaces.items[0].workspaceId, workspaceId)
assert.equal(isolatedWorkspaces.items[0].sessionIds.includes(sessionId), false)
const isolatedModel = await jsonRequest('/admin/model-config')
assert.equal(isolatedModel.value.apiKeyConfigured, false, 'tenant B must not inherit tenant A stored key')

cookie = tenantACookie
const loggedOut = await jsonRequest('/auth/logout', { method: 'POST', body: '{}' })
assert.equal(loggedOut.response.status, 200)
const afterLogout = await jsonRequest('/auth/session')
assert.equal(afterLogout.response.status, 401)

await Promise.all([mux, host].map(connection => new Promise(resolve => {
  connection.socket.once('close', resolve)
  connection.socket.close()
})))

console.log(JSON.stringify({
  webUrl: baseUrl,
  tenant: registration.value.tenant.slug,
  isolatedTenant: tenantB.value.tenant.slug,
  sessionId,
  model: models.current,
  historyEvents: history.events.length,
  muxFrames: mux.frames.length,
  hostFrames: host.frames.length,
}, null, 2))
