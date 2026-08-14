import { createServer } from 'node:http'

const port = Number(process.env.MOCK_OPENAI_PORT ?? 3300)

function event(response, value) {
  response.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`)
}

createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
    return
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":{"message":"not found"}}')
    return
  }
  let raw = ''
  request.on('data', chunk => { raw += String(chunk) })
  request.on('end', () => {
    const body = JSON.parse(raw)
    const hasToolResult = Array.isArray(body.messages) && body.messages.some(message => message.role === 'tool')
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (hasToolResult) {
      event(response, { choices: [{ index: 0, delta: { role: 'assistant', content: 'OpenAI-compatible mock completed.' }, finish_reason: null }] })
      event(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } })
    } else {
      event(response, {
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'openai-compatible-probe',
              type: 'function',
              function: { name: 'worker_probe', arguments: '{"input":"openai-compatible e2e"}' },
            }],
          },
          finish_reason: null,
        }],
      })
      event(response, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 8 } })
    }
    event(response, '[DONE]')
    response.end()
  })
}).listen(port, '0.0.0.0', () => {
  console.log(`OpenAI-compatible mock listening on ${port}`)
})
