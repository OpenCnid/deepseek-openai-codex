import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AuthAttemptId,
  AuthEvent,
  AuthEventBatch,
  AuthPromptId,
  AuthStatus,
  BeginLoginResult,
  CancelLoginRequest,
  ReadLoginRequest,
  RespondLoginRequest,
  ResumeLoginResult,
} from '../auth/types.ts'

export interface AuthRemote {
  status(): Promise<RemoteResult<AuthStatus>>
  beginLogin(): Promise<RemoteResult<BeginLoginResult>>
  resumeLogin(): Promise<RemoteResult<ResumeLoginResult | undefined>>
  readLogin(request: ReadLoginRequest, signal?: AbortSignal): Promise<RemoteResult<AuthEventBatch>>
  respond(request: RespondLoginRequest): Promise<RemoteResult<void>>
  cancel(request: CancelLoginRequest): Promise<RemoteResult<void>>
  logout(): Promise<RemoteResult<void>>
}

export interface AuthCardProps {
  readonly auth: AuthRemote
}

const EMPTY_STATUS: AuthStatus = Object.freeze({
  configured: false,
  writable: false,
  loginInProgress: false,
})

/** Complete browser interaction surface; all durable and secret work stays Host-side. */
export function AuthCard({ auth }: AuthCardProps): ReactElement {
  const [status, setStatus] = useState<AuthStatus>(EMPTY_STATUS)
  const [events, setEvents] = useState<readonly AuthEvent[]>([])
  const [attemptId, setAttemptId] = useState<AuthAttemptId>()
  const [busy, setBusy] = useState(true)
  const [failure, setFailure] = useState<string>()
  const [answer, setAnswer] = useState('')
  const [answered, setAnswered] = useState<ReadonlySet<AuthPromptId>>(() => new Set())
  const polling = useRef<AbortController>()
  const promptInput = useRef<HTMLInputElement | HTMLSelectElement>(null)
  const signInButton = useRef<HTMLButtonElement>(null)
  const logoutButton = useRef<HTMLButtonElement>(null)

  const terminal = useMemo(
    () => [...events].reverse().find((event): event is Extract<AuthEvent, { type: 'terminal' }> => event.type === 'terminal'),
    [events],
  )
  const prompt = useMemo(
    () => terminal === undefined
      ? [...events].reverse().find((event): event is Extract<AuthEvent, { type: 'prompt' }> => event.type === 'prompt' && !answered.has(event.promptId))
      : undefined,
    [answered, events, terminal],
  )
  const authUrl = terminal === undefined
    ? [...events].reverse().find((event): event is Extract<AuthEvent, { type: 'auth-url' }> => event.type === 'auth-url')
    : undefined
  const device = terminal === undefined
    ? [...events].reverse().find((event): event is Extract<AuthEvent, { type: 'device-code' }> => event.type === 'device-code')
    : undefined

  useEffect(() => {
    const lifetime = new AbortController()
    void initialize(lifetime.signal)
    return () => {
      lifetime.abort()
      polling.current?.abort()
    }

    async function initialize(signal: AbortSignal): Promise<void> {
      try {
        const [nextStatus, resumable] = await Promise.all([
          unwrap(await auth.status()),
          unwrap(await auth.resumeLogin()),
        ])
        if (signal.aborted) return
        setStatus(nextStatus)
        if (resumable !== undefined) {
          setAttemptId(resumable.attemptId)
          setEvents([])
          void poll(resumable.attemptId, 0, signal)
        }
      } catch (error: unknown) {
        if (!signal.aborted) setFailure(safeClientError(error))
      } finally {
        if (!signal.aborted) setBusy(false)
      }
    }
  }, [auth])

  useEffect(() => {
    setAnswer('')
    promptInput.current?.focus()
  }, [prompt?.promptId])

  async function refreshStatus(): Promise<void> {
    setStatus(unwrap(await auth.status()))
  }

  async function startLogin(): Promise<void> {
    setBusy(true)
    setFailure(undefined)
    setEvents([])
    setAnswered(new Set())
    try {
      const started = unwrap(await auth.beginLogin())
      setAttemptId(started.attemptId)
      await refreshStatus()
      void poll(started.attemptId, 0)
    } catch (error: unknown) {
      setFailure(safeClientError(error))
      signInButton.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  async function poll(id: AuthAttemptId, initialCursor: number, parentSignal?: AbortSignal): Promise<void> {
    polling.current?.abort()
    const controller = new AbortController()
    polling.current = controller
    const signal = parentSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, parentSignal])
    let cursor = initialCursor
    try {
      while (!signal.aborted) {
        const batch = unwrap(await auth.readLogin({ attemptId: id, after: cursor }, signal))
        if (signal.aborted) return
        cursor = batch.next
        if (batch.events.length > 0) {
          setEvents(current => mergeEvents(current, batch.events))
        }
        if (batch.terminal) {
          await refreshStatus()
          setAttemptId(undefined)
          setAnswer('')
          queueMicrotask(() => signInButton.current?.focus())
          return
        }
      }
    } catch (error: unknown) {
      if (!signal.aborted) setFailure(safeClientError(error))
    }
  }

  async function submitPrompt(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (attemptId === undefined || prompt === undefined) return
    const value = answer
    setAnswer('')
    setBusy(true)
    try {
      unwrap(await auth.respond({ attemptId, promptId: prompt.promptId, value }))
      setAnswered(current => new Set([...current, prompt.promptId]))
    } catch (error: unknown) {
      setFailure(safeClientError(error))
      if (prompt.kind !== 'secret') setAnswer(value)
    } finally {
      setBusy(false)
    }
  }

  async function cancelLogin(): Promise<void> {
    if (attemptId === undefined) return
    setBusy(true)
    try {
      unwrap(await auth.cancel({ attemptId }))
    } catch (error: unknown) {
      setFailure(safeClientError(error))
    } finally {
      setBusy(false)
    }
  }

  async function logout(): Promise<void> {
    if (!window.confirm('Log out the ChatGPT subscription credential from this DSH profile?')) {
      logoutButton.current?.focus()
      return
    }
    setBusy(true)
    setFailure(undefined)
    let loggedOut = false
    try {
      unwrap(await auth.logout())
      setEvents([])
      setAnswered(new Set())
      await refreshStatus()
      loggedOut = true
    } catch (error: unknown) {
      setFailure(safeClientError(error))
    } finally {
      setBusy(false)
      queueMicrotask(() => {
        if (loggedOut) signInButton.current?.focus()
        else logoutButton.current?.focus()
      })
    }
  }

  const live = attemptId !== undefined && terminal === undefined
  const messages = events.filter((event): event is Extract<AuthEvent, { type: 'info' | 'progress' }> => event.type === 'info' || event.type === 'progress')

  return (
    <section className="docx-card" aria-labelledby="docx-title">
      <style>{CARD_CSS}</style>
      <header className="docx-header">
        <div>
          <p className="docx-eyebrow">Model provider</p>
          <h3 id="docx-title">OpenAI Codex</h3>
        </div>
        <span className={`docx-badge ${status.configured ? 'is-ready' : ''}`}>
          {status.configured ? 'Configured' : 'Not configured'}
        </span>
      </header>

      <p className="docx-copy">
        Uses your eligible ChatGPT subscription through Pi’s direct Codex path. It does not use an OpenAI API key or API-key billing.
      </p>
      <dl className="docx-facts">
        <div><dt>Credential source</dt><dd>{status.source ?? 'Not configured'}</dd></div>
        <div><dt>Writable</dt><dd>{status.writable ? 'Yes' : 'No'}</dd></div>
      </dl>

      {messages.length > 0 && (
        <div className="docx-log" aria-live="polite">
          {messages.map(message => <p key={message.seq}>{message.message}</p>)}
        </div>
      )}

      {authUrl !== undefined && safeBrowserUrl(authUrl.url) !== undefined && (
        <div className="docx-step">
          <p>{authUrl.instructions ?? 'Continue sign-in in your browser.'}</p>
          <a className="docx-button primary" href={safeBrowserUrl(authUrl.url)} target="_blank" rel="noopener noreferrer">
            Open ChatGPT sign-in
          </a>
        </div>
      )}

      {device !== undefined && (
        <div className="docx-step" aria-live="polite">
          <p>Enter this temporary device code at the verification page:</p>
          <code className="docx-code">{device.userCode}</code>
          {safeBrowserUrl(device.verificationUri) !== undefined && (
            <a href={safeBrowserUrl(device.verificationUri)} target="_blank" rel="noopener noreferrer">Open verification page</a>
          )}
        </div>
      )}

      {prompt !== undefined && (
        <form className="docx-prompt" onSubmit={event => { void submitPrompt(event) }}>
          <label htmlFor={`docx-prompt-${prompt.promptId}`}>{prompt.message}</label>
          {prompt.kind === 'select' ? (
            <select
              id={`docx-prompt-${prompt.promptId}`}
              ref={promptInput as React.RefObject<HTMLSelectElement>}
              value={answer}
              onChange={event => { setAnswer(event.target.value) }}
              required
            >
              <option value="">Choose an option</option>
              {prompt.options?.map(option => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          ) : (
            <input
              id={`docx-prompt-${prompt.promptId}`}
              ref={promptInput as React.RefObject<HTMLInputElement>}
              type={prompt.kind === 'secret' ? 'password' : 'text'}
              autoComplete={prompt.kind === 'secret' ? 'off' : 'one-time-code'}
              placeholder={prompt.placeholder}
              value={answer}
              onChange={event => { setAnswer(event.target.value) }}
              required
            />
          )}
          <button className="docx-button primary" type="submit" disabled={busy || answer.length === 0}>Continue</button>
        </form>
      )}

      {terminal !== undefined && (
        <p className={`docx-terminal is-${terminal.state}`} role={terminal.state === 'succeeded' ? 'status' : 'alert'}>
          {terminal.message}
        </p>
      )}
      {failure !== undefined && <p className="docx-error" role="alert">{failure}</p>}
      {!status.writable && !status.configured && (
        <p className="docx-note" role="status">The active DSH credential source is read-only or shadowed. Make it writable before signing in.</p>
      )}

      <div className="docx-actions">
        {!status.configured && !live && (
          <button ref={signInButton} className="docx-button primary" type="button" disabled={busy || !status.writable} onClick={() => { void startLogin() }}>
            {terminal !== undefined && terminal.state !== 'succeeded' ? 'Retry sign-in' : 'Sign in with ChatGPT'}
          </button>
        )}
        {live && (
          <button className="docx-button danger" type="button" disabled={busy} onClick={() => { void cancelLogin() }}>Cancel sign-in</button>
        )}
        {status.configured && (
          <button ref={logoutButton} className="docx-button danger" type="button" disabled={busy} onClick={() => { void logout() }}>Log out</button>
        )}
      </div>
    </section>
  )
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

function safeClientError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message.slice(0, 2_048)
    : 'The OpenAI Codex operation could not be completed.'
}

function mergeEvents(current: readonly AuthEvent[], incoming: readonly AuthEvent[]): readonly AuthEvent[] {
  const events = new Map(current.map(event => [event.seq, event]))
  for (const event of incoming) events.set(event.seq, event)
  return [...events.values()].sort((left, right) => left.seq - right.seq)
}

function safeBrowserUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    return url.protocol === 'https:' || loopback ? url.toString() : undefined
  } catch {
    return undefined
  }
}

