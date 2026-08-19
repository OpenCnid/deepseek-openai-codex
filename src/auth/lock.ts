import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { aborted, OpenAICodexError, throwIfAborted } from '../errors.ts'

/** Cross-process lock configuration. */
export interface CredentialLockOptions {
  readonly acquireTimeoutMs: number
  readonly staleMs: number
  readonly directory?: string
}

/**
 * Maintained `proper-lockfile`-backed serializer. Lock names contain only a
 * SHA-256 digest of the public credential reference and never credential data.
 */
export class CredentialLock {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly root: string

  constructor(private readonly options: CredentialLockOptions) {
    this.root = options.directory ?? join(tmpdir(), 'deepseek-openai-codex-locks')
  }

  /** Serialize one callback in-process and across processes. */
  run<T>(reference: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tails.get(reference) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(async () => {
      throwIfAborted(signal, 'credential update')
      return this.withFileLock(reference, operation, signal)
    })
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(reference, tail)
    void tail.finally(() => {
      if (this.tails.get(reference) === tail) this.tails.delete(reference)
    })
    return result
  }

  private async withFileLock<T>(reference: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const digest = createHash('sha256').update(reference, 'utf8').digest('hex')
    const target = join(this.root, `credential-${digest}`)
    const deadline = Date.now() + this.options.acquireTimeoutMs
    let release: (() => Promise<void>) | undefined
    let compromised = false

    while (release === undefined) {
      throwIfAborted(signal, 'credential lock acquisition')
      try {
        release = await lockfile.lock(target, {
          realpath: false,
          retries: 0,
          stale: this.options.staleMs,
          update: Math.max(1_000, Math.min(this.options.staleMs / 2, this.options.staleMs - 1_000)),
          onCompromised: () => { compromised = true },
        })
      } catch (error: unknown) {
        if (!isLockedError(error)) {
          throw new OpenAICodexError('LOCK_FAILED', 'deepseek-openai-codex: credential lock could not be acquired')
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new OpenAICodexError(
            'LOCK_TIMEOUT',
            `deepseek-openai-codex: credential lock timed out after ${this.options.acquireTimeoutMs}ms; stop the competing DSH process or raise credentialLockAcquireTimeoutMs`,
          )
        }
        await abortableDelay(Math.min(50, remaining), signal)
      }
    }

    let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
    try {
      const value = await operation()
      if (compromised) {
        throw new OpenAICodexError('LOCK_COMPROMISED', 'deepseek-openai-codex: credential lock was compromised during an update')
      }
      outcome = { ok: true, value }
    } catch (error: unknown) {
      outcome = { ok: false, error }
    }

    try {
      await release()
    } catch {
      // A release failure must be visible when it is the only failure, but it
      // must not overwrite the callback/compromise error that caused unwind.
      if (outcome.ok && !compromised) {
        throw new OpenAICodexError('LOCK_RELEASE_FAILED', 'deepseek-openai-codex: credential lock release failed')
      }
    }
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }
}

function isLockedError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ELOCKED'
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(aborted('credential lock acquisition'))
  let onAbort: (() => void) | undefined
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    onAbort = (): void => {
      clearTimeout(timer)
      reject(aborted('credential lock acquisition'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  }).finally(() => {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  })
}
