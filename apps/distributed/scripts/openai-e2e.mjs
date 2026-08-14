import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const baseUrl = process.env.DSH_API_URL ?? 'http://127.0.0.1:20810'
const providerBaseUrl = process.env.DSH_OPENAI_BASE_URL ?? 'http://openai-mock:3300/v1/chat/completions'
let cookie = ''

async function request(path, options = {}, expected) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }), ...(options.headers ?? {}) },
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie !== null) cookie = setCookie.split(';')[0]
  const value = await response.json()
  assert.equal(response.status, expected, JSON.stringify(value))
  return value
}

const suffix = randomUUID().slice(0, 8)
await request('/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    tenantName: `OpenAI E2E ${suffix}`,
    tenantSlug: `openai-${suffix}`,
    username: 'admin',
    password: 'openai-e2e-password',
  }),
}, 201)

const configured = await request('/admin/model-config', {
  method: 'PUT',
  body: JSON.stringify({
    mode: 'openai',
    defaultModel: 'mock-chat-completions',
    baseUrl: providerBaseUrl,
    apiKey: `sk-e2e-${suffix}`,
    clearApiKey: false,
  }),
}, 200)
assert.equal(configured.provider, 'openai-compatible')
assert.equal(configured.baseUrl, providerBaseUrl.replace(/\/chat\/completions$/u, ''))
assert.equal(configured.apiKeyConfigured, true)
assert.equal(Object.hasOwn(configured, 'apiKey'), false)

const session = await request('/v1/sessions', { method: 'POST', body: '{}' }, 201)
assert.equal(session.provider, 'openai-compatible')
assert.equal(session.model, 'mock-chat-completions')
const command = await request(`/v1/sessions/${session.id}/messages`, {
  method: 'POST',
  body: JSON.stringify({ text: 'Call the worker probe, then answer.' }),
}, 202)

const deadline = Date.now() + 60_000
let settled
while (Date.now() < deadline) {
  settled = await request(`/v1/commands/${command.id}`, {}, 200)
  if (['completed', 'failed', 'cancelled'].includes(settled.status)) break
  await new Promise(resolve => setTimeout(resolve, 200))
}
assert.equal(settled?.status, 'completed', JSON.stringify(settled))
assert.equal(settled.finalText, 'OpenAI-compatible mock completed.')

const history = await request(`/v1/sessions/${session.id}/events?afterSeq=-1`, {}, 200)
assert.ok(history.events.some(entry => entry.type === 'tool/call'))
assert.ok(history.events.some(entry => entry.type === 'tool/result'))
assert.match(JSON.stringify(history.events), /openai-compatible e2e/u)

console.log(JSON.stringify({
  tenant: `openai-${suffix}`,
  provider: configured.provider,
  model: configured.defaultModel,
  worker: settled.workerId,
  events: history.events.length,
}, null, 2))
