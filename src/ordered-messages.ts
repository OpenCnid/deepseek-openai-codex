import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

export const ORDERED_SYSTEM_USER_MESSAGES_CAPABILITY = 'ordered_system_user_messages_v1'

/** Machine-readable transport facts consumed by pinned integration probes. */
export const OPENAI_CODEX_TRANSPORT_CAPABILITIES = Object.freeze({
  [ORDERED_SYSTEM_USER_MESSAGES_CAPABILITY]: true,
})

const ALLOWED_OPTION_KEYS = new Set([
  'maxTokens',
  'messages',
  'model',
  'provider',
  'reasoningEffort',
  'sessionId',
  'signal',
  'system',
  'temperature',
  'tools',
])
const DEFAULT_PI_INSTRUCTIONS = 'You are a helpful assistant.'
const FORBIDDEN_CONTEXT_FIELDS = ['conversation', 'previous_response_id', 'prompt'] as const
const BASE_PI_PAYLOAD_KEYS = [
  'include',
  'input',
  'instructions',
  'model',
  'parallel_tool_calls',
  'prompt_cache_key',
  'store',
  'stream',
  'text',
  'tool_choice',
] as const

export interface CodexOrderedTextMessage {
  readonly role: 'system' | 'user'
  readonly content: readonly [{ readonly type: 'input_text', readonly text: string }]
}

/** Whether this request needs the bounded ordered-role wire projection. */
export function needsOrderedSystemUserProjection(options: GenerateOptions): boolean {
  return options.messages.some(message => message.role === 'system')
}

/**
 * Project the bounded DSH shape directly to Codex Responses input messages.
 * Every source message remains one wire message with one exact text block.
 */
export function projectOrderedSystemUserMessages(options: GenerateOptions): CodexOrderedTextMessage[] {
  assertAllowedOptions(options)
  if (!Array.isArray(options.messages) || options.messages.length === 0 ||
      !options.messages.some(message => message.role === 'system')) {
    unsupportedContent('Ordered system/user projection requires at least one system message')
  }
  if (options.tools !== undefined && (!Array.isArray(options.tools) || options.tools.length !== 0)) {
    unsupportedOption('Ordered system/user projection does not permit model-facing tools')
  }
  if (options.system !== undefined && typeof options.system !== 'string') {
    unsupportedOption('Ordered system/user projection received an invalid explicit system slot')
  }
  if (options.sessionId !== undefined && Array.from(String(options.sessionId)).length > 64) {
    unsupportedOption('Ordered system/user projection does not permit Pi to truncate the session cache key')
  }
  if (!Number.isInteger(options.maxTokens) || (options.maxTokens ?? 0) <= 0 || (options.maxTokens ?? 0) > 4_000) {
    unsupportedOption('Ordered system/user projection requires an explicit output-token limit from 1 through 4,000')
  }

  return options.messages.map((message, index) => projectMessage(message, index))
}

/** Build the public Pi payload hook only for requests containing system-role history. */
export function orderedSystemUserOnPayload(
  options: GenerateOptions,
  piReasoningEffort?: string,
): ((payload: unknown) => unknown) | undefined {
  if (!needsOrderedSystemUserProjection(options)) return undefined
  projectOrderedSystemUserMessages(options)
  return payload => patchOrderedSystemUserPayload(options, payload, piReasoningEffort)
}

/**
 * Replace only Pi's final model-visible prompt fields, rebuilding ordered
 * input from the validated DSH request after Pi creates its transport body.
 */
