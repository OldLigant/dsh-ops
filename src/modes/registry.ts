/**
 * Cross-row state for the mode switches.
 *
 * Mode rows, the Compatibility switch, and the discovery row are independent
 * Loader rows; they share one small registry keyed by the Cordis root so each
 * row can see which modes are on without importing another row's module state.
 */
import type { Context } from '../adapter/dsh/types.js'
import type { ModeConfig } from './config.js'
import type { ModeId } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** One mode row or the Compatibility switch changed its enabled state or config. */
    'dsh-ops/modes'(): void
  }
}

interface State {
  modes: Map<ModeId, ModeConfig>
  compat: boolean
  muted: number
}

const states = new WeakMap<object, State>()

/** The shared state of one Cordis root. */
function stateOf(ctx: Context): State {
  const key: object = ctx.root ?? ctx
  let state = states.get(key)
  if (state === undefined) { state = { modes: new Map(), compat: false, muted: 0 }; states.set(key, state) }
  return state
}

/** Emit one change, unless a batch is in progress. */
function notify(ctx: Context): void {
  const state = stateOf(ctx)
  if (state.muted > 0) return
  try { ctx.emit('dsh-ops/modes') } catch { /* an observer's failure is reported by that observer */ }
}

/**
 * Register one enabled mode row.
 * @param ctx - the row's context.
 * @param id - the mode the row enables.
 * @param config - the row's resolved configuration.
 * @returns the disposer that unregisters the mode.
 */
export function joinMode(ctx: Context, id: ModeId, config: ModeConfig): () => void {
  const state = stateOf(ctx)
  state.modes.set(id, config)
  notify(ctx)
  return () => {
    if (state.modes.get(id) !== config) return
    state.modes.delete(id)
    notify(ctx)
  }
}

/**
 * Record the Compatibility switch.
 * @param ctx - the switch row's context.
 * @param enabled - whether official tools stay visible.
 * @returns the disposer that clears the switch.
 */
export function joinCompatibility(ctx: Context, enabled: boolean): () => void {
  const state = stateOf(ctx)
  const previous = state.compat
  state.compat = enabled
  notify(ctx)
  return () => { state.compat = previous; notify(ctx) }
}

/**
 * The enabled modes and their configuration.
 * @param ctx - any context on the root.
 * @returns a snapshot keyed by mode id.
 */
export function enabledModes(ctx: Context): ReadonlyMap<ModeId, ModeConfig> {
  return new Map(stateOf(ctx).modes)
}

/**
 * Whether the Compatibility switch is on.
 * @param ctx - any context on the root.
 * @returns true when official tools must stay exposed.
 */
export function compatibilityOn(ctx: Context): boolean {
  return stateOf(ctx).compat
}

/**
 * Observe every mode/compatibility change.
 * @param ctx - the row's context; the listener is disposed with it.
 * @param listener - the callback to run after a change.
 * @returns the unsubscribe function.
 */
export function onModesChange(ctx: Context, listener: () => void): () => void {
  return ctx.on('dsh-ops/modes', listener)
}
