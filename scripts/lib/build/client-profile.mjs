/** Generate the opt-in layer from canonical defaults; only the standard-mode specifier differs. */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'yaml'
export function buildClientProfile(root) {
  const patches = parse(readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8'))
  const rows = patches.flatMap(patch => patch.insert ?? [])
  // The carrier row names the package root so the host loads the client half; it
  // must be the standard mode row, whose package-root entry applies that mode.
  const carrier = rows.filter(row => row.id === 'dsh-ops-mode-standard')
  if (rows.length !== 8 || carrier.length !== 1 || carrier[0].name !== 'dsh-ops/mode-standard') throw new Error('Cannot derive the optional settings profile from this bundle layout.')
  carrier[0].name = 'dsh-ops'
  writeFileSync(path.join(root, 'lib/profiles/client/cordis.patch.yml'), '# Generated from the canonical bundle; do not edit.\n' + stringify(patches))
}
