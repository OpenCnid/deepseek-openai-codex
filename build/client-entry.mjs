import remoteContribution from '../lib/typert.remote-client.js'
import { inject, registerAuthCard } from '../lib/types/client/index.js'

export { inject }

export async function apply(ctx) {
  const unmountRemote = await ctx.remote.$mount(remoteContribution)
  const card = ctx.plugin({
    inject: ['slots', 'remote', 'remote.openaiCodexAuth'],
    apply: registerAuthCard,
  })
  try {
    await card
  } catch (error) {
    await unmountRemote()
    throw error
  }
  return async () => {
    await card.dispose()
    await unmountRemote()
  }
}
