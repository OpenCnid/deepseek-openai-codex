import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo as PiCredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai'
import type { CredentialInfo, CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { OPENAI_CODEX_PROVIDER } from '../constants.ts'
import { OpenAICodexError, throwIfAborted } from '../errors.ts'
import { decodeCredential, encodeCredential } from './credential-codec.ts'
import { CredentialLock, type CredentialLockOptions } from './lock.ts'

/** Construction options for the DSH-owned Pi credential bridge. */
export interface DshPiCredentialStoreOptions extends CredentialLockOptions {
  readonly reference: CredentialRef
}

/** Pi `CredentialStore` backed exclusively by DSH's durable credential seam. */
export class DshPiCredentialStore implements CredentialStore {
  private readonly lock: CredentialLock

  constructor(
    private readonly credentials: CredentialProvider,
    private readonly options: DshPiCredentialStoreOptions,
  ) {
    this.lock = new CredentialLock(options)
  }

  /** Resolve and validate the OAuth JSON on every operation. */
  async read(providerId: string, operation: AuthOperationOptions = {}): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) return undefined
    throwIfAborted(operation.signal, 'credential read')
    const resolved = await this.credentials.resolve(this.options.reference)
    throwIfAborted(operation.signal, 'credential read')
    return resolved === undefined ? undefined : decodeCredential(resolved.value)
  }

  /** Enumerate metadata for only this package's provider, never secret fields. */
  async list(operation: AuthOperationOptions = {}): Promise<readonly PiCredentialInfo[]> {
    const current = await this.read(OPENAI_CODEX_PROVIDER, operation)
    return current === undefined ? [] : [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }]
  }

  /** Cross-process serialized resolve/callback/commit transaction. */
  modify(
    providerId: string,
    callback: (current: Credential | undefined) => Promise<Credential | undefined>,
    operation: AuthOperationOptions = {},
  ): Promise<Credential | undefined> {
    this.assertProvider(providerId)
    return this.lock.run(String(this.options.reference), async () => {
      throwIfAborted(operation.signal, 'credential update')
      const info = await this.credentials.describe(this.options.reference)
      this.assertWritable(info, 'update')
      const hit = await this.credentials.resolve(this.options.reference)
      const current = hit === undefined ? undefined : decodeCredential(hit.value)
      const next = await callback(current)
      throwIfAborted(operation.signal, 'credential update')
      if (next === undefined) return current
      const serialized = encodeCredential(next)
      try {
        await this.credentials.set(this.options.reference, serialized)
      } catch {
        throw new OpenAICodexError(
          'CREDENTIAL_WRITE_FAILED',
          'deepseek-openai-codex: DSH credential storage refused the OAuth update; check for a read-only shadowing source',
        )
      }
      return decodeCredential(serialized)
    }, operation.signal)
  }

  /** Idempotent, serialized logout through DSH `unset`. */
  delete(providerId: string, operation: AuthOperationOptions = {}): Promise<void> {
    this.assertProvider(providerId)
    return this.lock.run(String(this.options.reference), async () => {
      throwIfAborted(operation.signal, 'credential deletion')
      const info = await this.credentials.describe(this.options.reference)
      if (!info.configured) return
      this.assertWritable(info, 'delete')
      try {
        await this.credentials.unset(this.options.reference)
      } catch {
        throw new OpenAICodexError(
          'CREDENTIAL_WRITE_FAILED',
          'deepseek-openai-codex: DSH credential storage refused OAuth logout; remove the shadowing read-only source first',
        )
      }
    }, operation.signal)
  }

  /** Safe source and writability facts for the settings card. */
  describe(): Promise<CredentialInfo> {
    return this.credentials.describe(this.options.reference)
  }

  /** Fail early when configured durable data cannot be decoded. */
  async validateDurable(): Promise<void> {
    await this.read(OPENAI_CODEX_PROVIDER)
  }

  /** Ensure an interactive login can commit before Pi starts it. */
  async assertLoginWritable(): Promise<CredentialInfo> {
    const info = await this.describe()
    this.assertWritable(info, 'sign in')
    if (info.configured) {
      throw new OpenAICodexError(
        'CREDENTIAL_ALREADY_CONFIGURED',
        'deepseek-openai-codex: logout the current ChatGPT subscription credential before replacing it',
      )
    }
    return info
  }

  private assertProvider(providerId: string): void {
    if (providerId !== OPENAI_CODEX_PROVIDER) {
      throw new OpenAICodexError('UNSUPPORTED_PROVIDER', `deepseek-openai-codex: credential store does not own provider "${providerId}"`)
    }
  }

  private assertWritable(info: CredentialInfo, operation: string): void {
    if (info.writable) return
    const source = info.source === undefined ? 'the active credential provider' : `source "${info.source}"`
    throw new OpenAICodexError(
      'CREDENTIAL_READ_ONLY',
      `deepseek-openai-codex: cannot ${operation} because ${source} is read-only or shadows the writable DSH credential source`,
    )
  }
}
