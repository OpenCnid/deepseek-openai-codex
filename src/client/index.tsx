import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { AuthCard, type AuthRemote } from './auth-card.tsx'

export { AuthCard } from './auth-card.tsx'
export type { AuthCardProps, AuthRemote } from './auth-card.tsx'

// The distributable client entry mounts this package's generated Remote
// contribution before registering the card. Waiting on the nested namespace
// here would deadlock: third-party Remote contributions are not auto-mounted
// by DSH's built-in Client assembly.
export const inject = ['slots', 'remote']

/** Register exactly one package-owned Plugins settings card. */
export function registerAuthCard(ctx: ClientContext): void {
  const remote = (ctx.remote as unknown as { openaiCodexAuth: AuthRemote }).openaiCodexAuth
  if (remote === undefined) throw new Error('deepseek-openai-codex: generated auth Remote is not mounted')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'deepseek-openai-codex',
    inject: () => ({ auth: remote }),
  }, AuthCard))
}

export const apply = registerAuthCard
