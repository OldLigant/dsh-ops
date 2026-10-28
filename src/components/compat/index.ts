/** Compatibility switch: keep the official tools exposed instead of replaced. */
import type { Context } from '../../adapter/dsh/types.js'
import { joinCompatibility } from '../../modes/registry.js'
export const name = 'dsh-ops-compat'
export function apply(ctx: Context): void {
  const leave = joinCompatibility(ctx, true)
  ctx.effect(() => () => leave(), 'dsh-ops: compatibility switch')
  ctx.logger.info('dsh-ops: Compatibility mode is on; official tools stay exposed. Token efficiency and model ability are reduced.')
}