export function patchOrderedSystemUserPayload(
  options: GenerateOptions,
  payload: unknown,
  piReasoningEffort: string | undefined = options.reasoningEffort === 'off' ? undefined : options.reasoningEffort,
): Record<string, unknown> {
  const projected = projectOrderedSystemUserMessages(options)
  const record = plainRecord(payload)
  if (record === undefined || record['model'] !== options.model || record['store'] !== false || record['stream'] !== true) {
    integrationFailure('Pi produced an unexpected Codex request envelope')
  }
  const expectedPayloadKeys = [
    ...BASE_PI_PAYLOAD_KEYS,
    ...(piReasoningEffort === undefined ? [] : ['reasoning']),
    ...(options.temperature === undefined ? [] : ['temperature']),
  ].sort()
  if (canonicalJson(Object.keys(record).sort()) !== canonicalJson(expectedPayloadKeys)) {
    integrationFailure('Pi changed the supported Codex request fields')
  }
  if (FORBIDDEN_CONTEXT_FIELDS.some(field => Object.hasOwn(record, field)) || Object.hasOwn(record, 'tools')) {
    integrationFailure('Pi produced an alternate prompt, conversation, or tool surface')
  }
  const expectedPiInput = projected.map(item => ({ ...item, role: 'user' as const }))
  if (canonicalJson(record['input']) !== canonicalJson(expectedPiInput)) {
    integrationFailure('Pi changed ordered message count, order, role downgrade, or content')
  }
  const expectedPiInstructions = options.system === undefined || options.system.length === 0
    ? DEFAULT_PI_INSTRUCTIONS
    : options.system
  if (record['instructions'] !== expectedPiInstructions) {
    integrationFailure('Pi produced an unexpected leading instruction')
  }
  if (canonicalJson(record['text']) !== canonicalJson({ verbosity: 'low' }) ||
      canonicalJson(record['include']) !== canonicalJson(['reasoning.encrypted_content']) ||
      record['prompt_cache_key'] !== (options.sessionId === undefined ? undefined : String(options.sessionId)) ||
      record['tool_choice'] !== 'auto' || record['parallel_tool_calls'] !== true ||
      (options.temperature !== undefined && record['temperature'] !== options.temperature)) {
    integrationFailure('Pi changed a supported Codex request option')
  }
  if (piReasoningEffort !== undefined &&
      canonicalJson(record['reasoning']) !== canonicalJson({ effort: piReasoningEffort, summary: 'auto' })) {
    integrationFailure('Pi changed the requested reasoning boundary')
  }

  const next: Record<string, unknown> = {
    ...record,
    input: projected,
    max_output_tokens: options.maxTokens,
    parallel_tool_calls: false,
    tool_choice: 'none',
  }
  delete next['instructions']
  if (options.system !== undefined) next['instructions'] = options.system

  if (canonicalJson(next['input']) !== canonicalJson(projected) || Object.hasOwn(next, 'tools') ||
      FORBIDDEN_CONTEXT_FIELDS.some(field => Object.hasOwn(next, field)) ||
      (options.system === undefined ? Object.hasOwn(next, 'instructions') : next['instructions'] !== options.system)) {
    integrationFailure('The final ordered system/user payload failed inverse validation')
  }
  return next
}

function projectMessage(message: Message, index: number): CodexOrderedTextMessage {
  if (message.role !== 'system' && message.role !== 'user') {
    unsupportedContent(`Ordered system/user projection cannot represent message ${index} role`)
  }
  if (!Array.isArray(message.content) || message.content.length !== 1) {
    unsupportedContent(`Ordered system/user projection requires one text block in message ${index}`)
  }
  const block = plainRecord(message.content[0])
  if (block === undefined || canonicalJson(Object.keys(block).sort()) !== canonicalJson(['text', 'type']) ||
      block['type'] !== 'text' || typeof block['text'] !== 'string' || block['text'].length === 0) {
    unsupportedContent(`Ordered system/user projection received an invalid text block in message ${index}`)
  }
  return {
    role: message.role,
    content: [{ type: 'input_text', text: block['text'] }],
  }
}

function assertAllowedOptions(options: GenerateOptions): void {
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTION_KEYS.has(key)) unsupportedOption('Ordered system/user projection received an unknown request option')
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? value as Record<string, unknown>
    : undefined
}

function canonicalJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function unsupportedContent(message: string): never {
  throw new LlmError(message, 'UNSUPPORTED_CONTENT')
}

function unsupportedOption(message: string): never {
  throw new LlmError(message, 'UNSUPPORTED_OPTION')
}

function integrationFailure(message: string): never {
  throw new LlmError(message, 'INTEGRATION')
}
