/** Importable declaration checks, shared by the release gate and drift regressions. */
import { isDeepStrictEqual } from 'node:util'
import { COMPONENTS, componentEntry, componentEnabled } from '../../lib/components/defaults.js'
import { DISCOVERY_CAPABILITIES } from '../../lib/capabilities/registry.js'
import { publicToolName } from '../../lib/policy.js'
import { platformSurface } from '../../lib/official-tool-catalog.js'
import { residentTools } from '../../lib/modes/plan.js'

export function defaultChecks(component, config, resolve) {
  const defaults = resolve({})
  return Object.entries(config ?? {}).map(([key, value]) => [
    isDeepStrictEqual(value, defaults[key]), `${component}.${key} patch default matches its resolver`,
  ])
}

/** Components that need the native runtime target matrix declared. */
const RUNTIME_COMPONENTS = new Set(['mode-minimal', 'mode-standard', 'mode-ptc', 'mode-cordis', 'discovery', 'panel'])

/** The tool names one component declaration advertises for its shipped surface. */
function declaredTools(component) {
  if (component === 'discovery') return DISCOVERY_CAPABILITIES.map(entry => publicToolName(entry.rawName))
  if (component === 'compat' || component === 'panel' || component === 'tui') return []
  if (component === 'mode-minimal') return ['ops_bash']
  if (component === 'mode-standard' || component === 'mode-cordis') {
    return [...residentTools(component === 'mode-standard' ? 'standard' : 'cordis'), 'ops_bash'].sort()
  }
  return undefined
}

export function componentChecks(components, platform = process.platform) {
  const checks = [], check = (...value) => checks.push(value)
  const targets = components.find(row => row.id === 'dsh-ops-mode-ptc')?.targets
  check(components.length === COMPONENTS.length && new Set(components.map(row => row.id)).size === COMPONENTS.length, 'component declarations are complete and unique')
  for (const component of COMPONENTS) {
    const row = components.find(value => value.id === `dsh-ops-${component}`)
    check(row?.entry === componentEntry(component), `${component} declaration uses its exported entry`)
    check(row?.defaultEnabled === componentEnabled(component, platform), `${component} declaration matches its enablement default`)
    check(isDeepStrictEqual(row?.targets, RUNTIME_COMPONENTS.has(component) ? targets : undefined), `${component} target declaration matches its runtime requirements`)
    const tools = declaredTools(component)
    if (tools !== undefined) check(isDeepStrictEqual([...(row?.tools ?? [])].sort(), tools), `${component} tool declaration matches its catalogue projection`)
  }
  const retained = Object.fromEntries(['win32', 'linux', 'darwin'].map(entry => [entry, platformSurface(entry).retainedCommand]))
  check(isDeepStrictEqual(components.find(row => row.id === 'dsh-ops-compat')?.retainedOfficialCommand, retained), 'retained official commands match platform policy')
  return checks
}
