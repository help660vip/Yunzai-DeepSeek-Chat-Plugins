import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { DeepSeekApiService, normalizeUsage } from '../services/api.js'

const messages = [{ role: 'user', content: 'hello' }]
const data = { choices: [{ message: { content: '你好' } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
const service = fetch => new DeepSeekApiService({ apiKey: 'test-key', maxRetry: 3, maxTokens: 100, baseRetryDelay: 0, fetch, wait: async () => {} })

test('every request has a clamped output cap and an abort signal', async () => {
  const api = service(async (url, options) => {
    assert.equal(JSON.parse(options.body).max_tokens, 100)
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(url.endsWith('//chat/completions'), false)
    return Response.json(data)
  })
  api.config.baseUrl = 'https://example.com///'
  assert.equal((await api.request(messages, { maxTokens: 200 })).content, '你好')
})

test('permanent client errors are not retried', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let calls = 0
    const api = service(async () => { calls++; return new Response('error', { status }) })
    await assert.rejects(api.request(messages), { status })
    assert.equal(calls, 1)
  }
})

test('transient retries reserve a budget before each attempt', async () => {
  const events = []
  const api = service(async () => {
    events.push('fetch')
    return events.filter(x => x === 'fetch').length === 1 ? new Response('', { status: 503 }) : Response.json(data)
  })
  await api.request(messages, { beforeAttempt: () => events.push('reserve') })
  assert.deepEqual(events, ['reserve', 'fetch', 'reserve', 'fetch'])
})

test('quota failure during a retry prevents another network request', async () => {
  let fetches = 0
  let reserves = 0
  const api = service(async () => { fetches++; return new Response('', { status: 429 }) })
  await assert.rejects(api.request(messages, { beforeAttempt: () => {
    if (++reserves === 2) throw Object.assign(new Error('quota'), { code: 'DAILY_BUDGET' })
  } }), { code: 'DAILY_BUDGET' })
  assert.equal(fetches, 1)
})

test('invalid successful response is not retried and reported usage is retained', async () => {
  let calls = 0
  let reported
  const api = service(async () => { calls++; return Response.json({ usage: data.usage, choices: [] }) })
  await assert.rejects(api.request(messages, { onUsage: usage => { reported = usage } }), /数据格式错误/)
  assert.equal(calls, 1)
  assert.deepEqual(reported, data.usage)
  assert.equal(normalizeUsage({ total_tokens: '12', prompt_tokens: 10, completion_tokens: 2 }), null)
})

test('timeout aborts response body reading and does not resend the request', async t => {
  let calls = 0
  const server = http.createServer((req, res) => {
    calls++
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const api = new DeepSeekApiService({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 200, maxRetry: 3 })
  const started = Date.now()
  await assert.rejects(api.request(messages), error => error.name === 'AbortError')
  assert.equal(calls, 1)
  assert.ok(Date.now() - started < 3000)
})

test('master default omits normal output cap and supports an optional provider-specific cap', async () => {
  const bodies = []
  const api = service(async (url, options) => { bodies.push(JSON.parse(options.body)); return Response.json(data) })
  api.config.masterMaxTokens = null
  await api.request(messages, { isMaster: true })
  assert.equal(Object.hasOwn(bodies[0], 'max_tokens'), false)
  api.config.masterMaxTokens = 8000
  await api.request(messages, { isMaster: true })
  assert.equal(bodies[1].max_tokens, 8000)
  await api.request(messages, { isMaster: 'true' })
  assert.equal(bodies[2].max_tokens, 100)
})

test('master long response uses its longer timeout and still aborts a stalled request', async () => {
  const api = service(async (url, options) => new Promise((resolve, reject) => {
    const responseTimer = setTimeout(() => resolve(Response.json(data)), 50)
    options.signal.addEventListener('abort', () => {
      clearTimeout(responseTimer)
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  }))
  api.config.timeoutMs = 10
  api.config.masterTimeoutMs = 500
  assert.equal((await api.request(messages, { isMaster: true })).content, '你好')
  api.config.masterTimeoutMs = 10
  await assert.rejects(api.request(messages, { isMaster: true }), { name: 'AbortError' })
})
