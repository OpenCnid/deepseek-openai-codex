/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthAttemptId, AuthEventBatch, AuthPromptId, AuthStatus } from '../../src/auth/types.ts'
import { AuthCard, type AuthRemote } from '../../src/client/auth-card.tsx'
import { inject, registerAuthCard } from '../../src/client/index.tsx'

const ATTEMPT = '11111111-1111-4111-8111-111111111111' as AuthAttemptId
const PROMPT = '22222222-2222-4222-8222-222222222222' as AuthPromptId
const SECRET = 'fake-browser-secret-never-persist'
const ok = <T,>(value: T): RemoteResult<T> => ({ ok: true, value })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function status(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return { configured: false, writable: true, loginInProgress: false, source: 'file', ...overrides }
}

function remote(overrides: Partial<AuthRemote> = {}): AuthRemote {
  return {
    status: vi.fn(async () => ok(status())),
    beginLogin: vi.fn(async () => ok({ attemptId: ATTEMPT })),
    resumeLogin: vi.fn(async () => ok(undefined)),
    readLogin: vi.fn(async () => ok({ events: [], next: 0, terminal: false })),
    respond: vi.fn(async () => ok(undefined)),
    cancel: vi.fn(async () => ok(undefined)),
    logout: vi.fn(async () => ok(undefined)),
    ...overrides,
  }
}

function oneBatchThenWait(batch: AuthEventBatch): AuthRemote['readLogin'] {
  let delivered = false
  return vi.fn(async (_request, signal) => {
    if (!delivered) {
      delivered = true
      return ok(batch)
    }
    return new Promise<RemoteResult<AuthEventBatch>>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
    })
  })
}

