/**
 * Disposable assembled-profile transport for the manual DSH acceptance run.
 *
 * Loaded with `node --import` only in the isolated proof process. It prevents
 * all OpenAI network access, supplies obviously fake OAuth data, and records
 * only non-secret protocol facts. It is not included in the npm package.
 */
import { appendFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const realFetch = globalThis.fetch
const tracePath = process.env.DOCX_FAKE_TRACE
let devicePolls = 0
let modelCalls = 0

globalThis.fetch = async function assembledFakeFetch(input, init) {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url

  if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
    trace({ kind: 'oauth-device-start', network: 'intercepted' })
    return json({ device_auth_id: 'fake-device-id', user_code: 'SAFE-DEMO', interval: 1 })
  }

  if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
    devicePolls += 1
    trace({ kind: 'oauth-device-poll', attempt: devicePolls, network: 'intercepted' })
    if (devicePolls < 4) return json({ error: 'deviceauth_authorization_pending' }, 403)
    return json({ authorization_code: 'fake-authorization-code', code_verifier: 'fake-code-verifier' })
  }

  if (url === 'https://auth.openai.com/oauth/token') {
    trace({ kind: 'oauth-token-exchange', network: 'intercepted' })
    return json({
      access_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_safe_demo' } }),
      refresh_token: 'fake-refresh-token',
      expires_in: 3600,
    })
  }

  if (url === 'https://chatgpt.com/backend-api/codex/responses') {
    modelCalls += 1
    const headers = new Headers(init?.headers)
    const body = decodeBody(init?.body, headers)
    const inputJson = JSON.stringify(body.input ?? [])
    trace({
      kind: 'codex-request',
      call: modelCalls,
      network: 'intercepted',
      path: new URL(url).pathname,
      model: body.model,
      originator: headers.get('originator'),
      piUserAgent: (headers.get('user-agent') ?? '').startsWith('pi ('),
      toolNames: Array.isArray(body.tools) ? body.tools.map(tool => tool?.name).filter(Boolean) : [],
      hasToolResult: inputJson.includes('function_call_output'),
    })
    return new Response(modelCalls === 1 ? toolCallSse() : finalTextSse(), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': `request_safe_demo_${modelCalls}`,
      },
    })
  }

  throw new Error(`assembled fake transport blocked unexpected network request: ${new URL(url).origin}`)
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function decodeBody(body, headers) {
  if (typeof body === 'string') return JSON.parse(body)
  if (body instanceof Uint8Array) {
    const bytes = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(body) : body
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  }
  throw new Error(`assembled fake transport received an unsupported body: ${Object.prototype.toString.call(body)}`)
}

function toolCallSse() {
  const args = JSON.stringify({ file_path: 'README.md', offset: 1, limit: 3 })
  const item = { id: 'fc_safe_demo', type: 'function_call', call_id: 'call_safe_demo', name: 'read', arguments: args }
  return sse([
    { type: 'response.created', response: { id: 'resp_safe_tool', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: args },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: args },
    { type: 'response.output_item.done', output_index: 0, item },
    completed('resp_safe_tool', [item], 31, 14),
  ])
}

function finalTextSse() {
  const text = 'Fake Codex round trip complete: the README tool result returned through DSH.'
  const item = { id: 'msg_safe_demo', type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
  return sse([
    { type: 'response.created', response: { id: 'resp_safe_final', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    completed('resp_safe_final', [item], 48, 18),
  ])
}

function completed(id, output, inputTokens, outputTokens) {
  return {
    type: 'response.completed',
    response: {
      id,
      status: 'completed',
      model: 'gpt-5.4',
      output,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  }
}

function sse(events) {
  return `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
}

function fakeJwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.fake-signature`
}

function trace(record) {
  if (tracePath === undefined) return
  appendFileSync(tracePath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8')
}

export { realFetch }
