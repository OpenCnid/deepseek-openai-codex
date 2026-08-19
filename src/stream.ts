/* Adapted from DeepSeek Harness dsh-llm-pi-ai (MIT); see THIRD_PARTY_NOTICES.md. */
import {
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmError,
  isContextWindowExceededError,
  CONTEXT_WINDOW_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { classifyProviderFailure, safeLlmMessage } from './errors.ts'
import { toPiReplayState } from './replay.ts'

export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  }
}

/** Map a Pi terminal value without exposing provider error bodies. */
export function mapStopReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  if (isContextOverflow(message, contextWindow)
    || (message.stopReason === 'error' && message.errorMessage !== undefined && isContextWindowExceededError(message.errorMessage))) {
    return { kind: 'error', failure: { message: 'OpenAI Codex context window was exceeded; shorten the conversation or compact it', code: CONTEXT_WINDOW_EXCEEDED_CODE } }
  }
  switch (message.stopReason) {
    case 'stop':
      return message.content.length === 0
        ? { kind: 'error', failure: { message: 'OpenAI Codex completed without usable content; retry the request', code: EMPTY_RESPONSE_CODE } }
        : { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'aborted': return { kind: 'aborted', failure: { message: safeLlmMessage('ABORTED'), code: 'ABORTED' } }
    case 'error': {
      const code = classifyProviderFailure(message.errorMessage ?? '')
      const failure = {
        message: safeLlmMessage(code),
        code,
        ...(message.responseId === undefined ? {} : { requestId: message.responseId as never }),
      }
      return code === 'ABORTED' ? { kind: 'aborted', failure } : { kind: 'error', failure }
    }
  }
  return { kind: 'error', failure: { message: safeLlmMessage('MALFORMED_RESPONSE'), code: 'MALFORMED_RESPONSE' } }
}

/** Translate the complete Pi event vocabulary into DSH chunks. */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
): AsyncGenerator<StreamChunk> {
  const toolIds = new Map<number, { id: string; name: string }>()
  for await (const event of events) {
    switch (event.type) {
      case 'start': break
      case 'text_start': yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }; break
      case 'text_delta': yield { type: 'text-delta', index: event.contentIndex, text: event.delta }; break
      case 'text_end': yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }; break
      case 'thinking_start': yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }; break
      case 'thinking_delta': yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }; break
      case 'thinking_end': yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }; break
      case 'toolcall_start': {
        const partial = event.partial.content[event.contentIndex]
        toolIds.set(event.contentIndex, {
          id: partial?.type === 'toolCall' ? partial.id : '',
          name: partial?.type === 'toolCall' ? partial.name : '',
        })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: CallId(known?.id ?? ''),
          ...(known?.name === undefined || known.name.length === 0 ? {} : { name: known.name }),
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: CallId(event.toolCall.id),
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield { type: 'finish', reason: mapStopReason(event.message, contextWindow), replayState: toPiReplayState(event.message) }
        return
      case 'error':
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield { type: 'finish', reason: mapStopReason(event.error, contextWindow) }
        return
    }
  }
  throw new LlmError('OpenAI Codex stream ended without a terminal provider event', 'MALFORMED_RESPONSE')
}