const CARD_CSS = `
.docx-card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:16px;padding:20px;background:color-mix(in srgb,Canvas 96%,#10a37f 4%);color:CanvasText;box-shadow:0 8px 28px rgba(0,0,0,.06)}
.docx-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.docx-header h3{font-size:1.15rem;margin:2px 0 0}.docx-eyebrow{font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;opacity:.65;margin:0}
.docx-badge{border-radius:999px;padding:5px 10px;background:color-mix(in srgb,currentColor 8%,transparent);font-size:.78rem;white-space:nowrap}.docx-badge.is-ready{background:#0f7b5c;color:white}
.docx-copy,.docx-note{line-height:1.55}.docx-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}.docx-facts div{padding:10px 12px;border-radius:10px;background:color-mix(in srgb,currentColor 5%,transparent)}.docx-facts dt{font-size:.72rem;opacity:.65}.docx-facts dd{margin:3px 0 0;font-weight:600;overflow-wrap:anywhere}
.docx-log,.docx-step,.docx-prompt{display:grid;gap:10px;margin:14px 0;padding:14px;border-radius:12px;background:color-mix(in srgb,currentColor 6%,transparent)}.docx-log p,.docx-step p{margin:0}.docx-prompt label{font-weight:650}.docx-prompt input,.docx-prompt select{width:100%;box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:9px;padding:10px;background:Canvas;color:CanvasText;font:inherit}
.docx-code{display:inline-block;width:max-content;max-width:100%;font-size:1.2rem;letter-spacing:.1em;padding:8px 12px;border-radius:8px;background:Canvas;overflow-wrap:anywhere}.docx-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.docx-button{display:inline-flex;align-items:center;justify-content:center;border:1px solid currentColor;border-radius:9px;padding:9px 13px;background:transparent;color:inherit;font:inherit;font-weight:650;cursor:pointer;text-decoration:none}.docx-button.primary{background:#0f7b5c;border-color:#0f7b5c;color:white}.docx-button.danger{color:#b42318}.docx-button:disabled{cursor:not-allowed;opacity:.5}.docx-button:focus-visible,.docx-prompt input:focus-visible,.docx-prompt select:focus-visible,a:focus-visible{outline:3px solid #69b7ff;outline-offset:2px}
.docx-terminal,.docx-error,.docx-note{border-radius:9px;padding:10px 12px;margin:12px 0 0}.docx-terminal.is-succeeded{background:#e5f7ef;color:#075a43}.docx-terminal.is-failed,.docx-terminal.is-expired,.docx-error{background:#ffebe9;color:#8a1c13}.docx-terminal.is-cancelled,.docx-note{background:color-mix(in srgb,currentColor 7%,transparent)}
@media (max-width:560px){.docx-card{padding:15px}.docx-header{align-items:flex-start;flex-direction:column}.docx-actions .docx-button{width:100%}}
@media (prefers-reduced-motion:no-preference){.docx-card{animation:docx-in .18s ease-out}@keyframes docx-in{from{opacity:0;transform:translateY(4px)}}}
`