describe('OpenAI Codex settings card', () => {
  it('renders state and completes URL, device-code, and secret-prompt sign-in accessibly', async () => {
    let configured = false
    let releaseTerminal: (() => void) | undefined
    let readCount = 0
    const auth = remote({
      status: vi.fn(async () => ok(status({ configured, loginInProgress: !configured }))),
      readLogin: vi.fn(async (): Promise<RemoteResult<AuthEventBatch>> => {
        readCount += 1
        if (readCount === 1) {
          return ok({
            events: [
              { seq: 1, type: 'progress', message: 'Waiting for browser sign-in.' },
              { seq: 2, type: 'auth-url', url: 'https://auth.example.test/start', instructions: 'Open the safe sign-in page.' },
              { seq: 3, type: 'device-code', userCode: 'SAFE-CODE', verificationUri: 'https://auth.example.test/device' },
              { seq: 4, type: 'prompt', promptId: PROMPT, kind: 'secret', message: 'One-time secret' },
            ],
            next: 4,
            terminal: false,
          })
        }
        await new Promise<void>(resolve => { releaseTerminal = resolve })
        configured = true
        return ok({ events: [{ seq: 5, type: 'terminal', state: 'succeeded', message: 'Configured.' }], next: 5, terminal: true })
      }),
      respond: vi.fn(async () => {
        releaseTerminal?.()
        return ok(undefined)
      }),
    })
    const localSet = vi.spyOn(Storage.prototype, 'setItem')
    render(<AuthCard auth={auth} />)

    const signIn = await screen.findByRole('button', { name: 'Sign in with ChatGPT' })
    expect(screen.getByText(/not use an OpenAI API key/i)).toBeTruthy()
    fireEvent.click(signIn)
    expect((await screen.findByRole('link', { name: 'Open ChatGPT sign-in' })).getAttribute('href')).toBe('https://auth.example.test/start')
    expect(screen.getByText('SAFE-CODE')).toBeTruthy()
    const secret = await screen.findByLabelText('One-time secret')
    expect(secret.getAttribute('type')).toBe('password')
    fireEvent.change(secret, { target: { value: SECRET } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => {
      expect(auth.respond).toHaveBeenCalledWith({ attemptId: ATTEMPT, promptId: PROMPT, value: SECRET })
      expect(screen.getAllByText('Configured').length).toBeGreaterThan(0)
    })
    expect(screen.queryByText('SAFE-CODE')).toBeNull()
    expect(screen.queryByLabelText('One-time secret')).toBeNull()
    expect(localSet).not.toHaveBeenCalled()
  })

  it.each([
    ['text', undefined, 'text'],
    ['manual_code', 'Paste callback', 'text'],
  ] as const)('renders and focuses the %s prompt', async (kind, placeholder, inputType) => {
    const auth = remote({
      resumeLogin: vi.fn(async () => ok({ attemptId: ATTEMPT })),
      status: vi.fn(async () => ok(status({ loginInProgress: true }))),
      readLogin: oneBatchThenWait({
        events: [{ seq: 1, type: 'prompt', promptId: PROMPT, kind, message: 'Enter value', ...(placeholder === undefined ? {} : { placeholder }) }],
        next: 1,
        terminal: false,
      }),
    })
    render(<AuthCard auth={auth} />)
    const input = await screen.findByLabelText('Enter value')
    expect(input.getAttribute('type')).toBe(inputType)
    expect(document.activeElement).toBe(input)
  })

  it('renders select prompts and validates selection before continuing', async () => {
    const auth = remote({
      resumeLogin: vi.fn(async () => ok({ attemptId: ATTEMPT })),
      status: vi.fn(async () => ok(status({ loginInProgress: true }))),
      readLogin: oneBatchThenWait({
        events: [{
          seq: 1,
          type: 'prompt',
          promptId: PROMPT,
          kind: 'select',
          message: 'Choose account',
          options: [{ id: 'personal', label: 'Personal' }, { id: 'team', label: 'Team' }],
        }],
        next: 1,
        terminal: false,
      }),
    })
    render(<AuthCard auth={auth} />)
    const select = await screen.findByLabelText('Choose account')
    fireEvent.change(select, { target: { value: 'team' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => { expect(auth.respond).toHaveBeenCalledWith({ attemptId: ATTEMPT, promptId: PROMPT, value: 'team' }) })
  })

  it('recovers a Host attempt after reload, supports cancel, and offers retry after failure', async () => {
    let cancelled = false
    let release: (() => void) | undefined
    const auth = remote({
      status: vi.fn(async () => ok(status({ loginInProgress: true }))),
      resumeLogin: vi.fn(async () => ok({ attemptId: ATTEMPT })),
      readLogin: vi.fn(async () => {
        if (!cancelled) {
          await new Promise<void>(resolve => { release = resolve })
        }
        return ok({
          events: [{ seq: 2, type: 'terminal', state: 'failed', code: 'AUTH_FAILED', message: 'Sign-in failed safely.' }],
          next: 2,
          terminal: true,
        })
      }),
      cancel: vi.fn(async () => {
        cancelled = true
        release?.()
        return ok(undefined)
      }),
    })
    render(<AuthCard auth={auth} />)
    const cancel = await screen.findByRole('button', { name: 'Cancel sign-in' })
    fireEvent.click(cancel)
    await waitFor(() => { expect(auth.cancel).toHaveBeenCalledWith({ attemptId: ATTEMPT }) })
    expect(await screen.findByRole('button', { name: 'Retry sign-in' })).toBeTruthy()
    expect(auth.resumeLogin).toHaveBeenCalledTimes(1)
  })

  it('requires explicit logout confirmation and restores button focus', async () => {
    let configured = true
    const auth = remote({
      status: vi.fn(async () => ok(status({ configured, loginInProgress: false }))),
      logout: vi.fn(async () => { configured = false; return ok(undefined) }),
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<AuthCard auth={auth} />)
    const button = await screen.findByRole('button', { name: 'Log out' })
    fireEvent.click(button)
    expect(auth.logout).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    await waitFor(() => { expect(auth.logout).toHaveBeenCalledTimes(1) })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }))
  })

  it('shows Remote failures without interpreting unsafe URLs', async () => {
    const auth = remote({
      beginLogin: vi.fn(async () => ({ ok: false, error: { code: 'AUTH_FAILED', message: 'Safe sign-in failure.', details: {} } })),
      resumeLogin: vi.fn(async () => ok({ attemptId: ATTEMPT })),
      status: vi.fn(async () => ok(status({ loginInProgress: true }))),
      readLogin: oneBatchThenWait({
        events: [{ seq: 1, type: 'auth-url', url: 'javascript:alert(1)', instructions: 'Unsafe' }],
        next: 1,
        terminal: false,
      }),
    })
    render(<AuthCard auth={auth} />)
    await waitFor(() => { expect(auth.readLogin).toHaveBeenCalled() })
    expect(screen.queryByRole('link', { name: 'Open ChatGPT sign-in' })).toBeNull()
  })
})

describe('real DSH slot-core registration', () => {
  it('registers exactly one keyed settings.plugin.item card and unloads it', () => {
    const core = new SlotCore()
    const releaseRoot = core.register({
      name: 'root',
      children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } },
    }, () => null)
    let releaseCard: (() => void) | undefined
    const ctx = {
      remote: { openaiCodexAuth: remote() },
      slots: {
        inject: (_name: string, callback: () => () => void) => {
          releaseCard = callback()
          return () => { releaseCard?.() }
        },
        register: core.register.bind(core),
      },
    }
    expect(inject).toEqual(['slots', 'remote'])
    registerAuthCard(ctx as never)
    expect(core.entries('settings.plugin.item')).toHaveLength(1)
    expect(core.entries('settings.plugin.item')[0]).toMatchObject({ options: { key: 'deepseek-openai-codex' } })
    releaseCard?.()
    expect(core.entries('settings.plugin.item')).toHaveLength(0)
    releaseRoot()
  })
})
