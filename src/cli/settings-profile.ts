/** Explicit offline profile change; no host package values load with the plugin. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { dshHome } from '../paths.js'
import { applyCarrier, carrierPreview } from '../settings/carrier-write.js'
import { CLIENT_BUNDLE } from '../settings/carrier-plan.js'
import type { CarrierHost } from '../settings/carrier-plan.js'
export async function loadCarrierHost(anchor: string): Promise<CarrierHost> {
  if (!path.isAbsolute(anchor)) throw new Error('--host-anchor must be an absolute path to the host package.json.')
  const require = createRequire(anchor)
  const editorRequire = createRequire(require.resolve('@deepseek-ai/dsh-config-editor'))
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href) as CarrierHost['boot']
  const yaml = await import(pathToFileURL(editorRequire.resolve('yaml')).href) as CarrierHost['yaml']
  const atomic = await import(pathToFileURL(editorRequire.resolve('@deepseek-ai/dsh-atomic-write')).href) as CarrierHost['atomic']
  for (const name of ['loadProfileDirectory', 'composeEntries', 'readProfilePatches', 'resolveBundleDir', 'loadOverlayPatches'] as const) if (typeof boot[name] !== 'function') throw new Error(`Host profile API unavailable: ${name}`)
  return { boot, yaml, atomic }
}
export async function commandSettingsProfile(options: { profileDir?: string; hostAnchor?: string; home?: string; yes?: boolean; offline?: boolean; dryRun?: boolean }): Promise<number> {
  if (!options.profileDir || !options.hostAnchor) throw new Error('Use --profile-dir <absolute directory> and --host-anchor <absolute host package.json>.')
  const host = await loadCarrierHost(options.hostAnchor)
  const plan = await carrierPreview(host, { dir: options.profileDir, installAnchor: options.hostAnchor, home: options.home ?? dshHome() })
  console.log(`Select ${CLIENT_BUNDLE} instead of dsh-ops; retain the dsh-ops component rows, switches and effective configuration.`)
  console.log(`Files: ${plan.files.map(file => file.path).join(', ')}`)
  console.log('Stop all DSH processes using this profile before applying. Launch-time command-line overlays are outside this persistent profile preview.')
  if (!options.yes || options.dryRun) { console.log('Preview only. Apply with --offline --yes after stopping DSH.'); return 0 }
  if (!options.offline) throw new Error('--offline is required to confirm the profile has been stopped.')
  const backup = await applyCarrier(host, plan)
  console.log(`Saved and verified. Backup: ${backup}. Restart DSH; custom pages require the client carrier bundle and an enabled target row.`)
  return 0
}
