import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthCoordinator } from '../auth/coordinator.ts'
import type {
  AuthEventBatch,
  AuthStatus,
  BeginLoginResult,
  CancelLoginRequest,
  ReadLoginRequest,
  RespondLoginRequest,
  ResumeLoginResult,
} from '../auth/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    openaiCodexAuth: OpenAICodexAuthRemote
  }
}
/** Plugin-owned Typert service exposing only validated, secret-safe auth operations. */
export class OpenAICodexAuthRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly coordinator: AuthCoordinator) {
    super(ctx, 'openaiCodexAuth')
  }

  @Remote('status')
  status(): Promise<AuthStatus> {
    return this.coordinator.status()
  }

  @Remote('beginLogin')
  beginLogin(): Promise<BeginLoginResult> {
    return this.coordinator.beginLogin()
  }

  @Remote('resumeLogin')
  resumeLogin(): ResumeLoginResult | undefined {
    return this.coordinator.resumeLogin()
  }

  @Remote('readLogin')
  readLogin(request: ReadLoginRequest, signal?: AbortSignal): Promise<AuthEventBatch> {
    return this.coordinator.readLogin(request.attemptId, request.after, signal)
  }

  @Remote('respond')
  respond(request: RespondLoginRequest): void {
    this.coordinator.respond(request.attemptId, request.promptId, request.value)
  }

  @Remote('cancel')
  cancel(request: CancelLoginRequest): void {
    this.coordinator.cancel(request.attemptId)
  }

  @Remote('logout')
  logout(): Promise<void> {
    return this.coordinator.logout()
  }
}
