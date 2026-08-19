/**
 * DeepSeek Harness plugin for Pi's direct ChatGPT-subscription Codex route.
 * The Host owns OAuth, durable credential access, and provider transport.
 */
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { OPENAI_CODEX_PROVIDER, PROVIDER_DISPLAY_NAME, SETTINGS_NAMESPACE } from './constants.ts'
import { Config, resolveConfig, type Config as ConfigShape } from './config.ts'
import { OpenAICodexAdapter } from './adapter.ts'
import { AuthCoordinator } from './auth/coordinator.ts'
import { DshPiCredentialStore } from './auth/credential-store.ts'
import { OpenAICodexError } from './errors.ts'
import { OpenAICodexAuthRemote } from './typert/auth.remote.ts'

export { OpenAICodexAdapter } from './adapter.ts'
export { AuthCoordinator } from './auth/coordinator.ts'
export { DshPiCredentialStore } from './auth/credential-store.ts'
export { decodeCredential, encodeCredential } from './auth/credential-codec.ts'
export { Config, resolveConfig } from './config.ts'
export { OPENAI_CODEX_PROVIDER, PROVIDER_DISPLAY_NAME, SETTINGS_NAMESPACE } from './constants.ts'
export { OpenAICodexError } from './errors.ts'
export { OpenAICodexAuthRemote } from './typert/auth.remote.ts'
export type * from './auth/types.ts'
export type { Config as OpenAICodexConfig, ResolvedConfig } from './config.ts'

export const name = 'deepseek-openai-codex'
export const inject = ['llm', 'credentials']

const NS = settingsNamespace(SETTINGS_NAMESPACE)

/** Mount exactly one provider route, one directory entry, and one auth Remote. */
export async function apply(ctx: Context, entry: ConfigShape): Promise<void> {
  const llm = ctx.get('llm')
  const credentials = ctx.get('credentials')
  if (llm === undefined) {
    throw new OpenAICodexError('MISSING_SERVICE', 'deepseek-openai-codex: required DSH llm service is unavailable')
  }
  if (credentials === undefined) {
    throw new OpenAICodexError('MISSING_SERVICE', 'deepseek-openai-codex: required DSH credentials service is unavailable')
  }

  const config = resolveConfig(entry)
  const store = new DshPiCredentialStore(credentials, {
    reference: config.credentialRef,
    acquireTimeoutMs: config.credentialLockAcquireTimeoutMs,
    staleMs: config.credentialLockStaleMs,
    ...(config.lockDirectory === undefined ? {} : { directory: config.lockDirectory }),
  })
  // Decode configured durable state before publishing a route that cannot use it.
  await store.validateDurable()

  const adapter = new OpenAICodexAdapter({
    credentials: store,
    timeoutMs: config.adapterTimeoutMs,
    resolveAttachments: () => ctx.get('attachments'),
    onReplayDegrade: reason => { ctx.logger.warn(`deepseek-openai-codex: ignored unusable replay state (${reason})`) },
  })
  const coordinator = new AuthCoordinator(adapter.models, store, {
    attemptLifetimeMs: config.loginAttemptLifetimeMs,
    replayCapacity: config.authEventReplayCapacity,
    readTimeoutMs: config.authReadTimeoutMs,
  })

  // The namespace exists for provider routing and documents that these values
  // apply on restart; OAuth material never enters settings.
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.register(NS, Config, {
      base: entry,
      applies: 'restart',
      validate: value => { resolveConfig(value) },
    })
  })

  llm.registerConfigurableProviders([{
    provider: OPENAI_CODEX_PROVIDER,
    displayName: PROVIDER_DISPLAY_NAME,
    settingsNs: NS,
    settingsPath: [],
  }])
  llm.registerAdapter([OPENAI_CODEX_PROVIDER], adapter)
  new OpenAICodexAuthRemote(ctx, coordinator)

  ctx.effect(() => async () => {
    adapter.dispose()
    await coordinator.dispose()
  }, 'deepseek-openai-codex.runtime')
}
