import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import {
  OPENAI_CODEX_TRANSPORT_CAPABILITIES,
  ORDERED_SYSTEM_USER_MESSAGES_CAPABILITY,
} from '../../src/index.ts'
import {
  needsOrderedSystemUserProjection,
  orderedSystemUserOnPayload,
  patchOrderedSystemUserPayload,
  projectOrderedSystemUserMessages,
} from '../../src/ordered-messages.ts'

const ROLES = ['system', 'system', 'system', 'system', 'user', 'user', 'user', 'user', 'system'] as const

function message(role: Message['role'], text: string, index: number): Message {
  return {
    id: `ordered-${index}` as Message['id'],
    role,
    source: { kind: 'plugin', plugin: 'recursus-dsh-ordered-parts-v1' },
    content: [{ type: 'text', text }],
  } as Message
}

function request(extras: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh' as GenerateOptions['reasoningEffort'],
    messages: ROLES.map((role, index) => message(role, `{"ordinal":${index}}`, index)),
    tools: [],
    maxTokens: 4_000,
    sessionId: 'rc5-fact-01' as GenerateOptions['sessionId'],
    ...extras,
  }
}

function piPayload(options: GenerateOptions = request()): Record<string, unknown> {
  return {
    model: options.model,
    store: false,
    stream: true,
    instructions: options.system === undefined || options.system.length === 0
      ? 'You are a helpful assistant.'
      : options.system,
    input: options.messages.map(item => ({
      role: 'user',
      content: [{ type: 'input_text', text: (item.content[0] as { text: string }).text }],
    })),
    text: { verbosity: 'low' },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: options.sessionId === undefined ? undefined : String(options.sessionId),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    ...(options.reasoningEffort === undefined || options.reasoningEffort === 'off'
      ? {}
      : { reasoning: { effort: options.reasoningEffort, summary: 'auto' } }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  }
}

describe('ordered system/user Codex projection', () => {
  it('exports the machine-readable capability and preserves all nine exact messages', () => {
    expect(ORDERED_SYSTEM_USER_MESSAGES_CAPABILITY).toBe('ordered_system_user_messages_v1')
    expect(OPENAI_CODEX_TRANSPORT_CAPABILITIES).toEqual({ ordered_system_user_messages_v1: true })
    const options = request()
    expect(needsOrderedSystemUserProjection(options)).toBe(true)
    expect(projectOrderedSystemUserMessages(options)).toEqual(ROLES.map((role, index) => ({
      role,
      content: [{ type: 'input_text', text: `{"ordinal":${index}}` }],
    })))
  })

  it('removes Pi default instructions and locks the final no-tools payload', () => {
    const options = request()
    const projected = projectOrderedSystemUserMessages(options)
    const patched = patchOrderedSystemUserPayload(options, piPayload(options))
    expect(patched['input']).toEqual(projected)
    expect((patched['input'] as Array<{ role: string }>).map(item => item.role)).toEqual(ROLES)
    expect(Object.hasOwn(patched, 'instructions')).toBe(false)
    expect(Object.hasOwn(patched, 'tools')).toBe(false)
    expect(patched['tool_choice']).toBe('none')
    expect(patched['parallel_tool_calls']).toBe(false)
    expect(patched['max_output_tokens']).toBe(4_000)
  })

  it('preserves an explicit logged system slot and leaves ordinary user-only traffic unchanged', () => {
    const withSystem = request({ system: 'Explicit logged system slot' })
    const patch = orderedSystemUserOnPayload(withSystem)
    expect(patch).toBeTypeOf('function')
    if (patch === undefined) throw new Error('expected ordered payload hook')
    expect((patch(piPayload(withSystem)) as Record<string, unknown>)['instructions']).toBe('Explicit logged system slot')

    const userOnly = request({ messages: [message('user', 'ordinary', 0)] })
    expect(needsOrderedSystemUserProjection(userOnly)).toBe(false)
    expect(orderedSystemUserOnPayload(userOnly)).toBeUndefined()
  })

  it('validates Pi’s effective reasoning effort after model-specific mapping', () => {
    const options = request({ reasoningEffort: 'minimal' as GenerateOptions['reasoningEffort'] })
    const payload = piPayload(options)
    const reasoning = payload['reasoning'] as Record<string, unknown>
    reasoning['effort'] = 'low'
    expect(patchOrderedSystemUserPayload(options, payload, 'low')['reasoning']).toEqual({ effort: 'low', summary: 'auto' })
  })

  it.each([
    ['omission', (value: Record<string, unknown>) => { (value['input'] as unknown[]).pop() }],
    ['reordering', (value: Record<string, unknown>) => {
      const input = value['input'] as unknown[]
      const first = input[0]
      input[0] = input[1]
      input[1] = first
    }],
    ['role rewrite', (value: Record<string, unknown>) => {
      ((value['input'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['role'] = 'assistant'
    }],
    ['aggregation', (value: Record<string, unknown>) => {
      const input = value['input'] as Array<Record<string, unknown>>
      const first = input[0]
      if (first === undefined) throw new Error('expected first Pi input item')
      const content = first['content'] as Array<Record<string, unknown>>
      const firstBlock = content[0]
      if (firstBlock === undefined) throw new Error('expected first Pi input text block')
      firstBlock['text'] = '{"ordinal":0}{"ordinal":1}'
      input.splice(1, 1)
    }],
  ])('rejects Pi intermediate %s before transport', (_label, mutate) => {
    const options = request()
    const payload = structuredClone(piPayload(options))
    mutate(payload)
    expect(() => patchOrderedSystemUserPayload(options, payload)).toThrow(expect.objectContaining({ code: 'INTEGRATION' }))
  })

  it.each([
    ['hidden prompt', (value: Record<string, unknown>) => { value['prompt'] = { id: 'hidden' } }],
    ['previous response', (value: Record<string, unknown>) => { value['previous_response_id'] = 'resp_hidden' }],
    ['changed instruction', (value: Record<string, unknown>) => { value['instructions'] = 'HIDDEN' }],
    ['unknown payload field', (value: Record<string, unknown>) => { value['metadata'] = { hidden: true } }],
  ])('rejects alternate Pi context: %s', (_label, mutate) => {
    const options = request()
    const payload = structuredClone(piPayload(options))
    mutate(payload)
    expect(() => patchOrderedSystemUserPayload(options, payload)).toThrow(expect.objectContaining({ code: 'INTEGRATION' }))
  })

  it.each([
    ['assistant history', (value: GenerateOptions) => { value.messages[4] = message('assistant', 'changed', 4) }],
    ['model-facing tool', (value: GenerateOptions) => { value.tools = [{ name: 'read', description: 'read', parameters: {} }] }],
    ['multiple text blocks', (value: GenerateOptions) => { value.messages[4]!.content.push({ type: 'text', text: 'second' }) }],
    ['unknown content block', (value: GenerateOptions) => { value.messages[4]!.content[0] = { type: 'reasoning', text: 'hidden' } }],
    ['unknown request option', (value: GenerateOptions) => { (value as GenerateOptions & { prompt: string }).prompt = 'hidden' }],
    ['missing output cap', (value: GenerateOptions) => { delete value.maxTokens }],
    ['zero output cap', (value: GenerateOptions) => { value.maxTokens = 0 }],
    ['over-limit output cap', (value: GenerateOptions) => { value.maxTokens = 4_001 }],
    ['truncated session cache key', (value: GenerateOptions) => {
      value.sessionId = 'x'.repeat(65) as GenerateOptions['sessionId']
    }],
  ])('rejects unsupported DSH shape: %s', (_label, mutate) => {
    const options = structuredClone(request())
    mutate(options)
    expect(() => projectOrderedSystemUserMessages(options)).toThrow()
  })
})
