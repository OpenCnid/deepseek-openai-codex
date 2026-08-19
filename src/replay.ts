/* Adapted from DeepSeek Harness dsh-llm-pi-ai (MIT); see THIRD_PARTY_NOTICES.md. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Message, ModelMessageSource, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import type { Api, AssistantMessage, Usage as PiUsage } from '@earendil-works/pi-ai'

export type PiReplayBlock =
  | { type: 'text'; textSignature?: string }
  | { type: 'reasoning'; thinkingSignature?: string; redacted?: boolean }
  | { type: 'tool-call'; thoughtSignature?: string }

export interface PiReplayResponse {
  kind: 'pi-ai'
  version: 2
  api: Api
  provider: string
  model: string
  responseModel?: string
  responseId?: string
  stopReason: AssistantMessage['stopReason']
}

interface PiReplayState {
  response: PiReplayResponse
  blocks: PiReplayBlock[]
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {}
  return {}
}

function emptyUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/** Project only provider-native metadata needed for a correct continuation. */
export function toPiReplayState(message: AssistantMessage): ReplayEnvelope {
  return {
    response: {
      kind: 'pi-ai',
      version: 2,
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
      ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
      stopReason: message.stopReason,
    } satisfies PiReplayResponse,
    blocks: message.content.map((block): PiReplayBlock => {
      switch (block.type) {
        case 'text': return { type: 'text', ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }) }
        case 'thinking': return {
          type: 'reasoning',
          ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
          ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
        }
        case 'toolCall': return { type: 'tool-call', ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }) }
      }
    }),
  }
}

function invalidReplay(detail: string): never {
  throw new LlmError(`invalid Pi replay state: ${detail}`, 'INVALID_REPLAY_STATE')
}

function readReplayState(value: unknown): PiReplayState {
  if (!isRecord(value)) return invalidReplay('expected an envelope')
  const rawResponse = value['response']
  if (!isRecord(rawResponse)) return invalidReplay('expected a response object')
  if (rawResponse['kind'] !== 'pi-ai' || rawResponse['version'] !== 2) return invalidReplay('unsupported state kind or version')
  for (const key of ['api', 'provider', 'model'] as const) {
    if (typeof rawResponse[key] !== 'string' || rawResponse[key].length === 0) return invalidReplay(`${key} must be non-empty`)
  }
  if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(rawResponse['stopReason']))) return invalidReplay('unknown stop reason')
  if (rawResponse['responseModel'] !== undefined && typeof rawResponse['responseModel'] !== 'string') return invalidReplay('invalid response model')
  if (rawResponse['responseId'] !== undefined && typeof rawResponse['responseId'] !== 'string') return invalidReplay('invalid response id')
  const blocks = value['blocks']
  if (!Array.isArray(blocks)) return invalidReplay('blocks must be an array')
  for (const [index, entry] of blocks.entries()) {
    if (!isRecord(entry) || !['text', 'reasoning', 'tool-call'].includes(String(entry['type']))) return invalidReplay(`invalid block ${index}`)
    for (const signature of ['textSignature', 'thinkingSignature', 'thoughtSignature'] as const) {
      if (entry[signature] !== undefined && typeof entry[signature] !== 'string') return invalidReplay(`invalid block ${index} signature`)
    }
    if (entry['redacted'] !== undefined && typeof entry['redacted'] !== 'boolean') return invalidReplay(`invalid block ${index} redaction`)
  }
  return { response: rawResponse as unknown as PiReplayResponse, blocks: blocks as PiReplayBlock[] }
}

function foreignAssistant(message: Message): AssistantMessage {
  const source = message.source.kind === 'model' ? message.source : undefined
  const content: AssistantMessage['content'] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break
      case 'reasoning': content.push({ type: 'thinking', thinking: block.text }); break
      case 'tool-call': content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) }); break
      case 'image': throw new LlmError('OpenAI Codex history cannot represent assistant image output', 'UNSUPPORTED_CONTENT')
      default: break
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'dsh-foreign',
    provider: source?.provider ?? 'dsh-foreign',
    model: source?.model ?? 'dsh-foreign',
    usage: emptyUsage(),
    stopReason: content.some(piece => piece.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

function replayedAssistant(message: Message, source: ModelMessageSource, rawState: unknown): AssistantMessage {
  const state = readReplayState(rawState)
  if (state.response.provider !== source.provider || state.response.model !== source.model) return invalidReplay('route does not match source')
  if (state.blocks.length !== message.content.length) return invalidReplay('block count does not match content')
  const content: AssistantMessage['content'] = message.content.map((block, index) => {
    const replay = state.blocks[index]
    if (replay === undefined || replay.type !== block.type) return invalidReplay(`block ${index} does not match content`)
    switch (block.type) {
      case 'text': return { type: 'text', text: block.text, ...(replay.type === 'text' && replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {}) }
      case 'reasoning': return {
        type: 'thinking',
        thinking: block.text,
        ...(replay.type === 'reasoning' && replay.thinkingSignature !== undefined ? { thinkingSignature: replay.thinkingSignature } : {}),
        ...(replay.type === 'reasoning' && replay.redacted !== undefined ? { redacted: replay.redacted } : {}),
      }
      case 'tool-call': return {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
        ...(replay.type === 'tool-call' && replay.thoughtSignature !== undefined ? { thoughtSignature: replay.thoughtSignature } : {}),
      }
      default: return invalidReplay(`unsupported block ${index}`)
    }
  })
  return {
    role: 'assistant',
    content,
    api: state.response.api,
    provider: state.response.provider,
    model: state.response.model,
    ...(state.response.responseModel === undefined ? {} : { responseModel: state.response.responseModel }),
    ...(state.response.responseId === undefined ? {} : { responseId: state.response.responseId }),
    usage: emptyUsage(),
    stopReason: state.response.stopReason,
    timestamp: 0,
  }
}

/** Rebuild native Pi history when replay metadata validates, otherwise degrade safely. */
export function toPiAssistant(message: Message, onDegrade?: (reason: string) => void): AssistantMessage {
  const source = message.source
  if (source.kind !== 'model' || source.replayState === undefined) return foreignAssistant(message)
  try {
    return replayedAssistant(message, source, source.replayState)
  } catch (error: unknown) {
    if (!(error instanceof LlmError) || error.code !== 'INVALID_REPLAY_STATE') throw error
    onDegrade?.(error.message)
    return foreignAssistant(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
