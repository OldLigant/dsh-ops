import type { Context } from '../../adapter/dsh/types.js'
import { applyComponent } from '../../index.js'
export { Config } from '../../settings/file-config.js'
export const name = 'dsh-ops-file'
export function apply(ctx: Context, config: unknown): void { applyComponent(ctx, config, 'file') }
