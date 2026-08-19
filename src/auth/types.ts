import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identifier for one Host-owned authentication attempt. */
export type AuthAttemptId = Branded<'OpenAICodexAuthAttemptId'>

/** Opaque identifier for one prompt belonging to one attempt. */
export type AuthPromptId = Branded<'OpenAICodexAuthPromptId'>

/** Safe credential and login state returned to browser settings. */
export interface AuthStatus {
  readonly configured: boolean
  readonly writable: boolean
  readonly source?: string
  readonly loginInProgress: boolean
}

/** One selection entry displayed by a Pi-owned prompt. */
export interface AuthSelectOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export interface AuthInfoLink {
  readonly url: string
  readonly label?: string
}

/** Sanitized, bounded event vocabulary retained only in Host memory. */
export type AuthEvent =
  | { readonly seq: number; readonly type: 'info' | 'progress'; readonly message: string; readonly links?: readonly AuthInfoLink[] }
  | { readonly seq: number; readonly type: 'auth-url'; readonly url: string; readonly instructions?: string }
  | {
    readonly seq: number
    readonly type: 'device-code'
    readonly userCode: string
    readonly verificationUri: string
    readonly expiresInSeconds?: number
  }
  | {
    readonly seq: number
    readonly type: 'prompt'
    readonly promptId: AuthPromptId
    readonly kind: 'text' | 'secret' | 'select' | 'manual_code'
    readonly message: string
    readonly placeholder?: string
    readonly options?: readonly AuthSelectOption[]
  }
  | {
    readonly seq: number
    readonly type: 'terminal'
    readonly state: 'succeeded' | 'failed' | 'cancelled' | 'expired'
    readonly code?: string
    readonly message: string
  }

/** A bounded long-poll response. */
export interface AuthEventBatch {
  readonly events: readonly AuthEvent[]
  readonly next: number
  readonly terminal: boolean
}

export interface BeginLoginResult {
  readonly attemptId: AuthAttemptId
}

export interface ResumeLoginResult {
  readonly attemptId: AuthAttemptId
}

export interface ReadLoginRequest {
  readonly attemptId: AuthAttemptId
  readonly after: number
}

export interface RespondLoginRequest {
  readonly attemptId: AuthAttemptId
  readonly promptId: AuthPromptId
  readonly value: string
}

export interface CancelLoginRequest {
  readonly attemptId: AuthAttemptId
}
