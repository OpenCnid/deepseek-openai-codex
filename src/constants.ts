/** The only provider route owned by this package. */
export const OPENAI_CODEX_PROVIDER = 'openai-codex' as const

/** Settings namespace and card key owned by this package. */
export const SETTINGS_NAMESPACE = 'deepseek-openai-codex' as const

/** Human-readable route name used by DSH selectors. */
export const PROVIDER_DISPLAY_NAME = 'OpenAI Codex (ChatGPT subscription)' as const

/** Default DSH credential reference containing the compact Pi OAuth JSON. */
export const DEFAULT_CREDENTIAL_REF = 'OPENAI_CODEX_OAUTH' as const
