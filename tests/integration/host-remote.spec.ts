import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { AuthInteraction, Credential, MutableModels, OAuthCredential } from '@earendil-works/pi-ai'
import { encodeCredential } from '../../src/auth/credential-codec.ts'

const modelHarness = vi.hoisted(() => {
  let login: (interaction: AuthInteraction) => Promise<Credential> = async () => {
    throw new Error('host remote test did not configure Pi login')
  }
  let logout: () => Promise<void> = async () => undefined
  const models = {
    setProvider: vi.fn(),
    getModels: vi.fn(() => []),
    getModel: vi.fn(() => undefined),
    login: vi.fn((_provider: string, _type: string, interaction: AuthInteraction) => login(interaction)),
    logout: vi.fn(() => logout()),
  } as unknown as MutableModels
  return {
    models,
    setLogin(value: typeof login) { login = value },
    setLogout(value: typeof logout) { logout = value },
  }
})

vi.mock('@earendil-works/pi-ai', async importOriginal => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>()
  return { ...actual, createModels: () => modelHarness.models }
})

import * as HostPlugin from '../../src/index.ts'
import type { Config as HostConfig } from '../../src/config.ts'
import type { AuthPromptId } from '../../src/auth/types.ts'

const REF = credentialRef('OPENAI_CODEX_OAUTH')
const FAKE_CREDENTIAL: OAuthCredential = {
  type: 'oauth',
  access: 'fake-host-access-never-log',
  refresh: 'fake-host-refresh-never-log',
  expires: 4_000_000_000_000,
  accountId: 'acct_fake_host',
}
const roots: string[] = []

class MemoryCredentials extends CredentialProvider {
  readonly values = new Map<string, string>()
  writable = true

  constructor(ctx: Context, seed: Record<string, string> = {}) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.values.set(key, value)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = this.values.has(ref)
    return Promise.resolve({
      configured,
      writable: this.writable,
      ...(configured ? { source: 'memory' } : {}),
    })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    if (!this.writable) return Promise.reject(new Error('read only'))
    this.values.set(ref, value)
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    if (!this.writable) return Promise.reject(new Error('read only'))
    if (this.values.delete(ref)) this.notifyUpdated(ref)
    return Promise.resolve()
  }
}

async function createHost(seed: Record<string, string> = {}): Promise<{
  ctx: Context
  credentials: MemoryCredentials
  config: HostConfig
}> {
  const directory = await mkdtemp(join(tmpdir(), 'openai-codex-host-'))
  roots.push(directory)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const credentials = new MemoryCredentials(ctx, seed)
  const config = { lockDirectory: directory } as HostConfig
  return { ctx, credentials, config }
}

