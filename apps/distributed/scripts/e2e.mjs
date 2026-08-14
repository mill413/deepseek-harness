import assert from 'node:assert/strict'

const apis = (process.env.DSH_API_URLS ?? 'http://127.0.0.1:3101,http://127.0.0.1:3102').split(',')
const webUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:20810'
const tenantId = '11111111-1111-4111-8111-111111111111'
const otherTenantId = '22222222-2222-4222-8222-222222222222'
const userId = 'e2e-user'

async function request(base, path, options = {}, expected = undefined) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': tenantId,
      'x-user-id': userId,
      ...options.headers,
    },
  })
  const value = await response.json()
  if (expected !== undefined) assert.equal(response.status, expected, JSON.stringify(value))
  else assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`)
  return value
}

async function waitForCommand(base, id) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const command = await request(base, `/v1/commands/${id}`)
    if (['completed', 'failed', 'cancelled'].includes(command.status)) return command
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`command ${id} did not settle`)
}

const health = await Promise.all(apis.map(base => request(base, '/healthz')))
assert.deepEqual(new Set(health.map(item => item.instanceId)), new Set(['api-1', 'api-2']))
const webResponse = await fetch(webUrl)
assert.equal(webResponse.status, 200)
assert.match(await webResponse.text(), /DeepSeek Harness/)

const sessions = await Promise.all(Array.from({ length: 10 }, (_, index) => request(apis[index % 2], '/v1/sessions', {
  method: 'POST',
  body: JSON.stringify({ provider: 'distributed-mock', model: 'mock-agent' }),
}, 201)))

const denied = await request(apis[1], `/v1/sessions/${sessions[0].id}`, {
  headers: { 'x-tenant-id': otherTenantId },
}, 404)
assert.equal(denied.error, 'session not found')

const submitted = await Promise.all(sessions.map((session, index) => request(apis[(index + 1) % 2], `/v1/sessions/${session.id}/messages`, {
  method: 'POST',
  body: JSON.stringify({ text: `distributed message ${index}` }),
}, 202)))
const completed = await Promise.all(submitted.map((command, index) => waitForCommand(apis[index % 2], command.id)))
assert.ok(completed.every(command => command.status === 'completed'), JSON.stringify(completed))
assert.deepEqual(new Set(completed.map(command => command.workerId)), new Set(['worker-1', 'worker-2']))

for (let index = 0; index < sessions.length; index += 1) {
  const page = await request(apis[index % 2], `/v1/sessions/${sessions[index].id}/events?afterSeq=-1`)
  assert.ok(page.events.length >= 8)
  assert.deepEqual(page.events.map(event => event.seq), Array.from({ length: page.events.length }, (_, seq) => seq))
  assert.ok(page.events.some(event => event.type === 'tool/call'))
  assert.ok(page.events.some(event => event.type === 'tool/result'))
  assert.ok(page.events.some(event => event.type === 'assistant/message'))
}

const firstEvents = await request(apis[0], `/v1/sessions/${sessions[0].id}/events?afterSeq=-1`)
const followup = await request(apis[1], `/v1/sessions/${sessions[0].id}/messages`, {
  method: 'POST',
  body: JSON.stringify({ text: '[todo-e2e] resume this session through the other API' }),
}, 202)
const followupDone = await waitForCommand(apis[0], followup.id)
assert.equal(followupDone.status, 'completed')
const resumed = await request(apis[1], `/v1/sessions/${sessions[0].id}/events?afterSeq=-1`)
assert.ok(resumed.events.length > firstEvents.events.length)
assert.equal(resumed.events.filter(event => event.type === 'user/message').length, 2)
assert.ok(resumed.events.some(event => event.type === 'todo/write'))
assert.deepEqual(resumed.events.map(event => event.seq), Array.from({ length: resumed.events.length }, (_, seq) => seq))

console.log(JSON.stringify({
  apiInstances: health.map(item => item.instanceId),
  webUrl,
  workers: [...new Set(completed.map(command => command.workerId))].sort(),
  sessions: sessions.length,
  followupSession: sessions[0].id,
  eventCountAfterResume: resumed.events.length,
}, null, 2))
