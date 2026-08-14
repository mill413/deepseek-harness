import assert from 'node:assert/strict'

const apiUrl = process.env.DSH_API_URL ?? 'http://api:3100'
const webUrl = process.env.DSH_WEB_URL ?? 'http://web'
const expectedApiReplicas = Number(process.env.DSH_EXPECT_API_REPLICAS ?? '2')
const expectedWorkerReplicas = Number(process.env.DSH_EXPECT_WORKER_REPLICAS ?? '2')
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

assert.ok(Number.isSafeInteger(expectedApiReplicas) && expectedApiReplicas > 0)
assert.ok(Number.isSafeInteger(expectedWorkerReplicas) && expectedWorkerReplicas > 0)

async function discoverApiInstances() {
  const instanceIds = new Set()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && instanceIds.size < expectedApiReplicas) {
    const samples = await Promise.all(Array.from({ length: expectedApiReplicas * 12 }, async () => {
      const response = await fetch(`${webUrl}/healthz`, { headers: { connection: 'close' } })
      if (!response.ok) return undefined
      return response.json()
    }))
    for (const sample of samples) {
      if (sample?.instanceId) instanceIds.add(sample.instanceId)
    }
    if (instanceIds.size < expectedApiReplicas) await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.equal(instanceIds.size, expectedApiReplicas, `expected ${expectedApiReplicas} API replicas, found ${[...instanceIds].join(', ')}`)
  return instanceIds
}

const apiInstances = await discoverApiInstances()
const webResponse = await fetch(webUrl)
assert.equal(webResponse.status, 200)
assert.match(await webResponse.text(), /DeepSeek Harness/)

const sessionCount = Math.max(20, expectedWorkerReplicas * 10)
const sessions = await Promise.all(Array.from({ length: sessionCount }, () => request(apiUrl, '/v1/sessions', {
  method: 'POST',
  body: JSON.stringify({ provider: 'distributed-mock', model: 'mock-agent' }),
}, 201)))

const denied = await request(apiUrl, `/v1/sessions/${sessions[0].id}`, {
  headers: { 'x-tenant-id': otherTenantId },
}, 404)
assert.equal(denied.error, 'session not found')

const submitted = await Promise.all(sessions.map((session, index) => request(apiUrl, `/v1/sessions/${session.id}/messages`, {
  method: 'POST',
  body: JSON.stringify({ text: `distributed message ${index}` }),
}, 202)))
const completed = await Promise.all(submitted.map(command => waitForCommand(apiUrl, command.id)))
assert.ok(completed.every(command => command.status === 'completed'), JSON.stringify(completed))
const workerInstances = new Set(completed.map(command => command.workerId))
assert.equal(workerInstances.size, expectedWorkerReplicas, `expected ${expectedWorkerReplicas} Workers, found ${[...workerInstances].join(', ')}`)

for (let index = 0; index < sessions.length; index += 1) {
  const page = await request(apiUrl, `/v1/sessions/${sessions[index].id}/events?afterSeq=-1`)
  assert.ok(page.events.length >= 8)
  assert.deepEqual(page.events.map(event => event.seq), Array.from({ length: page.events.length }, (_, seq) => seq))
  assert.ok(page.events.some(event => event.type === 'tool/call'))
  assert.ok(page.events.some(event => event.type === 'tool/result'))
  assert.ok(page.events.some(event => event.type === 'assistant/message'))
}

const firstEvents = await request(apiUrl, `/v1/sessions/${sessions[0].id}/events?afterSeq=-1`)
const followup = await request(apiUrl, `/v1/sessions/${sessions[0].id}/messages`, {
  method: 'POST',
  body: JSON.stringify({ text: '[todo-e2e] resume this session through the API' }),
}, 202)
const followupDone = await waitForCommand(apiUrl, followup.id)
assert.equal(followupDone.status, 'completed')
const resumed = await request(apiUrl, `/v1/sessions/${sessions[0].id}/events?afterSeq=-1`)
assert.ok(resumed.events.length > firstEvents.events.length)
assert.equal(resumed.events.filter(event => event.type === 'user/message').length, 2)
assert.ok(resumed.events.some(event => event.type === 'todo/write'))
assert.deepEqual(resumed.events.map(event => event.seq), Array.from({ length: resumed.events.length }, (_, seq) => seq))

console.log(JSON.stringify({
  apiInstances: [...apiInstances].sort(),
  webUrl,
  workers: [...workerInstances].sort(),
  sessions: sessions.length,
  followupSession: sessions[0].id,
  eventCountAfterResume: resumed.events.length,
}, null, 2))
