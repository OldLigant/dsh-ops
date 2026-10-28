import type { Context } from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import type {} from '../adapter/dsh/types.js'
import { RUNTIME_REMOTE } from '../settings/runtime-contract.js'
import { en, zh } from './locales.js'
import { DiscoveryForm } from './selections.js'
import { ShellForm } from './shell-form.js'
import type { SettingsProps } from './forms.js'
import { SETTINGS_CSS } from './styles.js'
export const name = 'dsh-ops-settings'
export const inject = ['slots', 'locale', 'remote']
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register('dshOps', { en, zh }), 'dsh-ops: settings dictionaries')
  await ctx.remote.$mount(RUNTIME_REMOTE)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshOpsSettings = 'true'; style.textContent = SETTINGS_CSS; document.head.append(style)
    return () => style.remove()
  }, 'dsh-ops: settings styles')
  // Every enhanced-preset row shares the shell form: a mode row owns bashPath and
  // publishBashTool, and the host schema already edits the PTC pool of mode-ptc.
  ctx.slots.inject('plugins.row.config', function* () {
    for (const [row, summary] of [
      ['dsh-ops-mode-minimal', 'modeMinimal'], ['dsh-ops-mode-standard', 'modeStandard'],
      ['dsh-ops-mode-ptc', 'modePtc'], ['dsh-ops-mode-cordis', 'modeCordis'],
    ] as const) {
      yield ctx.slots.register({ name: 'plugins.row.config', key: `dsh-ops#${row}`, locale: 'dshOps' },
        (props: SettingsProps) => props.view === 'summary' ? <>{props.t(summary)}</> : <ShellForm {...props} api={ctx.remote.opsSettings} />)
    }
    yield ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-ops#dsh-ops-discovery', locale: 'dshOps' },
      (props: SettingsProps) => props.view === 'summary' ? <>{props.t('discovery')}</> : <DiscoveryForm {...props} />)
  })
}
