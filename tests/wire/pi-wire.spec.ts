import { zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Credential, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { OpenAICodexAdapter } from '../../src/adapter.ts'
import type { DshPiCredentialStore } from '../../src/auth/credential-store.ts'

const ACCOUNT = 'acct_fake_wire'
const TOKEN = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT } })
const REFRESH = 'fake-refresh-wire-never-log'

afterEach(() => { vi.unstubAllGlobals() })

class WireStore implements CredentialStore {
  credential: OAuthCredential = {
    type: 'oauth',
    access: TOKEN,
    refresh: REFRESH,
    expires: Date.now() + 3_600_000,
    accountId: ACCOUNT,
  }

  async read(): Promise<Credential> { return this.credential }
  async list() { return [{ providerId: 'openai-codex', type: 'oauth' as const }] }
  async modify(_provider: string, callback: (current: Credential | undefined) => Promise<Credential | undefined>) {
    const next = await callback(this.credential)
    if (next !== undefined && next.type === 'oauth') this.credential = next
    return this.credential
  }
  async delete(): Promise<void> {}
}

function dshRequest(signal?: AbortSignal): GenerateOptions {
  const user = {
    id: 'message-wire' as Message['id'],
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Say hello and use lookup if needed.' }],
  } as Message
  return {
    provider: 'openai-codex',
    model: 'gpt-5.4',
    system: 'You are a concise wire-test assistant.',
    messages: [user],
    tools: [{
      name: 'lookup',
      description: 'Look up one value',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }],
    reasoningEffort: ReasoningEffortId('high'),
    ...(signal === undefined ? {} : { signal }),
  }
}

const ORDERED_ROLES = ['system', 'system', 'system', 'system', 'user', 'user', 'user', 'user', 'system'] as const

function orderedDshRequest(reasoningEffort = ReasoningEffortId('xhigh')): GenerateOptions {
  return {
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    reasoningEffort,
    messages: ORDERED_ROLES.map((role, index) => ({
      id: `ordered-wire-${index}` as Message['id'],
      role,
      source: { kind: 'plugin', plugin: 'recursus-dsh-ordered-parts-v1' },
      content: [{ type: 'text', text: `{"ordinal":${index}}` }],
    })) as Message[],
    tools: [],
    maxTokens: 4_000,
    sessionId: 'rc5-fact-01' as GenerateOptions['sessionId'],
  }
}

