import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthInteraction, Models, OAuthCredential } from '@earendil-works/pi-ai'
import type { AuthAttemptId, AuthEventBatch, AuthPromptId } from '../../src/auth/types.ts'
import type { DshPiCredentialStore } from '../../src/auth/credential-store.ts'
import { AuthCoordinator } from '../../src/auth/coordinator.ts'

const SECRET = 'fake-secret-answer-never-retain'
const options = { attemptLifetimeMs: 100, replayCapacity: 8, readTimeoutMs: 25 }

afterEach(() => { vi.useRealTimers() })

class FakeStore {
  configured = false
  writable = true
  source = 'file'
  credential: OAuthCredential = {
    type: 'oauth',
    access: 'fake-access',
    refresh: 'fake-refresh',
    expires: Date.now() + 60_000,
    accountId: 'acct_fake',
  }

  async read(): Promise<OAuthCredential | undefined> {
    return this.configured ? this.credential : undefined
  }

  async describe() {
    return { configured: this.configured, writable: this.writable, ...(this.configured ? { source: this.source } : {}) }
  }

  async assertLoginWritable() {
    if (!this.writable) throw Object.assign(new Error('read only'), { code: 'CREDENTIAL_READ_ONLY' })
    if (this.configured) throw Object.assign(new Error('already configured'), { code: 'CREDENTIAL_ALREADY_CONFIGURED' })
    return this.describe()
  }
}

function coordinator(
  login: (interaction: AuthInteraction) => Promise<void>,
  overrides: Partial<typeof options> = {},
): { subject: AuthCoordinator; store: FakeStore; logout: ReturnType<typeof vi.fn> } {
  const store = new FakeStore()
  const logout = vi.fn(async () => { store.configured = false })
  const models = {
    login: vi.fn(async (_provider: string, _type: string, interaction: AuthInteraction) => login(interaction)),
    logout,
  } as unknown as Models
  return {
    subject: new AuthCoordinator(models, store as unknown as DshPiCredentialStore, { ...options, ...overrides }),
    store,
    logout,
  }
}

async function next(subject: AuthCoordinator, attemptId: AuthAttemptId, after = 0): Promise<AuthEventBatch> {
  return subject.readLogin(attemptId, after)
}

async function readTerminal(subject: AuthCoordinator, attemptId: AuthAttemptId, after = 0): Promise<AuthEventBatch> {
  let cursor = after
  const events: AuthEventBatch['events'][number][] = []
  while (true) {
    const batch = await next(subject, attemptId, cursor)
    events.push(...batch.events)
    cursor = batch.next
    if (batch.terminal) return { events, next: cursor, terminal: true }
  }
}

