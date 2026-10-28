/** Optional Bash acquisition and lifecycle CLI; never edits a profile or ambient PATH. */
import { commandProvisionShells } from './provision-shells.js'
import { readRowConfig } from './report.js'
import { resolveConfig } from '../config.js'
import { resolveShells } from '../shells.js'
import { gitBashCandidates, managedBashInventory, removeManagedBash, selectBashRuntime } from '../shells/manager.js'

interface BashRuntimeCommandOptions { force?: boolean; dryRun?: boolean; yes?: boolean; configFile?: string }

export function commandBashRuntime(action = 'status', options: BashRuntimeCommandOptions = {}): number {
  let result
  if (action === 'install') return commandProvisionShells({ kinds: ['bash'], force: options.force ?? false, dryRun: options.dryRun ?? false, pinFile: undefined })
  if (action === 'remove') result = removeManagedBash(options)
  else if (action === 'git' || action === 'managed') result = selectBashRuntime(action)
  else if (action === 'status') result = { selected: resolveShells(resolveConfig(readRowConfig(options.configFile))).bash,
    managed: managedBashInventory(), git: gitBashCandidates() }
  else throw new Error('Expected bash-runtime status, install, remove, git or managed.')
  console.log(JSON.stringify(result, null, 2))
  if (action === 'git' || action === 'managed') console.log('Apply the config object to the matching dsh-ops mode row with the host config editor, then reload the component. No profile was changed.')
  if (action === 'remove' && 'action' in result && result.action === 'preview') console.log('Pass --yes to remove only these managed Bash versions. Stop running Bash jobs before removal.')
  return 0
}
