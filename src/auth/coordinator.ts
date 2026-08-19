import { randomUUID } from 'node:crypto'
import type { AuthEvent as PiAuthEvent, AuthPrompt as PiAuthPrompt, Models } from '@earendil-works/pi-ai'
import { OPENAI_CODEX_PROVIDER } from '../constants.ts'
import { aborted, OpenAICodexError, safeAuthFailure, throwIfAborted } from '../errors.ts'
import type {
  AuthAttemptId,
  AuthEvent,
  AuthEventBatch,
  AuthPromptId,
  AuthSelectOption,
  AuthStatus,
  BeginLoginResult,
  ResumeLoginResult,
} from './types.ts'
import type { DshPiCredentialStore } from './credential-store.ts'

const MAX_DISPLAY_CHARS = 2_048
const MAX_URL_CHARS = 8_192
const MAX_PROMPT_VALUE_CHARS = 32_768
const MAX_OPTIONS = 64

export interface AuthCoordinatorOptions {
  readonly attemptLifetimeMs: number
  readonly replayCapacity: number
  readonly readTimeoutMs: number
}

interface PendingPrompt {
  readonly id: AuthPromptId
  readonly kind: PiAuthPrompt['type']
  readonly choices?: ReadonlySet<string>
  readonly resolve: (value: string) => void
  readonly reject: (error: Error) => void
  readonly detach: () => void
  replied: boolean
}

interface AuthAttempt {
  readonly id: AuthAttemptId
  readonly controller: AbortController
  readonly events: AuthEvent[]
  readonly prompts: Map<AuthPromptId, PendingPrompt>
  readonly waiters: Set<() => void>
  readonly startedAt: number
  nextSeq: number
  terminal: boolean
  expirationRequested: boolean
  expiryTimer?: ReturnType<typeof setTimeout>
  cleanupTimer?: ReturnType<typeof setTimeout>
  run?: Promise<void>
}

type AuthEventInput = AuthEvent extends infer Event
  ? Event extends { readonly seq: number }
    ? Omit<Event, 'seq'>
    : never
  : never

/** Host-owned translation between Pi login callbacks and a bounded RPC state machine. */
export class AuthCoordinator {
  private readonly attempts = new Map<AuthAttemptId, AuthAttempt>()
  private activeId: AuthAttemptId | undefined
  private disposed = false

  constructor(
    private readonly models: Models,
    private readonly store: DshPiCredentialStore,
    private readonly options: AuthCoordinatorOptions,
  ) {}

  /** Secret-free credential and process-local login state. */
  async status(): Promise<AuthStatus> {
    this.assertLive()
    const [credential, description] = await Promise.all([
      this.store.read(OPENAI_CODEX_PROVIDER),
      this.store.describe(),
    ])
    return Object.freeze({
      configured: credential !== undefined,
      writable: description.writable,
      ...(description.source === undefined ? {} : { source: safeText(description.source, 128) }),
      loginInProgress: this.liveAttempt() !== undefined,
    })
  }

  /** Start one fresh Pi-owned OAuth flow after proving DSH storage is writable. */
  async beginLogin(): Promise<BeginLoginResult> {
    this.assertLive()
    if (this.liveAttempt() !== undefined) {
      throw new OpenAICodexError('AUTH_IN_PROGRESS', 'deepseek-openai-codex: a ChatGPT sign-in attempt is already in progress')
    }
    await this.store.assertLoginWritable()
    const id = randomUUID() as AuthAttemptId
    const attempt: AuthAttempt = {
      id,
      controller: new AbortController(),
      events: [],
      prompts: new Map(),
      waiters: new Set(),
      startedAt: Date.now(),
      nextSeq: 1,
      terminal: false,
      expirationRequested: false,
    }
    this.attempts.set(id, attempt)
    this.activeId = id
    this.emit(attempt, { type: 'info', message: 'Starting ChatGPT subscription sign-in on the Host.' })
    attempt.expiryTimer = setTimeout(() => { this.expire(attempt) }, this.options.attemptLifetimeMs)
    attempt.expiryTimer.unref?.()
    attempt.run = this.runLogin(attempt)
    return Object.freeze({ attemptId: id })
  }

