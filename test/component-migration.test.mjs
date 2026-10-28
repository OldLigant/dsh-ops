import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { assert, test, report, PACKAGE_ROOT, waitFor } from './lib/harness.mjs'
import { componentProfile } from './lib/component-profile.mjs'
import { COMPONENTS, componentEntry } from '../lib/components/defaults.js'
import { shutdown } from './lib/host.mjs'
const current = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
/**
 * The 0.4.x legacy bundle fixture: seven independent rows, five of which were
 * component modules. It is frozen here (not read from git history) because it is
 * the input the migration has to keep supporting; the new bundle is the output.
 */
const LEGACY_ROWS = [
  { id: 'dsh-ops-shell', name: 'dsh-ops/shell', config: { promptPolicy: true, publishBashTool: true, shellPolicy: 'advise', allowSystemShellFallback: false } },
  { id: 'dsh-ops-file', name: 'dsh-ops/file', config: { promptPolicy: true, required: false } },
  { id: 'dsh-ops-ptc', name: 'dsh-ops/ptc', config: { required: false, alwaysLoaded: [] } },
  { id: 'dsh-ops-discovery', name: 'dsh-ops/discovery', config: { enabled: true, maxResults: 3, alwaysLoaded: [], required: false, denyCredentialReads: true } },
  { id: 'dsh-ops-panel', name: 'dsh-ops/panel', disabled: true, config: { capture: true, textLimit: 2000, maxSessionBytes: 8388608 } },
  { id: 'dsh-ops-tui', name: 'dsh-ops/tui', disabled: true, config: { maxSessions: 32, maxActive: 128, recentLimit: 8 } },
  { id: 'dsh-ops-hide-official', name: 'dsh-ops/hide-official', disabled: true, config: { replaceTools: [] } },
]
const previous = JSON.stringify([{ insert: LEGACY_ROWS }])
/** Shipped rows that kept their id and name, so a saved override still matches them. */
const RETAINED = new Set(['dsh-ops-discovery', 'dsh-ops-panel', 'dsh-ops-tui'])
for (const reversed of [false, true]) await test(`legacy seven-row profile refreshes to the eight-component roster and preserves named overrides (reverse: ${reversed})`, async () => {
  const choices = LEGACY_ROWS.map((row, index) => ({ id: row.id, name: row.name, disabled: Boolean(index % 2) !== reversed,
    config: { ...row.config, ...(row.id === 'dsh-ops-file' ? { extraGuidance: 'keep this exact file setting', configUpdateVersion: 2 } : {}),
      ...(row.id === 'dsh-ops-shell' ? { promptPolicy: false, configUpdateVersion: 2 } : {}),
      ...(row.id === 'dsh-ops-panel' ? { textLimit: 777, capture: false } : {}) } }))
  const foreign = { insert: [{ id: 'theme-sentinel', name: 'cordis:fixtureTheme', config: { preference: 'dark', fontSize: 17 } }] }
  const fixture = componentProfile(`migration-${reversed}`, previous, [...choices, foreign])
  const original = fs.readFileSync(fixture.profile.patchPath, 'utf8')
  const checkLegacy = host => {
    for (const choice of choices) {
      const entry = host.entries().find(entry => entry.options.id === choice.id)
      assert.equal(entry.options.name, choice.name)
      assert.equal(entry.disabled, choice.disabled, `${choice.id} on/off preserved`)
      assert.deepEqual(entry.options.config, choice.config, `${choice.id} config preserved`)
    }
    const theme = [...host.ctx.loader.entries()].find(entry => entry.options.id === 'theme-sentinel')
    assert.deepEqual(theme.options.config, foreign.insert[0].config)
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), original)
    assert.equal(fs.readFileSync(fixture.baseFile, 'utf8'), '[]\n')
  }
  const checkNew = host => {
    // Saved overrides keep their patch position ahead of the fresh bundle rows, so
    // compare the composed set (and each row's specifier), not the registry order.
    assert.deepEqual(host.entries().map(entry => entry.options.id).sort(), COMPONENTS.map(component => `dsh-ops-${component}`).sort())
    for (const component of COMPONENTS) {
      assert.equal(host.entries().find(entry => entry.options.id === `dsh-ops-${component}`).options.name, componentEntry(component), component)
    }
    for (const choice of choices.filter(choice => RETAINED.has(choice.id))) {
      const entry = host.entries().find(entry => entry.options.id === choice.id)
      assert.equal(entry.disabled, choice.disabled, `${choice.id} saved on/off still matches its retained id`)
      assert.deepEqual(entry.options.config, choice.config, `${choice.id} saved config still matches its retained id`)
    }
    // The removed rows' saved overrides are skipped, not fatal: startup still
    // composes every shipped row.
    for (const choice of choices.filter(choice => !RETAINED.has(choice.id))) {
      assert.equal(host.entries().some(entry => entry.options.id === choice.id), false, `${choice.id} is no longer a shipped row`)
    }
    const theme = [...host.ctx.loader.entries()].find(entry => entry.options.id === 'theme-sentinel')
    assert.deepEqual(theme.options.config, foreign.insert[0].config, 'foreign rows survive the roster change')
    // The migration never rewrites the operator's saved overrides; the host may
    // persist its own composed base file, which this suite does not pin.
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), original)
  }
  let host = await fixture.boot('linux')
  try {
    assert.equal(host.entries().length, 7); checkLegacy(host)
    fs.writeFileSync(fixture.bundlePath, current)
    await host.refresh()
    assert.equal(host.entries().length, 8); checkNew(host)
    // The fresh mode rows carry the bundle defaults, not a legacy row's config.
    assert.equal(host.entries().find(entry => entry.options.id === 'dsh-ops-mode-standard').disabled, false)
    assert.equal(host.entries().find(entry => entry.options.id === 'dsh-ops-compat').disabled, true)
    await host.refresh(); assert.equal(host.entries().length, 8); checkNew(host)
    await shutdown(host.ctx)
    host = await fixture.boot('linux')
    assert.equal(host.entries().length, 8); checkNew(host)
  } finally { await shutdown(host.ctx) }
})
await test('a fresh profile composes the eight-component roster without a migration step', async () => {
  const fixture = componentProfile('migration-fresh', current)
  const host = await fixture.boot('linux')
  try {
    assert.deepEqual(host.entries().map(entry => entry.options.id), COMPONENTS.map(component => `dsh-ops-${component}`))
    assert.equal(host.entries().find(entry => entry.options.id === 'dsh-ops-mode-minimal').disabled, false)
    assert.equal(host.entries().find(entry => entry.options.id === 'dsh-ops-tui').disabled, true)
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), '[]', 'startup does not write a composed tree')
  } finally { await shutdown(host.ctx) }
})
await test('fresh panel row enablement starts collection while explicit legacy false stays inert', async () => {
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'dsh-ops-panel-default-'))
  const fixture = componentProfile('panel-row-default', current)
  const host = await fixture.boot()
  const emit = id => host.ctx.emit('session/event', { id, header: { cwd } }, { type: 'user/message', seq: 0, time: 1,
    data: { content: [{ type: 'text', text: 'fresh panel row' }] } })
  const dir = path.join(cwd, '.dsh-ops/panel')
  try {
    emit('default-off')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fs.existsSync(dir), false)
    fs.writeFileSync(fixture.profile.patchPath, JSON.stringify([{ id: 'dsh-ops-panel', name: 'dsh-ops/panel', disabled: false }]))
    await host.refresh(); emit('enabled')
    await waitFor(() => fs.existsSync(path.join(dir, 'enabled.ndjson')))
    fs.writeFileSync(fixture.profile.patchPath, JSON.stringify([{ id: 'dsh-ops-panel', name: 'dsh-ops/panel', disabled: false, config: { capture: false } }]))
    await host.refresh()
    const before = fs.readdirSync(dir)
    emit('legacy-off')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(fs.readdirSync(dir), before)
    assert.equal(host.entries().find(entry => entry.options.id === 'dsh-ops-panel').fiber.config.capture, false)
  } finally { await shutdown(host.ctx); fs.rmSync(cwd, { recursive: true, force: true }) }
})
report('component-migration')
