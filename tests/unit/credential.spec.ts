import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { decodeCredential, encodeCredential, validateCredential } from '../../src/auth/credential-codec.ts'
import { DshPiCredentialStore } from '../../src/auth/credential-store.ts'
import { OPENAI_CODEX_PROVIDER } from '../../src/constants.ts'

const TOKEN = 'fake-access-never-log'
const REF = 'OPENAI_CODEX_OAUTH' as CredentialRef
const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function oauth(access = TOKEN): OAuthCredential {
  return { type: 'oauth', access, refresh: 'fake-refresh-never-log', expires: Date.now() + 60_000, accountId: 'acct_fake' }
}

class MemoryCredentials {
  value?: string
  source?: string
  writable = true
  setCalls = 0
  unsetCalls = 0

  async resolve(_ref: CredentialRef) {
    return this.value === undefined ? undefined : { value: this.value, source: this.source ?? 'file' }
  }

  async describe(_ref: CredentialRef) {
    return {
      configured: this.value !== undefined,
      writable: this.writable,
      ...(this.value === undefined ? {} : { source: this.source ?? 'file' }),
    }
  }

  async set(_ref: CredentialRef, value: string): Promise<void> {
    if (!this.writable) throw new Error('read only')
    this.setCalls += 1
    this.value = value
  }

  async unset(_ref: CredentialRef): Promise<void> {
    if (!this.writable) throw new Error('read only')
    this.unsetCalls += 1
    this.value = undefined
  }
}

async function store(credentials: MemoryCredentials): Promise<DshPiCredentialStore> {
  const directory = await mkdtemp(join(tmpdir(), 'docx-credential-test-'))
  tempRoots.push(directory)
  return new DshPiCredentialStore(credentials as unknown as CredentialProvider, {
    reference: REF,
    acquireTimeoutMs: 1_000,
    staleMs: 5_000,
    directory,
  })
}

describe('OAuth credential codec', () => {
  it('round trips the provider credential compactly', () => {
    const credential = oauth()
    const serialized = encodeCredential(credential)
    expect(serialized).not.toContain(' ')
    expect(decodeCredential(serialized)).toEqual(credential)
  })

  it.each([
    ['not JSON', '{'],
    ['array', '[]'],
    ['wrong discriminant', JSON.stringify({ ...oauth(), type: 'api_key' })],
    ['missing access', JSON.stringify({ ...oauth(), access: undefined })],
    ['empty refresh', JSON.stringify({ ...oauth(), refresh: '' })],
    ['invalid expiry', JSON.stringify({ ...oauth(), expires: -1 })],
    ['missing account', JSON.stringify({ ...oauth(), accountId: undefined })],
  ])('rejects %s without echoing durable input', (_label, serialized) => {
    expect(() => decodeCredential(serialized)).toThrow(/deepseek-openai-codex:/)
    try {
      decodeCredential(serialized)
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN)
      expect(JSON.stringify(error)).not.toContain(TOKEN)
    }
  })

  it('rejects oversized secrets and non-JSON values without retaining them', () => {
    expect(() => validateCredential({ ...oauth(), access: 'x'.repeat(128 * 1024 + 1) })).toThrow(/invalid access/)
    expect(() => validateCredential({ ...oauth(), extra: 1n })).toThrow(/non-JSON/)
  })
})

describe('DSH-backed Pi credential store', () => {
  it('resolves on every read and lists only valid openai-codex OAuth metadata', async () => {
    const credentials = new MemoryCredentials()
    const subject = await store(credentials)
    expect(await subject.read(OPENAI_CODEX_PROVIDER)).toBeUndefined()
    expect(await subject.list()).toEqual([])
    credentials.value = encodeCredential(oauth())
    expect(await subject.read(OPENAI_CODEX_PROVIDER)).toEqual(oauth())
    expect(await subject.list()).toEqual([{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }])
    expect(await subject.read('other')).toBeUndefined()
  })

  it('uses Pi modify semantics and prevents in-process lost updates', async () => {
    const credentials = new MemoryCredentials()
    credentials.value = encodeCredential({ ...oauth(), counter: 0 })
    const subject = await store(credentials)
    await Promise.all(Array.from({ length: 8 }, () => subject.modify(OPENAI_CODEX_PROVIDER, async current => {
      const counter = Number((current as OAuthCredential & { counter?: number } | undefined)?.counter ?? 0)
      await new Promise(resolve => setTimeout(resolve, 2))
      return { ...oauth(), counter: counter + 1 }
    })))
    expect((await subject.read(OPENAI_CODEX_PROVIDER) as OAuthCredential & { counter: number }).counter).toBe(8)
    const before = credentials.setCalls
    const unchanged = await subject.modify(OPENAI_CODEX_PROVIDER, async () => undefined)
    expect(unchanged).toBeDefined()
    expect(credentials.setCalls).toBe(before)
  })

  it('diagnoses read-only and shadowed sources before login or mutation', async () => {
    const credentials = new MemoryCredentials()
    credentials.value = encodeCredential(oauth())
    credentials.source = 'environment'
    credentials.writable = false
    const subject = await store(credentials)
    await expect(subject.assertLoginWritable()).rejects.toMatchObject({ code: 'CREDENTIAL_READ_ONLY' })
    await expect(subject.modify(OPENAI_CODEX_PROVIDER, async () => oauth('replacement')))
      .rejects.toMatchObject({ code: 'CREDENTIAL_READ_ONLY' })
    await expect(subject.delete(OPENAI_CODEX_PROVIDER)).rejects.toMatchObject({ code: 'CREDENTIAL_READ_ONLY' })
  })

  it('commits set, makes absent delete idempotent, and uses unset for logout', async () => {
    const credentials = new MemoryCredentials()
    const subject = await store(credentials)
    await subject.modify(OPENAI_CODEX_PROVIDER, async () => oauth())
    expect(credentials.setCalls).toBe(1)
    await subject.delete(OPENAI_CODEX_PROVIDER)
    await subject.delete(OPENAI_CODEX_PROVIDER)
    expect(credentials.unsetCalls).toBe(1)
  })

  it('rejects unsupported writes and responds to cancellation without leaking abort reasons', async () => {
    const credentials = new MemoryCredentials()
    const subject = await store(credentials)
    expect(() => subject.modify('other', async () => oauth())).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PROVIDER' }))
    const controller = new AbortController()
    controller.abort(TOKEN)
    const cancelled = subject.read(OPENAI_CODEX_PROVIDER, { signal: controller.signal })
    await expect(cancelled).rejects.toMatchObject({ code: 'ABORTED', message: expect.not.stringContaining(TOKEN) })
  })
})
