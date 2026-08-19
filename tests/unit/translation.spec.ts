import { describe, expect, it } from 'vitest'
import { CallId, LlmError } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { toPiContext } from '../../src/context.ts'
import { toPiAssistant, toPiReplayState } from '../../src/replay.ts'
import { mapStopReason, mapUsage, toStreamChunks } from '../../src/stream.ts'

function message(role: Message['role'], content: Message['content'], source: Message['source'] = { kind: 'user' } as Message['source']): Message {
  return { id: `message-${Math.random()}` as Message['id'], role, content, source }
}

function request(messages: Message[], extras: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'openai-codex', model: 'gpt-5.4', messages, ...extras }
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.4',
    usage: {
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  }
}

async function* feed(...events: AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
  yield* events
}

describe('DSH to Pi context conversion', () => {
  it('converts system instructions, text, reasoning, tools, calls, and results', () => {
    const call = CallId('call-1')
    const history = [
      message('user', [{ type: 'text', text: 'Question' }]),
      message('assistant', [
        { type: 'reasoning', text: 'Think' },
        { type: 'text', text: 'Calling' },
        { type: 'tool-call', id: call, name: 'lookup', arguments: '{"q":"x"}' },
      ], { kind: 'model', provider: 'openai-codex', model: 'gpt-5.4' }),
      message('user', [{ type: 'tool-result', toolCallId: call, content: [{ type: 'text', text: 'Found' }] }], { kind: 'tool', name: 'lookup' } as Message['source']),
    ]
    const converted = toPiContext(request(history, {
      system: 'Be precise',
      tools: [{ name: 'lookup', description: 'Look up a value', parameters: { type: 'object' } }],
    }))
    expect(converted.systemPrompt).toBe('Be precise')
    expect(converted.tools).toEqual([{ name: 'lookup', description: 'Look up a value', parameters: { type: 'object' } }])
    expect(converted.messages).toMatchObject([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Think' },
        { type: 'text', text: 'Calling' },
        { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { q: 'x' } },
      ] },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'lookup', content: [{ type: 'text', text: 'Found' }] },
    ])
  })

  it('resolves DSH image attachments only through the attachment service', async () => {
    const ref = { id: 'image-1', mediaType: 'image/png' }
    const attachments = {
      readImage: async () => ({ ref, data: new Uint8Array([1, 2, 3]), width: 1, height: 1 }),
    } as unknown as AttachmentStore
    const converted = await toPiContext(request([
      message('user', [{ type: 'text', text: 'See ' }, { type: 'image', attachment: ref } as Message['content'][number]]),
    ]), attachments)
    expect(converted.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'See ' }, { type: 'image', data: 'AQID', mimeType: 'image/png' }],
    })
    expect(() => toPiContext(request([
      message('user', [{ type: 'image', attachment: ref } as Message['content'][number]]),
    ]))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })

  it('round trips native replay metadata and safely degrades invalid replay', () => {
    const pi = assistant({
      responseId: 'response-1',
      responseModel: 'gpt-5.4-2026-08-01',
      content: [
        { type: 'thinking', thinking: 'why', thinkingSignature: 'signed', redacted: false },
        { type: 'text', text: 'answer', textSignature: 'text-signed' },
      ],
    })
    const replay = toPiReplayState(pi)
    const dsh = message('assistant', [
      { type: 'reasoning', text: 'why' },
      { type: 'text', text: 'answer' },
    ], { kind: 'model', provider: 'openai-codex', model: 'gpt-5.4', replayState: replay })
    expect(toPiAssistant(dsh)).toMatchObject({
      responseId: 'response-1',
      content: [
        { type: 'thinking', thinkingSignature: 'signed' },
        { type: 'text', textSignature: 'text-signed' },
      ],
    })

    const reasons: string[] = []
    const degraded = toPiAssistant({
      ...dsh,
      source: { kind: 'model', provider: 'openai-codex', model: 'gpt-5.4', replayState: { response: { kind: 'bad' }, blocks: [] } },
    }, reason => { reasons.push(reason) })
    expect(degraded.api).toBe('dsh-foreign')
    expect(reasons).toHaveLength(1)
  })
})

describe('Pi to DSH stream conversion', () => {
  it('maps every content chunk class, usage, finish, and replay state', async () => {
    const partial = assistant({ content: [], stopReason: 'pending' })
    const final = assistant({
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'thinking', thinking: 'Reason' },
        { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { q: 'x' } },
      ],
    })
    const chunks = []
    for await (const chunk of toStreamChunks(feed(
      { type: 'start', partial },
      { type: 'text_start', contentIndex: 0, partial },
      { type: 'text_delta', contentIndex: 0, delta: 'Hello', partial },
      { type: 'text_end', contentIndex: 0, content: 'Hello', partial },
      { type: 'thinking_start', contentIndex: 1, partial },
      { type: 'thinking_delta', contentIndex: 1, delta: 'Reason', partial },
      { type: 'thinking_end', contentIndex: 1, content: 'Reason', partial },
      { type: 'toolcall_start', contentIndex: 2, partial: final },
      { type: 'toolcall_delta', contentIndex: 2, delta: '{"q":"x"}', partial: final },
      { type: 'toolcall_end', contentIndex: 2, toolCall: final.content[2] as Extract<AssistantMessage['content'][number], { type: 'toolCall' }>, partial: final },
      { type: 'done', reason: 'toolUse', message: final },
    ))) chunks.push(chunk)
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'text-delta', 'block-end',
      'block-start', 'reasoning-delta', 'block-end',
      'block-start', 'tool-call-delta', 'block-end',
      'usage', 'finish',
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' }, replayState: { response: { kind: 'pi-ai' } } })
  })

  it('maps terminal errors without exposing provider bodies', async () => {
    const failed = assistant({ stopReason: 'error', errorMessage: 'HTTP 429 fake-token provider detail', content: [] })
    const chunks = []
    for await (const chunk of toStreamChunks(feed({ type: 'error', reason: 'error', error: failed }))) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } })
    expect(JSON.stringify(chunks)).not.toContain('fake-token')
  })

  it('classifies stop reasons, context overflow, empty output, and usage', () => {
    expect(mapStopReason(assistant({ stopReason: 'length' }))).toEqual({ kind: 'max-tokens' })
    expect(mapStopReason(assistant({ stopReason: 'aborted', errorMessage: 'secret reason' }))).toMatchObject({ kind: 'aborted' })
    expect(mapStopReason(assistant({ content: [] }))).toMatchObject({ kind: 'error', failure: { code: 'EMPTY_RESPONSE' } })
    expect(mapStopReason(assistant({ stopReason: 'error', errorMessage: 'maximum context length' }))).toMatchObject({ failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } })
    expect(mapUsage(assistant().usage)).toEqual({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 1 })
  })

  it('fails a stream that ends without a terminal event', async () => {
    const collect = async () => {
      for await (const _chunk of toStreamChunks(feed({ type: 'start', partial: assistant({ stopReason: 'pending' }) }))) {}
    }
    await expect(collect()).rejects.toBeInstanceOf(LlmError)
    await expect(collect()).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})
