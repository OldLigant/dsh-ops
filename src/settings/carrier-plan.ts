/**
 * Offline planning against the host's actual persistent profile composition.
 *
 * The one-time client-carrier migration switches the profile bundle name and
 * preserves every composed row; it never rewrites saved patch rows.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { AtomicApi, BootApi, ProfileContext } from '../adapter/dsh/types.js'
import type * as Yaml from 'yaml'
import type { EntryOptions } from '../adapter/dsh/types.js'
import { COMPONENTS } from '../components/defaults.js'

export const CLIENT_BUNDLE = 'dsh-ops/lib/profiles/client'
export interface CarrierHost { boot: BootApi; yaml: typeof Yaml; atomic: AtomicApi }
export interface CarrierLocation { dir: string; home: string; installAnchor: string }
export interface FileChange { path: string; before?: string; after: string; mode: number }
export interface CarrierPlan { files: FileChange[]; beforeRows: EntryOptions[]; afterRows: EntryOptions[]; location: CarrierLocation }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object in the profile manifest.')
  return value as Record<string, unknown>
}
function read(file: string, optional = false): { text?: string; mode: number } {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Expected a regular profile file at most 1 MiB: ${file}`)
    return { text: fs.readFileSync(file, 'utf8'), mode: stat.mode & 0o777 }
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 0o600 }
    throw error
  }
}
const flatten = (rows: EntryOptions[]): EntryOptions[] => rows.flatMap(row => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])
export function profileContext(location: CarrierLocation): ProfileContext {
  return { ...location, name: path.basename(location.dir), cwd: location.dir, patchPath: path.join(location.dir, 'cordis.patch.yml'), startedBundles: [], overlays: [], telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED }
}
export function prepareCarrier(host: CarrierHost, location: CarrierLocation): CarrierPlan {
  for (const value of Object.values(location)) if (!path.isAbsolute(value)) throw new Error('Profile directory, DSH home and host anchor must be absolute paths.')
  const directoryStat = fs.lstatSync(location.dir)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Use a physical profile directory, not a symbolic link.')
  const manifestPath = path.join(location.dir, 'package.json'), patchPath = path.join(location.dir, 'cordis.patch.yml')
  const manifestFile = read(manifestPath), patchFile = read(patchPath, true)
  const manifest = object(JSON.parse(manifestFile.text!)), dsh = object(manifest.dsh), profile = object(dsh.profile)
  const bundles = profile.bundles
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) throw new Error('Profile bundles must be a string array.')
  if (bundles.filter(name => name === 'dsh-ops').length !== 1 || bundles.includes(CLIENT_BUNDLE)) throw new Error('Select exactly one default dsh-ops bundle before this one-time migration.')
  const context = profileContext(location), loaded = host.boot.loadProfileDirectory('dsh', location.dir, location.installAnchor)
  if (loaded.skippedBundles.length) throw new Error('Resolve skipped profile bundles before enabling custom settings.')
  // Equal values today do not erase a saved override's intent when defaults change later.
  const external = host.boot.readProfilePatches('dsh', context, { ...loaded, patches: [],
    layers: loaded.layers.filter(layer => layer.packageName !== 'dsh-ops') })
  // The optional layer renames only the standard-mode row to the package root, so
  // an external name-qualified override of that row would no longer match; never
  // rewrite it automatically.
  if (external.some(patch => !patch.insert && patch.id === 'dsh-ops-mode-standard' && patch.name === 'dsh-ops/mode-standard')) throw new Error('External name-qualified standard-mode overrides require manual review; nothing was written.')
  const original = host.boot.composeEntries([host.boot.readProfilePatches('dsh', context, loaded)])
  const own = flatten(original).filter(row => row.id?.startsWith('dsh-ops-'))
  if (own.length !== COMPONENTS.length || COMPONENTS.some(component => own.filter(row => row.id === `dsh-ops-${component}` && row.name === `dsh-ops/${component}`).length !== 1)) {
    throw new Error(`Expected exactly ${COMPONENTS.length} unique OPS component rows (${COMPONENTS.join(', ')}); custom insertions or shadowing require manual review.`)
  }
  // The migration never rewrites a saved row: keep the patch text byte-identical and
  // validate it here so the profile composer sees the same valid sequence.
  const patchAfter = patchFile.text ?? '[]\n'
  const document = host.yaml.parseDocument(patchAfter, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length || !host.yaml.isSeq(document.contents)) throw new Error('Profile patch must be a valid YAML sequence.')
  const parent = loaded.layers.find(layer => layer.packageName === 'dsh-ops')!
  const directory = host.boot.resolveBundleDir('dsh', CLIENT_BUNDLE, location.installAnchor, location.dir)
  if (fs.realpathSync(directory) !== fs.realpathSync(path.join(parent.packageDir, 'lib/profiles/client'))) throw new Error('The optional layer must belong to the selected OPS installation.')
  const patch = path.join(directory, 'cordis.patch.yml')
  const alternate = { packageName: CLIENT_BUNDLE, packageDir: directory, patchPaths: [patch], patches: host.boot.loadOverlayPatches('dsh', patch) }
  const candidate = { ...loaded, layers: loaded.layers.map(layer => layer === parent ? alternate : layer) }
  const afterRows = host.boot.composeEntries([host.boot.readProfilePatches('dsh', context, candidate)])
  // The only expected composition change is the carrier row's name: the standard
  // mode row becomes the package root, whose entry applies that same mode.
  const expected = structuredClone(original)
  flatten(expected).find(row => row.id === 'dsh-ops-mode-standard')!.name = 'dsh-ops'
  if (!isDeepStrictEqual(afterRows, expected)) throw new Error('The optional layer or a higher-priority patch changes more than the bundle name; nothing was written.')
  profile.bundles = bundles.map(name => name === 'dsh-ops' ? CLIENT_BUNDLE : name)
  return { location, beforeRows: original, afterRows,
    files: [...(patchFile.text === undefined ? [] : [{ path: patchPath, before: patchFile.text, after: patchAfter, mode: patchFile.mode }]),
      { path: manifestPath, before: manifestFile.text, after: JSON.stringify(manifest, null, 2) + '\n', mode: manifestFile.mode }] }
}
