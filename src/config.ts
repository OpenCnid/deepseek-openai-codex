import { isAbsolute } from 'node:path'
import s from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { DEFAULT_CREDENTIAL_REF } from './constants.ts'

/** Deployment-varying plugin configuration. Protocol constants are not tunable. */
export interface Config {
  credentialRef: string
  loginAttemptLifetimeMs: number
  authEventReplayCapacity: number
  authReadTimeoutMs: number
  credentialLockAcquireTimeoutMs: number
  credentialLockStaleMs: number
  lockDirectory?: string
  adapterTimeoutMs: number
}

/** Cordis loader schema for every deployment-varying value. */
export const Config: s<Config> = s.object({
  credentialRef: s.string().default(DEFAULT_CREDENTIAL_REF),
  loginAttemptLifetimeMs: s.number().step(1).min(30_000).max(3_600_000).default(600_000),
  authEventReplayCapacity: s.number().step(1).min(8).max(256).default(64),
  authReadTimeoutMs: s.number().step(1).min(1_000).max(60_000).default(25_000),
  credentialLockAcquireTimeoutMs: s.number().step(1).min(100).max(120_000).default(10_000),
  credentialLockStaleMs: s.number().step(1).min(5_000).max(600_000).default(30_000),
  lockDirectory: s.string(),
  adapterTimeoutMs: s.number().step(1).min(1_000).max(600_000).default(120_000),
})

/** Fully validated internal configuration and branded credential reference. */
export interface ResolvedConfig extends Omit<Config, 'credentialRef'> {
  credentialRef: CredentialRef
}

/** Revalidate constraints whose meaning is outside Schemastery's scalar grammar. */
export function resolveConfig(input: Config): ResolvedConfig {
  const parsed = Config(input)
  if (parsed.lockDirectory !== undefined && !isAbsolute(parsed.lockDirectory)) {
    throw new TypeError('deepseek-openai-codex: lockDirectory must be an absolute path')
  }
  if (parsed.credentialLockStaleMs <= parsed.credentialLockAcquireTimeoutMs / 4) {
    throw new TypeError('deepseek-openai-codex: credentialLockStaleMs must exceed one quarter of the acquisition timeout')
  }
  return { ...parsed, credentialRef: credentialRef(parsed.credentialRef) }
}
