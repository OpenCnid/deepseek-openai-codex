import type { Credential, OAuthCredential } from '@earendil-works/pi-ai'
import { OpenAICodexError } from '../errors.ts'

const MAX_SERIALIZED_BYTES = 256 * 1024
const MAX_SECRET_CHARS = 128 * 1024

/** Parse and validate the one durable Pi OAuth credential without echoing it. */
export function decodeCredential(serialized: string): OAuthCredential {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) {
    throw invalidCredential('stored OAuth JSON exceeds the supported size limit')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw invalidCredential('stored OAuth value is not valid JSON')
  }
  return validateCredential(parsed)
}

/** Validate and compactly encode a Pi OAuth credential for DSH storage. */
export function encodeCredential(credential: Credential): string {
  const validated = validateCredential(credential)
  const serialized = JSON.stringify(validated)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) {
    throw invalidCredential('OAuth credential exceeds the supported size limit')
  }
  return serialized
}

/** Admit only the concrete credential shape required by `openai-codex`. */
export function validateCredential(value: unknown): OAuthCredential {
  if (!isRecord(value)) throw invalidCredential('stored OAuth JSON must be an object')
  if (value['type'] !== 'oauth') throw invalidCredential('stored credential must use the OAuth discriminant')
  requireSecretField(value, 'access')
  requireSecretField(value, 'refresh')
  if (typeof value['expires'] !== 'number' || !Number.isFinite(value['expires']) || value['expires'] <= 0) {
    throw invalidCredential('stored OAuth credential has an invalid expiry')
  }
  if (typeof value['accountId'] !== 'string' || value['accountId'].length === 0 || value['accountId'].length > 1024) {
    throw invalidCredential('stored OpenAI Codex OAuth credential is missing its account binding')
  }
  assertJsonValue(value, '$')
  return structuredClone(value) as OAuthCredential
}

function requireSecretField(value: Record<string, unknown>, key: 'access' | 'refresh'): void {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0 || field.length > MAX_SECRET_CHARS) {
    throw invalidCredential(`stored OAuth credential has an invalid ${key} field`)
  }
}

function invalidCredential(detail: string): OpenAICodexError {
  return new OpenAICodexError(
    'INVALID_STORED_CREDENTIAL',
    `deepseek-openai-codex: ${detail}; remove the configured OAuth credential reference and sign in again`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidCredential(`stored OAuth credential contains a non-finite number at ${path}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => { assertJsonValue(entry, `${path}[${index}]`) })
    return
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${path}.${key}`)
    return
  }
  throw invalidCredential(`stored OAuth credential contains a non-JSON value at ${path}`)
}
