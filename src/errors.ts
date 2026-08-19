import { LlmError } from '@deepseek-ai/dsh-llm'

/** Stable, secret-free integration failure used outside the LLM stream. */
export class OpenAICodexError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'OpenAICodexError'
    this.code = code
  }
}

/** Throw a stable caller-cancellation error without retaining an abort reason. */
export function aborted(operation: string): OpenAICodexError {
  return new OpenAICodexError('ABORTED', `${operation} was cancelled`)
}

/** Assert an optional signal is still live without exposing its reason. */
export function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw aborted(operation)
}

/** Map an unknown Pi/provider failure to a safe LLM error and discard nested causes. */
export function safeLlmError(error: unknown, callerAborted = false): LlmError {
  if (callerAborted) return new LlmError('OpenAI Codex request cancelled by the caller', 'ABORTED')

  const record = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : undefined
  const rawMessage = error instanceof Error ? error.message : ''
  const failure = error instanceof LlmError ? error.failure : undefined
  const status = failure?.status ?? readHttpStatus(record)
  const retry = failure?.providerRetryAfterMs ?? readPositiveNumber(record, ['retryAfterMs', 'providerRetryAfterMs'])
  const requestId = failure?.requestId ?? readString(record, ['requestId', 'request_id'])
  const candidateCode = error instanceof LlmError ? error.code : undefined
  const code = candidateCode !== undefined && LOCAL_LLM_CODES.has(candidateCode)
    ? candidateCode
    : classifyProviderFailure(rawMessage, status)
  const message = localLlmMessage(code) ?? safeLlmMessage(code)

  return new LlmError(message, code, {
    ...(status === undefined ? {} : { status }),
    ...(retry === undefined ? {} : { providerRetryAfterMs: retry }),
    ...(requestId === undefined ? {} : { requestId: requestId as never }),
  })
}

const LOCAL_LLM_CODES = new Set([
  'ABORTED',
  'INVALID_REPLAY_STATE',
  'MALFORMED_RESPONSE',
  'NO_ADAPTER',
  'UNKNOWN_MODEL',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_OPTION',
  'UNSUPPORTED_REASONING_EFFORT',
  'UNAVAILABLE',
])

function localLlmMessage(code: string): string | undefined {
  switch (code) {
    case 'INVALID_REPLAY_STATE': return 'OpenAI Codex could not safely reuse the stored provider replay state'
    case 'NO_ADAPTER': return 'The requested provider is not owned by the OpenAI Codex adapter'
    case 'UNKNOWN_MODEL': return 'The requested OpenAI Codex model is not in Pi’s installed catalog'
    case 'UNSUPPORTED_CONTENT': return 'The OpenAI Codex request contains unsupported content'
    case 'UNSUPPORTED_OPTION': return 'The OpenAI Codex request contains an unsupported option'
    case 'UNSUPPORTED_REASONING_EFFORT': return 'The OpenAI Codex model does not support the requested reasoning effort'
    default: return undefined
  }
}

/** Classify provider text without ever returning or logging that text. */
export function classifyProviderFailure(message: string, status?: number): string {
  if (status === 401 || /\b401\b|invalid[_ -]?grant|token.*(?:expired|invalid)/i.test(message)) return 'AUTH'
  if (status === 402 || status === 403 || /\b(?:402|403)\b|\b(?:subscription|plan|eligib|permission|forbidden)\b/i.test(message)) return 'PERMISSION'
  if (status === 429 || /\b429\b|rate.?limit|too many requests/i.test(message)) return 'RATE_LIMIT'
  if (status === 408 || /time(?:d)?\s*out|timeout/i.test(message)) return 'TIMEOUT'
  if (status === 400 || /\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (status !== undefined && status >= 500) return 'UNAVAILABLE'
  if (/abort|cancel/i.test(message)) return 'ABORTED'
  if (/stream ended|malformed|parse|invalid (?:sse|response)/i.test(message)) return 'MALFORMED_RESPONSE'
  if (/network|fetch|socket|connection|ECONN[A-Z]+|terminated|premature close/i.test(message)) return 'UNAVAILABLE'
  return 'INTEGRATION'
}

/** User-actionable messages that contain no provider body or nested cause. */
export function safeLlmMessage(code: string): string {
  switch (code) {
    case 'AUTH': return 'OpenAI Codex authentication failed; sign in with ChatGPT again in Settings → Plugins'
    case 'PERMISSION': return 'OpenAI Codex access was refused; check ChatGPT plan eligibility and account permissions'
    case 'RATE_LIMIT': return 'OpenAI Codex is rate limited; retry after the provider delay'
    case 'TIMEOUT': return 'OpenAI Codex did not respond before the request timeout; retry the request'
    case 'INVALID_REQUEST': return 'OpenAI Codex rejected the request; correct the model or request configuration'
    case 'ABORTED': return 'OpenAI Codex request was cancelled'
    case 'MALFORMED_RESPONSE': return 'OpenAI Codex returned a malformed streaming response; retry the request'
    case 'UNAVAILABLE': return 'OpenAI Codex is temporarily unavailable; retry the request'
    default: return 'The OpenAI Codex integration failed before a safe provider result was available'
  }
}

/** Authentication UI failure text, deliberately independent of raw exception messages. */
export function safeAuthFailure(error: unknown): { code: string; message: string } {
  if (error instanceof OpenAICodexError) return { code: error.code, message: error.message }
  const raw = error instanceof Error ? error.message : ''
  const code = classifyProviderFailure(raw)
  if (code === 'AUTH') return { code: 'AUTH_FAILED', message: 'ChatGPT sign-in failed; start a new sign-in attempt' }
  if (code === 'PERMISSION') return { code: 'PLAN_INELIGIBLE', message: 'OpenAI refused subscription access; check ChatGPT plan eligibility' }
  if (code === 'TIMEOUT') return { code: 'AUTH_TIMEOUT', message: 'ChatGPT sign-in expired; start a new sign-in attempt' }
  if (code === 'ABORTED') return { code: 'AUTH_CANCELLED', message: 'ChatGPT sign-in was cancelled' }
  return { code: 'AUTH_FAILED', message: 'ChatGPT sign-in failed safely; start a new sign-in attempt' }
}

function readHttpStatus(record: Record<string, unknown> | undefined): number | undefined {
  const value = record?.['status'] ?? record?.['statusCode']
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}

function readPositiveNumber(record: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

function readString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key]
    if (typeof value === 'string' && value.length > 0 && value.length <= 256) return value
  }
  return undefined
}
