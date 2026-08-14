import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { WebSocket } = require('ws')
const apiUrl = process.env.DSH_API_URL ?? 'http://api:3100'
const websocketUrl = apiUrl.replace(/^http/u, 'ws')
const suffix = randomUUID().slice(0, 8)
const headers = { 'content-type': 'application/json' }

async function request(path, options = {}, expected = undefined) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie !== null) headers.cookie = setCookie.split(';')[0]
  const value = await response.json()
  if (expected === undefined) assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`)
  else assert.equal(response.status, expected, JSON.stringify(value))
  return value
}

const identity = await request('/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    tenantName: `Tool parity ${suffix}`,
    tenantSlug: `tool-parity-${suffix}`,
    username: 'admin',
    password: 'admin12345',
  }),
}, 201)
assert.equal(identity.user.role, 'admin')

async function rpc(method, payload) {
  const rpcId = randomUUID()
  const envelope = await request(`/api/${method}`, {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  assert.equal(envelope.rpcId, rpcId)
  assert.equal(envelope.result.ok, true, JSON.stringify(envelope))
  return envelope.result.value
}

async function createSession(agentPreset = 'standard') {
  const sessionId = randomUUID()
  const created = await rpc('session.create', { sessionId, agentPreset })
  assert.equal(created.sessionId, sessionId)
  return sessionId
}

async function waitForCommand(commandId) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const command = await request(`/v1/commands/${commandId}`)
    if (['completed', 'failed', 'cancelled'].includes(command.status)) return command
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`command ${commandId} did not settle`)
}

async function runProbe(marker, toolName, agentPreset = 'standard') {
  const sessionId = await createSession(agentPreset)
  const command = await request(`/v1/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: marker }),
  }, 202)
  const completed = await waitForCommand(command.id)
  assert.equal(completed.status, 'completed', JSON.stringify(completed))
  const page = await request(`/v1/sessions/${sessionId}/events?afterSeq=-1`)
  const call = page.events.find(event => event.type === 'tool/call' && event.data?.name === toolName)
  assert.ok(call, `${toolName} was not called`)
  assert.ok(page.events.some(event => event.type === 'tool/result'
    && event.data?.message?.source?.callId === call.data.callId), `${toolName} produced no result`)
  return { sessionId, events: page.events }
}

async function catalogProbe(agentPreset, expected) {
  const sessionId = await createSession(agentPreset)
  const command = await request(`/v1/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: '[catalog-e2e]' }),
  }, 202)
  const completed = await waitForCommand(command.id)
  assert.equal(completed.status, 'completed', JSON.stringify(completed))
  assert.ok(completed.finalText?.startsWith('tool-catalog:'), completed.finalText)
  assert.deepEqual(JSON.parse(completed.finalText.slice('tool-catalog:'.length)), expected)
  return sessionId
}

const frames = []
const socket = new WebSocket(`${websocketUrl}/api/events.mux`, { headers })
socket.on('message', data => frames.push(JSON.parse(String(data))))
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

const questionSession = await createSession()
const questionCommand = await request(`/v1/sessions/${questionSession}/messages`, {
  method: 'POST',
  body: JSON.stringify({ text: '[question-e2e]' }),
}, 202)
const deadline = Date.now() + 30_000
let question
while (Date.now() < deadline) {
  question = frames.find(frame => frame.payload?.type === 'question/requested' && frame.payload.sessionId === questionSession)
  if (question !== undefined) break
  await new Promise(resolve => setTimeout(resolve, 100))
}
assert.ok(question, 'question/requested was not delivered through the mux WebSocket')
const receipt = await request('/api/respond', {
  method: 'POST',
  body: JSON.stringify({
    type: 'client-response',
    rpcId: question.rpcId,
    result: {
      ok: true,
      value: {
        sessionId: questionSession,
        answer: { answers: [{ id: 'distributed-parity', selected: ['Continue'] }] },
      },
    },
  }),
})
assert.deepEqual(receipt, { accepted: true })
const questionDone = await waitForCommand(questionCommand.id)
assert.equal(questionDone.status, 'completed', JSON.stringify(questionDone))
const questionEvents = await request(`/v1/sessions/${questionSession}/events?afterSeq=-1`)
const questionCall = questionEvents.events.find(event => event.type === 'tool/call' && event.data?.name === 'ask_user_question')
assert.ok(questionCall)
assert.ok(questionEvents.events.some(event => event.type === 'tool/result'
  && event.data?.message?.source?.callId === questionCall.data.callId))

const subagent = await runProbe('[subagent-e2e]', 'subagent')
const subagentCatalog = await rpc('subagent.list', { parentSessionId: subagent.sessionId })
const child = subagentCatalog.entries.find(entry => entry.kind === 'child')
assert.ok(child, JSON.stringify(subagentCatalog))
assert.equal(child.mode, 'one-shot')
const childHistory = await rpc('subagent.history', {
  parentSessionId: subagent.sessionId,
  childSessionId: child.id,
  mode: child.mode,
})
assert.ok(childHistory.events.length > 0)
await runProbe('[workflow-e2e]', 'workflow')
await runProbe('[goal-e2e]', 'create_goal')
await runProbe('[code-e2e]', 'run_code', 'code')

const cordis = await runProbe('[cordis-e2e]', 'cordis_define', 'cordis')
const inventory = await rpc('dynamicCordisRunner/inventory', { args: {} })
assert.ok(inventory.some(row => row.agentId === cordis.sessionId && row.packages.some(pkg => pkg.name === 'Distributed Cordis parity probe')))

const standardTools = [
  'ask_user_question', 'bash', 'create_goal', 'edit', 'exit_plan_mode', 'get_goal', 'glob', 'grep',
  'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents', 'ralph', 'read', 'read_image',
  'send_message', 'skill', 'subagent', 'subagent_fork', 'todo_write', 'update_goal', 'web_search', 'workflow', 'write',
].sort()
await catalogProbe('standard', standardTools)
await catalogProbe('minimal', ['bash', 'str_replace_editor'])
await catalogProbe('code', ['run_code'])
await catalogProbe('cordis', [...standardTools,
  'cordis_define', 'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
  'cordis_run', 'cordis_stop', 'cordis_undefine',
].sort())

const customPreset = `parity-${randomUUID()}`
await rpc('agentPreset.copy', { from: 'minimal', agentPreset: customPreset, name: 'Distributed preset parity' })
await catalogProbe(customPreset, ['bash', 'str_replace_editor'])
await rpc('agentPreset.remove', { agentPreset: customPreset })

socket.close()
console.log(JSON.stringify({
  questionSession,
  subagentSession: subagent.sessionId,
  verified: [
    'ask_user_question', 'subagent', 'subagent.list', 'subagent.history', 'workflow', 'create_goal',
    'run_code', 'cordis_define', 'dynamicCordisRunner.inventory', 'preset tool catalogs', 'tenant preset execution',
  ],
}, null, 2))
