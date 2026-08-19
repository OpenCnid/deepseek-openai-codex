import { describe, expect, it } from 'vitest'
import type { CredentialStore } from '@earendil-works/pi-ai'
import { LlmError, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import { OpenAICodexAdapter } from '../../src/adapter.ts'
import type { DshPiCredentialStore } from '../../src/auth/credential-store.ts'
import { classifyProviderFailure, safeAuthFailure, safeLlmError } from '../../src/errors.ts'

const EMPTY_STORE: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async (_provider, callback) => callback(undefined),
  delete: async () => undefined,
}

function adapter(): OpenAICodexAdapter {
  return new OpenAICodexAdapter({
    credentials: EMPTY_STORE as DshPiCredentialStore,
    timeoutMs: 1_000,
  })
}

function emptyRequest(extras: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'openai-codex', model: 'gpt-5.4', messages: [], ...extras }
}

describe('OpenAICodexAdapter catalog and policy', () => {
  it('exposes only the Pi-installed openai-codex catalog and exact resolution metadata', async () => {
    const subject = adapter()
    const models = await subject.listModels('openai-codex')
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(model => model.provider === 'openai-codex')).toBe(true)
    const resolved = await subject.resolveModel('openai-codex', models[0]?.id ?? '')
    expect(resolved).toMatchObject({ provider: 'openai-codex', id: models[0]?.id })
    expect(resolved.context.contextWindow).toBeGreaterThan(0)
    expect(() => subject.providerInfo('openai')).toThrow(expect.objectContaining({ code: 'NO_ADAPTER' }))
    expect(() => subject.resolveModel('openai-codex', 'not-a-model')).toThrow(expect.objectContaining({ code: 'UNKNOWN_MODEL' }))
  })

  it('rejects unsupported options, reasoning levels, missing images, and disposed use', async () => {
    const subject = adapter()
    const collect = async (options: GenerateOptions) => {
      for await (const _chunk of subject.stream(options)) {}
    }
    await expect(collect(emptyRequest({ stop: ['stop'] }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    await expect(collect(emptyRequest({ reasoningEffort: 'impossible' as GenerateOptions['reasoningEffort'] }))).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    const image = { id: 'image-1', mediaType: 'image/png' }
    const message = { id: 'm' as Message['id'], role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: image }] } as Message
    await expect(collect(emptyRequest({ messages: [message] }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    subject.dispose()
    await expect(collect(emptyRequest())).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})

describe('safe error classification', () => {
  it.each([
    [401, 'AUTH'],
    [403, 'PERMISSION'],
    [429, 'RATE_LIMIT'],
    [408, 'TIMEOUT'],
    [400, 'INVALID_REQUEST'],
    [503, 'UNAVAILABLE'],
  ])('maps HTTP %i to %s', (status, code) => {
    expect(classifyProviderFailure('', status)).toBe(code)
  })

  it('drops raw messages, causes, and secret abort reasons from LLM errors', () => {
    const secret = 'fake-token-never-log'
    const cause = new Error(secret)
    const mapped = safeLlmError(Object.assign(new Error(`HTTP 401 ${secret}`, { cause }), { status: 401, requestId: 'request-safe' }))
    expect(mapped).toMatchObject({ code: 'AUTH', failure: { status: 401 } })
    expect(String(mapped)).not.toContain(secret)
    expect(JSON.stringify(mapped)).not.toContain(secret)
    expect(safeLlmError(new Error(secret), true)).toMatchObject({ code: 'ABORTED' })

    const nested = safeLlmError(new LlmError(secret, 'UNSUPPORTED_CONTENT', { cause }))
    expect(nested).toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(String(nested)).not.toContain(secret)
    expect(JSON.stringify(nested)).not.toContain(secret)
  })

  it('returns stable secret-free authentication failures', () => {
    const result = safeAuthFailure(new Error('HTTP 403 fake-account-and-token'))
    expect(result).toEqual({ code: 'PLAN_INELIGIBLE', message: 'OpenAI refused subscription access; check ChatGPT plan eligibility' })
    expect(JSON.stringify(result)).not.toContain('fake-account')
  })
})