describe('AuthCoordinator', () => {
  it('correlates a manual-code prompt, commits before success, and drops transient values', async () => {
    const setup = coordinator(async interaction => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example.test/start', instructions: 'Open the sign-in page.' })
      interaction.notify({ type: 'device_code', userCode: 'SAFE-CODE', verificationUri: 'https://auth.example.test/device' })
      const answer = await interaction.prompt({ type: 'manual_code', message: 'Paste the callback code', placeholder: 'code' })
      expect(answer).toBe(SECRET)
      setup.store.configured = true
    })
    const begun = await setup.subject.beginLogin()
    const first = await next(setup.subject, begun.attemptId)
    expect(first.events.map(event => event.type)).toEqual(expect.arrayContaining(['info', 'auth-url', 'device-code', 'prompt']))
    const prompt = first.events.find(event => event.type === 'prompt')
    expect(prompt).toBeDefined()
    setup.subject.respond(begun.attemptId, prompt?.promptId as AuthPromptId, SECRET)
    const done = await next(setup.subject, begun.attemptId, first.next)
    expect(done.terminal).toBe(true)
    expect(done.events.at(-1)).toMatchObject({ type: 'terminal', state: 'succeeded' })
    expect(JSON.stringify(done)).not.toContain(SECRET)
    expect(done.events.some(event => event.type === 'device-code' || event.type === 'auth-url' || event.type === 'prompt')).toBe(false)
    expect((await setup.subject.status()).configured).toBe(true)
    await setup.subject.dispose()
  })

  it('supports select and secret prompts while rejecting wrong and duplicate replies', async () => {
    const setup = coordinator(async interaction => {
      const choice = await interaction.prompt({
        type: 'select',
        message: 'Choose account',
        options: [{ id: 'personal', label: 'Personal' }, { id: 'team', label: 'Team' }],
      })
      expect(choice).toBe('personal')
      const secret = await interaction.prompt({ type: 'secret', message: 'One-time secret' })
      expect(secret).toBe(SECRET)
      setup.store.configured = true
    })
    const { attemptId } = await setup.subject.beginLogin()
    let batch = await next(setup.subject, attemptId)
    const select = batch.events.find(event => event.type === 'prompt')
    expect(() => setup.subject.respond(attemptId, select?.promptId as AuthPromptId, 'invalid')).toThrow(expect.objectContaining({ code: 'INVALID_AUTH_REPLY' }))
    setup.subject.respond(attemptId, select?.promptId as AuthPromptId, 'personal')
    expect(() => setup.subject.respond(attemptId, select?.promptId as AuthPromptId, 'personal')).toThrow(expect.objectContaining({ code: 'STALE_AUTH_PROMPT' }))
    batch = await next(setup.subject, attemptId, batch.next)
    const secret = batch.events.find(event => event.type === 'prompt')
    expect(secret).toMatchObject({ type: 'prompt', kind: 'secret' })
    setup.subject.respond(attemptId, secret?.promptId as AuthPromptId, SECRET)
    const done = await readTerminal(setup.subject, attemptId, batch.next)
    expect(JSON.stringify(done)).not.toContain(SECRET)
    await setup.subject.dispose()
  })

  it('rejects a concurrent begin but explicitly resumes the live attempt', async () => {
    const setup = coordinator(interaction => new Promise((_resolve, reject) => {
      interaction.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    const begun = await setup.subject.beginLogin()
    await expect(setup.subject.beginLogin()).rejects.toMatchObject({ code: 'AUTH_IN_PROGRESS' })
    expect(setup.subject.resumeLogin()).toEqual({ attemptId: begun.attemptId })
    setup.subject.cancel(begun.attemptId)
    const done = await readTerminal(setup.subject, begun.attemptId)
    expect(done.events.at(-1)).toMatchObject({ type: 'terminal', state: 'cancelled' })
    await setup.subject.dispose()
  })

  it('bounds replay monotonically while retaining a live prompt', async () => {
    const setup = coordinator(async interaction => {
      for (let index = 0; index < 20; index += 1) interaction.notify({ type: 'progress', message: `step ${index}` })
      await interaction.prompt({ type: 'text', message: 'Required input' })
    }, { replayCapacity: 5 })
    const { attemptId } = await setup.subject.beginLogin()
    const batch = await next(setup.subject, attemptId)
    expect(batch.events).toHaveLength(5)
    expect(batch.events.some(event => event.type === 'prompt')).toBe(true)
    expect(batch.events.map(event => event.seq)).toEqual(batch.events.map(event => event.seq).sort((a, b) => a - b))
    setup.subject.cancel(attemptId)
    await setup.subject.dispose()
  })

  it('expires attempts and sanitizes raw provider failures', async () => {
    vi.useFakeTimers()
    const setup = coordinator(interaction => new Promise((_resolve, reject) => {
      interaction.signal?.addEventListener('abort', () => { reject(new Error(SECRET)) }, { once: true })
    }), { attemptLifetimeMs: 50 })
    const { attemptId } = await setup.subject.beginLogin()
    await vi.advanceTimersByTimeAsync(50)
    const expired = await next(setup.subject, attemptId)
    expect(expired.events.at(-1)).toMatchObject({ type: 'terminal', state: 'expired', code: 'AUTH_EXPIRED' })
    expect(JSON.stringify(expired)).not.toContain(SECRET)
    await setup.subject.dispose()

    vi.useRealTimers()
    const failed = coordinator(async () => { throw new Error(`HTTP 401 ${SECRET}`) })
    const second = await failed.subject.beginLogin()
    const result = await readTerminal(failed.subject, second.attemptId)
    expect(result.events.at(-1)).toMatchObject({ type: 'terminal', state: 'failed', code: 'AUTH_FAILED' })
    expect(JSON.stringify(result)).not.toContain(SECRET)
    await failed.subject.dispose()
  })

  it('settles a pending long poll and aborts login on Host disposal', async () => {
    const setup = coordinator(interaction => new Promise((_resolve, reject) => {
      interaction.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }), { readTimeoutMs: 10_000 })
    const { attemptId } = await setup.subject.beginLogin()
    const initial = await next(setup.subject, attemptId)
    const pending = next(setup.subject, attemptId, initial.next)
    await setup.subject.dispose()
    await expect(pending).resolves.toMatchObject({ terminal: true })
    await expect(setup.subject.status()).rejects.toMatchObject({ code: 'PLUGIN_DISPOSED' })
  })

  it('uses Pi logout and refuses logout during login', async () => {
    const setup = coordinator(interaction => new Promise((_resolve, reject) => {
      interaction.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    setup.store.configured = true
    await setup.subject.logout()
    expect(setup.logout).toHaveBeenCalledWith('openai-codex')
    setup.store.configured = false
    const { attemptId } = await setup.subject.beginLogin()
    await expect(setup.subject.logout()).rejects.toMatchObject({ code: 'AUTH_IN_PROGRESS' })
    setup.subject.cancel(attemptId)
    await setup.subject.dispose()
  })
})