  /** Explicit reload/reconnect recovery without changing `beginLogin` collision semantics. */
  resumeLogin(): ResumeLoginResult | undefined {
    this.assertLive()
    const attempt = this.liveAttempt()
    return attempt === undefined ? undefined : Object.freeze({ attemptId: attempt.id })
  }

  /** Long-poll a bounded event buffer until progress, terminal state, timeout, or cancellation. */
  async readLogin(attemptId: AuthAttemptId, after: number, signal?: AbortSignal): Promise<AuthEventBatch> {
    this.assertLiveOrDisposing()
    assertAttemptId(attemptId)
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new OpenAICodexError('INVALID_AUTH_CURSOR', 'deepseek-openai-codex: login cursor must be a non-negative safe integer')
    }
    const attempt = this.requireAttempt(attemptId)
    let batch = this.batch(attempt, after)
    if (batch.events.length > 0 || batch.terminal || this.disposed) return batch
    await this.waitForAttempt(attempt, signal)
    batch = this.batch(attempt, after)
    return batch
  }

  /** Deliver exactly one bounded answer to the matching live Pi prompt. */
  respond(attemptId: AuthAttemptId, promptId: AuthPromptId, value: unknown): void {
    this.assertLive()
    assertAttemptId(attemptId)
    assertPromptId(promptId)
    const attempt = this.requireAttempt(attemptId)
    if (attempt.terminal || this.activeId !== attempt.id) {
      throw new OpenAICodexError('STALE_AUTH_ATTEMPT', 'deepseek-openai-codex: the sign-in attempt is no longer accepting replies')
    }
    const prompt = attempt.prompts.get(promptId)
    if (prompt === undefined || prompt.replied) {
      throw new OpenAICodexError('STALE_AUTH_PROMPT', 'deepseek-openai-codex: the sign-in prompt is stale, duplicated, or belongs to another attempt')
    }
    if (typeof value !== 'string' || value.length > MAX_PROMPT_VALUE_CHARS) {
      throw new OpenAICodexError('INVALID_AUTH_REPLY', 'deepseek-openai-codex: the sign-in reply is not a bounded string')
    }
    if (prompt.kind === 'select' && !prompt.choices?.has(value)) {
      throw new OpenAICodexError('INVALID_AUTH_REPLY', 'deepseek-openai-codex: the selected sign-in option is not valid for this prompt')
    }
    prompt.replied = true
    attempt.prompts.delete(promptId)
    prompt.detach()
    // A resolved prompt must not be replayed to a reconnecting browser.
    removeEvent(attempt, event => event.type === 'prompt' && event.promptId === promptId)
    prompt.resolve(value)
    this.wake(attempt)
  }

  /** Cancel only the addressed live attempt. */
  cancel(attemptId: AuthAttemptId): void {
    this.assertLive()
    assertAttemptId(attemptId)
    const attempt = this.requireAttempt(attemptId)
    if (attempt.terminal || this.activeId !== attempt.id) {
      throw new OpenAICodexError('STALE_AUTH_ATTEMPT', 'deepseek-openai-codex: the sign-in attempt is no longer live')
    }
    attempt.controller.abort()
  }

  /** Idempotent Pi-owned logout, refused while a login is racing it. */
  async logout(): Promise<void> {
    this.assertLive()
    if (this.liveAttempt() !== undefined) {
      throw new OpenAICodexError('AUTH_IN_PROGRESS', 'deepseek-openai-codex: cancel the active sign-in attempt before logging out')
    }
    await this.models.logout(OPENAI_CODEX_PROVIDER)
  }

  /** Abort live work, settle reads, await Pi cleanup, and release every timer. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const attempt of this.attempts.values()) {
      if (!attempt.terminal) {
        attempt.controller.abort()
        this.finish(attempt, 'cancelled', 'AUTH_DISPOSED', 'ChatGPT sign-in stopped because the Host plugin was disposed.')
      }
      if (attempt.expiryTimer !== undefined) clearTimeout(attempt.expiryTimer)
      if (attempt.cleanupTimer !== undefined) clearTimeout(attempt.cleanupTimer)
      this.rejectPrompts(attempt, aborted('ChatGPT sign-in'))
      this.wake(attempt)
    }
    await Promise.allSettled([...this.attempts.values()].flatMap(attempt => attempt.run === undefined ? [] : [attempt.run]))
    this.attempts.clear()
    this.activeId = undefined
  }

  private async runLogin(attempt: AuthAttempt): Promise<void> {
    try {
      await this.models.login(OPENAI_CODEX_PROVIDER, 'oauth', {
        signal: attempt.controller.signal,
        notify: event => { this.notify(attempt, event) },
        prompt: prompt => this.prompt(attempt, prompt),
      })
      // Models.login commits through CredentialStore.modify before resolving.
      if (await this.store.read(OPENAI_CODEX_PROVIDER) === undefined) {
        throw new OpenAICodexError('CREDENTIAL_COMMIT_MISSING', 'deepseek-openai-codex: sign-in completed without a durable DSH credential')
      }
      this.finish(attempt, 'succeeded', undefined, 'ChatGPT subscription sign-in is configured.')
    } catch (error: unknown) {
      if (attempt.terminal) return
      if (attempt.expirationRequested) {
        this.finish(attempt, 'expired', 'AUTH_EXPIRED', 'ChatGPT sign-in expired; start a new attempt.')
      } else if (attempt.controller.signal.aborted) {
        this.finish(attempt, 'cancelled', 'AUTH_CANCELLED', 'ChatGPT sign-in was cancelled.')
      } else {
        const safe = safeAuthFailure(error)
        this.finish(attempt, 'failed', safe.code, safe.message)
      }
    } finally {
      this.rejectPrompts(attempt, aborted('ChatGPT sign-in'))
    }
  }

  private notify(attempt: AuthAttempt, event: PiAuthEvent): void {
    if (attempt.terminal) return
    switch (event.type) {
      case 'info':
        this.emit(attempt, {
          type: 'info',
          message: safeText(event.message),
          ...(event.links === undefined ? {} : {
            links: event.links.slice(0, 8).map(link => ({
              url: safeUrl(link.url),
              ...(link.label === undefined ? {} : { label: safeText(link.label, 256) }),
            })),
          }),
        })
        break
      case 'progress':
        this.emit(attempt, { type: 'progress', message: safeText(event.message) })
        break
      case 'auth_url':
        this.emit(attempt, {
          type: 'auth-url',
          url: safeUrl(event.url),
          ...(event.instructions === undefined ? {} : { instructions: safeText(event.instructions) }),
        })
        break
      case 'device_code':
        {
          const expiresInSeconds = validDuration(event.expiresInSeconds)
        this.emit(attempt, {
          type: 'device-code',
          userCode: boundedTransient(event.userCode, 'device code'),
          verificationUri: safeUrl(event.verificationUri),
          ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
        })
        break
        }
    }
  }

  private prompt(attempt: AuthAttempt, prompt: PiAuthPrompt): Promise<string> {
    if (attempt.terminal || attempt.controller.signal.aborted) return Promise.reject(aborted('ChatGPT sign-in prompt'))
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID() as AuthPromptId
      const promptSignal = prompt.signal
      const onAbort = (): void => {
        const pending = attempt.prompts.get(id)
        if (pending === undefined || pending.replied) return
        pending.replied = true
        attempt.prompts.delete(id)
        removeEvent(attempt, event => event.type === 'prompt' && event.promptId === id)
        reject(aborted('ChatGPT sign-in prompt'))
        this.wake(attempt)
      }
      const detach = (): void => { promptSignal?.removeEventListener('abort', onAbort) }
      const options = prompt.type === 'select' ? safeOptions(prompt.options) : undefined
      const pending: PendingPrompt = {
        id,
        kind: prompt.type,
        ...(options === undefined ? {} : { choices: new Set(options.map(option => option.id)) }),
        resolve,
        reject,
        detach,
        replied: false,
      }
      attempt.prompts.set(id, pending)
      promptSignal?.addEventListener('abort', onAbort, { once: true })
      if (promptSignal?.aborted) {
        onAbort()
        return
      }
      this.emit(attempt, {
        type: 'prompt',
        promptId: id,
        kind: prompt.type,
        message: safeText(prompt.message),
        ...('placeholder' in prompt && prompt.placeholder !== undefined
          ? { placeholder: safeText(prompt.placeholder, 512) }
          : {}),
        ...(options === undefined ? {} : { options }),
      })
    })
  }

  private emit(attempt: AuthAttempt, event: AuthEventInput): void {
    const sequenced = Object.freeze({ ...event, seq: attempt.nextSeq++ }) as AuthEvent
    attempt.events.push(sequenced)
    while (attempt.events.length > this.options.replayCapacity) {
      const removable = attempt.events.findIndex(candidate => candidate.type !== 'prompt' && candidate.type !== 'terminal')
      attempt.events.splice(removable < 0 ? 0 : removable, 1)
    }
    this.wake(attempt)
  }

  private finish(
    attempt: AuthAttempt,
    state: Extract<AuthEvent, { type: 'terminal' }>['state'],
    code: string | undefined,
    message: string,
  ): void {
    if (attempt.terminal) return
    attempt.terminal = true
    if (attempt.expiryTimer !== undefined) clearTimeout(attempt.expiryTimer)
    if (this.activeId === attempt.id) this.activeId = undefined
    // URLs, device codes, and prompt descriptions are transient and cease to
    // be replayable once Pi no longer needs the interaction.
    removeEvent(attempt, event => event.type === 'auth-url' || event.type === 'device-code' || event.type === 'prompt')
    this.emit(attempt, {
      type: 'terminal',
      state,
      ...(code === undefined ? {} : { code }),
      message: safeText(message),
    })
    this.rejectPrompts(attempt, aborted('ChatGPT sign-in'))
    attempt.cleanupTimer = setTimeout(() => {
      this.attempts.delete(attempt.id)
      this.wake(attempt)
    }, this.options.attemptLifetimeMs)
    attempt.cleanupTimer.unref?.()
  }

  private expire(attempt: AuthAttempt): void {
    if (attempt.terminal) return
    attempt.expirationRequested = true
    attempt.controller.abort()
    this.finish(attempt, 'expired', 'AUTH_EXPIRED', 'ChatGPT sign-in expired; start a new attempt.')
  }

  private rejectPrompts(attempt: AuthAttempt, error: Error): void {
    for (const pending of attempt.prompts.values()) {
      if (pending.replied) continue
      pending.replied = true
      pending.detach()
      pending.reject(error)
    }
    attempt.prompts.clear()
  }

  private batch(attempt: AuthAttempt, after: number): AuthEventBatch {
    const events = attempt.events.filter(event => event.seq > after)
    const next = events.at(-1)?.seq ?? Math.max(after, attempt.nextSeq - 1)
    return Object.freeze({ events: Object.freeze([...events]), next, terminal: attempt.terminal })
  }

  private waitForAttempt(attempt: AuthAttempt, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, 'login event read')
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        attempt.waiters.delete(settle)
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        attempt.waiters.delete(settle)
        reject(aborted('login event read'))
      }
      const timer = setTimeout(settle, this.options.readTimeoutMs)
      timer.unref?.()
      attempt.waiters.add(settle)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  private wake(attempt: AuthAttempt): void {
    for (const settle of attempt.waiters) settle()
  }

  private liveAttempt(): AuthAttempt | undefined {
    const attempt = this.activeId === undefined ? undefined : this.attempts.get(this.activeId)
    return attempt !== undefined && !attempt.terminal ? attempt : undefined
  }

  private requireAttempt(id: AuthAttemptId): AuthAttempt {
    const attempt = this.attempts.get(id)
    if (attempt === undefined) throw new OpenAICodexError('AUTH_ATTEMPT_NOT_FOUND', 'deepseek-openai-codex: the sign-in attempt is unknown or expired')
    return attempt
  }

  private assertLive(): void {
    if (this.disposed) throw new OpenAICodexError('PLUGIN_DISPOSED', 'deepseek-openai-codex: Host auth service is disposed')
  }

  private assertLiveOrDisposing(): void {
    if (this.disposed && this.attempts.size === 0) this.assertLive()
  }
}

function assertAttemptId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new OpenAICodexError('INVALID_AUTH_ATTEMPT', 'deepseek-openai-codex: malformed sign-in attempt id')
  }
}

function assertPromptId(value: string): void {
  try {
    assertAttemptId(value)
  } catch {
    throw new OpenAICodexError('INVALID_AUTH_PROMPT', 'deepseek-openai-codex: malformed sign-in prompt id')
  }
}

function safeText(value: string, max = MAX_DISPLAY_CHARS): string {
  const normalized = typeof value === 'string' ? stripControlCharacters(value) : ''
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`
}

function stripControlCharacters(value: string): string {
  let result = ''
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0
    if (point <= 8 || point === 11 || point === 12 || (point >= 14 && point <= 31) || point === 127) continue
    result += character
  }
  return result
}

function boundedTransient(value: string, subject: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new OpenAICodexError('INVALID_AUTH_EVENT', `deepseek-openai-codex: Pi supplied an invalid ${subject}`)
  }
  return value
}

function safeUrl(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_CHARS) {
    throw new OpenAICodexError('INVALID_AUTH_URL', 'deepseek-openai-codex: Pi supplied an invalid authentication URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new OpenAICodexError('INVALID_AUTH_URL', 'deepseek-openai-codex: Pi supplied an invalid authentication URL')
  }
  const loopbackHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new OpenAICodexError('INVALID_AUTH_URL', 'deepseek-openai-codex: Pi supplied an authentication URL with a disallowed scheme')
  }
  return url.toString()
}

function safeOptions(options: readonly { id: string; label: string; description?: string }[]): readonly AuthSelectOption[] {
  if (!Array.isArray(options) || options.length === 0 || options.length > MAX_OPTIONS) {
    throw new OpenAICodexError('INVALID_AUTH_PROMPT', 'deepseek-openai-codex: Pi supplied an invalid selection prompt')
  }
  const ids = new Set<string>()
  return Object.freeze(options.map(option => {
    if (typeof option.id !== 'string' || option.id.length === 0 || option.id.length > 256 || ids.has(option.id)) {
      throw new OpenAICodexError('INVALID_AUTH_PROMPT', 'deepseek-openai-codex: Pi supplied an invalid selection option')
    }
    ids.add(option.id)
    return Object.freeze({
      id: option.id,
      label: safeText(option.label, 256),
      ...(option.description === undefined ? {} : { description: safeText(option.description, 512) }),
    })
  }))
}

function validDuration(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400 ? value : undefined
}

function removeEvent(attempt: AuthAttempt, predicate: (event: AuthEvent) => boolean): void {
  for (let index = attempt.events.length - 1; index >= 0; index -= 1) {
    const event = attempt.events[index]
    if (event !== undefined && predicate(event)) attempt.events.splice(index, 1)
  }
}