function successSse(): string {
  const events = [
    { type: 'response.created', response: { id: 'resp_fake_wire', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_fake', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_fake', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] } },
    {
      type: 'response.completed',
      response: {
        id: 'resp_fake_wire',
        status: 'completed',
        model: 'gpt-5.4',
        output: [{ id: 'msg_fake', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
        usage: {
          input_tokens: 7,
          output_tokens: 2,
          total_tokens: 9,
          input_tokens_details: { cached_tokens: 1 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    },
  ]
  return `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
}

describe('Pi direct Codex wire', () => {
  it('uses Pi request construction and turns real SSE events into DSH chunks', async () => {
    let capturedUrl = ''
    let capturedHeaders = new Headers()
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input)
      capturedHeaders = new Headers(init?.headers)
      capturedBody = decodeRequestBody(init?.body, capturedHeaders)
      return new Response(successSse(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'request_fake_wire' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const subject = new OpenAICodexAdapter({
      credentials: new WireStore() as unknown as DshPiCredentialStore,
      timeoutMs: 5_000,
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of subject.stream(dshRequest())) chunks.push(chunk)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(capturedUrl).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(capturedHeaders.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(capturedHeaders.get('chatgpt-account-id')).toBe(ACCOUNT)
    expect(capturedHeaders.get('originator')).toBe('pi')
    expect(capturedHeaders.get('user-agent')).toMatch(/^pi \(/)
    expect(capturedHeaders.get('accept')).toBe('text/event-stream')
    expect(capturedBody).toMatchObject({
      model: 'gpt-5.4',
      instructions: 'You are a concise wire-test assistant.',
      reasoning: { effort: 'high' },
    })
    expect(JSON.stringify(capturedBody)).toContain('Say hello and use lookup if needed.')
    expect(capturedBody.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'lookup' })]))
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: { responseId: 'resp_fake_wire' } } })
    expect(JSON.stringify(chunks)).not.toContain(TOKEN)
    expect(JSON.stringify(chunks)).not.toContain(REFRESH)
  })

  it('preserves the bounded ordered system/user request in Pi’s final wire payload', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      capturedBody = decodeRequestBody(init?.body, headers)
      return new Response(successSse(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'request_fake_ordered' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const subject = new OpenAICodexAdapter({
      credentials: new WireStore() as unknown as DshPiCredentialStore,
      timeoutMs: 5_000,
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of subject.stream(orderedDshRequest())) chunks.push(chunk)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(capturedBody.input).toEqual(ORDERED_ROLES.map((role, index) => ({
      role,
      content: [{ type: 'input_text', text: `{"ordinal":${index}}` }],
    })))
    expect(Object.hasOwn(capturedBody, 'instructions')).toBe(false)
    expect(Object.hasOwn(capturedBody, 'tools')).toBe(false)
    expect(capturedBody.max_output_tokens).toBe(4_000)
    expect(capturedBody.tool_choice).toBe('none')
    expect(capturedBody.parallel_tool_calls).toBe(false)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('does not retry a failed ordered provider request', async () => {
    const fetchMock = vi.fn(async () => new Response('fake provider failure', {
      status: 503,
      headers: { 'content-type': 'text/plain', 'x-request-id': 'request_fake_failure' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const subject = new OpenAICodexAdapter({
      credentials: new WireStore() as unknown as DshPiCredentialStore,
      timeoutMs: 5_000,
    })
    const chunks: StreamChunk[] = []
    let failure: unknown
    try {
      for await (const chunk of subject.stream(orderedDshRequest())) chunks.push(chunk)
    } catch (error: unknown) {
      failure = error
    }

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(failure ?? chunks.at(-1)).toBeDefined()
    expect(JSON.stringify(failure ?? chunks)).not.toContain(TOKEN)
    expect(JSON.stringify(failure ?? chunks)).not.toContain(REFRESH)
  })

  it('validates Pi’s model-specific reasoning mapping before ordered transport', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = decodeRequestBody(init?.body, new Headers(init?.headers))
      return new Response(successSse(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'request_fake_reasoning' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const subject = new OpenAICodexAdapter({
      credentials: new WireStore() as unknown as DshPiCredentialStore,
      timeoutMs: 5_000,
    })
    for await (const _chunk of subject.stream(orderedDshRequest(ReasoningEffortId('minimal')))) {}

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(capturedBody.reasoning).toEqual({ effort: 'low', summary: 'auto' })
  })

  it('propagates caller abort to the underlying Pi fetch', async () => {
    let underlyingSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      underlyingSignal = init?.signal === null ? undefined : init?.signal
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const subject = new OpenAICodexAdapter({
      credentials: new WireStore() as unknown as DshPiCredentialStore,
      timeoutMs: 5_000,
    })
    const collecting = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of subject.stream(dshRequest(controller.signal))) chunks.push(chunk)
      return chunks
    })()
    while (fetchMock.mock.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort('fake-abort-secret')
    const chunks = await collecting
    expect(underlyingSignal?.aborted).toBe(true)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(JSON.stringify(chunks)).not.toContain('fake-abort-secret')
    expect(JSON.stringify(chunks)).not.toContain(TOKEN)
  })
})

function decodeRequestBody(body: BodyInit | null | undefined, headers: Headers): Record<string, unknown> {
  if (typeof body === 'string') return JSON.parse(body) as Record<string, unknown>
  if (body instanceof Uint8Array) {
    const bytes = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(body) : body
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>
  }
  throw new Error(`unexpected Pi request body: ${Object.prototype.toString.call(body)}`)
}

function jwt(payload: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.fake-signature`
}