beforeEach(() => {
  vi.clearAllMocks()
  modelHarness.setLogin(async () => { throw new Error('host remote test did not configure Pi login') })
  modelHarness.setLogout(async () => undefined)
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('mounted Host plugin and production Remote path', () => {
  it('publishes exactly one provider, directory row, and secret-free auth service, then withdraws all three', async () => {
    const { ctx, config } = await createHost()
    const fiber = await ctx.plugin(HostPlugin, config)

    expect(ctx.llm.listProviders()).toEqual([{ id: 'openai-codex', name: 'OpenAI Codex (ChatGPT subscription)' }])
    expect(ctx.llm.listConfigurableProviders()).toEqual([{
      provider: 'openai-codex',
      displayName: 'OpenAI Codex (ChatGPT subscription)',
      settingsNs: 'deepseek-openai-codex',
      settingsPath: [],
    }])
    expect(await ctx.openaiCodexAuth.status()).toEqual({
      configured: false,
      writable: true,
      loginInProgress: false,
    })

    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    expect(ctx.get('openaiCodexAuth')).toBeUndefined()
  })

  it('runs Pi interaction callbacks through the registered Remote, reconnects, commits, and logs out', async () => {
    const { ctx, credentials, config } = await createHost()
    modelHarness.setLogin(async interaction => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example.test/start' })
      interaction.notify({
        type: 'device_code',
        userCode: 'SAFE-HOST-CODE',
        verificationUri: 'https://auth.example.test/device',
      })
      const manual = await interaction.prompt({ type: 'manual_code', message: 'Paste the safe fake callback' })
      expect(manual).toBe('fake-manual-answer')
      const secret = await interaction.prompt({ type: 'secret', message: 'Enter the safe fake one-time secret' })
      expect(secret).toBe('fake-secret-answer')
      await credentials.set(REF, encodeCredential(FAKE_CREDENTIAL))
      return FAKE_CREDENTIAL
    })
    modelHarness.setLogout(async () => { await credentials.unset(REF) })
    const fiber = await ctx.plugin(HostPlugin, config)

    const begun = await ctx.openaiCodexAuth.beginLogin()
    expect(ctx.openaiCodexAuth.resumeLogin()).toEqual({ attemptId: begun.attemptId })
    let batch = await ctx.openaiCodexAuth.readLogin({ attemptId: begun.attemptId, after: 0 })
    expect(batch.events.map(event => event.type)).toEqual(expect.arrayContaining(['info', 'auth-url', 'device-code', 'prompt']))
    const manual = batch.events.find(event => event.type === 'prompt')
    ctx.openaiCodexAuth.respond({
      attemptId: begun.attemptId,
      promptId: manual?.promptId as AuthPromptId,
      value: 'fake-manual-answer',
    })

    batch = await ctx.openaiCodexAuth.readLogin({ attemptId: begun.attemptId, after: batch.next })
    const secret = batch.events.find(event => event.type === 'prompt')
    expect(secret).toMatchObject({ type: 'prompt', kind: 'secret' })
    ctx.openaiCodexAuth.respond({
      attemptId: begun.attemptId,
      promptId: secret?.promptId as AuthPromptId,
      value: 'fake-secret-answer',
    })

    batch = await ctx.openaiCodexAuth.readLogin({ attemptId: begun.attemptId, after: batch.next })
    expect(batch).toMatchObject({ terminal: true })
    expect(batch.events.at(-1)).toMatchObject({ type: 'terminal', state: 'succeeded' })
    expect(JSON.stringify(batch)).not.toContain('fake-secret-answer')
    expect(await ctx.openaiCodexAuth.status()).toMatchObject({ configured: true, source: 'memory' })

    await ctx.openaiCodexAuth.logout()
    expect(await ctx.openaiCodexAuth.status()).toMatchObject({ configured: false })
    await fiber.dispose()
  })

  it('fails before registration on malformed durable state and fails loud on route collisions', async () => {
    const malformed = await createHost({ [REF]: '{not-json' })
    await expect(malformed.ctx.plugin(HostPlugin, malformed.config))
      .rejects.toMatchObject({ code: 'INVALID_STORED_CREDENTIAL' })
    expect(malformed.ctx.llm.listProviders()).toEqual([])
    expect(malformed.ctx.llm.listConfigurableProviders()).toEqual([])

    const collision = await createHost()
    const first = await collision.ctx.plugin(HostPlugin, collision.config)
    await expect(collision.ctx.plugin({
      name: 'deepseek-openai-codex-collision-test',
      inject: HostPlugin.inject,
      apply: HostPlugin.apply,
    }, collision.config)).rejects.toThrow(/already|registered|route/i)
    expect(collision.ctx.llm.listProviders().filter(provider => provider.id === 'openai-codex')).toHaveLength(1)
    await first.dispose()
  })

  it('diagnoses required service absence without publishing partial state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openai-codex-host-'))
    roots.push(directory)
    await expect(HostPlugin.apply(new Context(), { lockDirectory: directory } as HostConfig))
      .rejects.toMatchObject({ code: 'MISSING_SERVICE' })
  })
})
