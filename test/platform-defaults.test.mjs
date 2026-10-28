import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'
import { platformSurface } from '../lib/official-tool-catalog.js'
import { COMPONENTS, componentEnabled, componentEntry } from '../lib/components/defaults.js'
import { componentProfile } from './lib/component-profile.mjs'
import { shutdown } from './lib/host.mjs'
import { PTC_LOADABLE_TOOLS } from '../lib/ptc/config.js'
import { resolveModeConfig } from '../lib/modes/config.js'
const patch = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
const rows = parse(patch).flatMap(entry => entry.insert ?? [])
const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'dsh-plugin.json'), 'utf8'))
await test('eight stable row defaults and manifest agree on every platform', () => {
  assert.equal(rows.length, 8)
  assert.deepEqual(rows.map(row => row.id), COMPONENTS.map(component => `dsh-ops-${component}`))
  for (const component of COMPONENTS) {
    const row = rows.find(row => row.id === `dsh-ops-${component}`)
    assert.ok(row)
    assert.equal(row.name, componentEntry(component), 'the row specifier comes from the exported entry')
    const declared = manifest.contributes['x-components'].find(item => item.id === row.id)
    for (const platform of ['win32', 'linux', 'darwin']) {
      assert.equal(declared.defaultEnabled, componentEnabled(component, platform))
      assert.equal(row.disabled ?? false, !componentEnabled(component, platform))
    }
  }
  // The legacy component modules are no longer inserted; a saved row keeps them
  // loadable, but a fresh profile must not compose them.
  for (const legacy of ['shell', 'file', 'ptc', 'hide-official', 'background']) {
    assert.equal(rows.some(row => row.id === `dsh-ops-${legacy}`), false, legacy)
  }
  for (const platform of ['win32', 'linux', 'darwin']) assert.equal(platformSurface(platform).shellDefaultEnabled, true)
})
for (const platform of ['win32', 'linux', 'darwin']) await test(`real Loader applies fresh eight-row ${platform} defaults`, async () => {
  const fixture = componentProfile(`defaults-${platform}`, patch)
  const { ctx, entries } = await fixture.boot(platform)
  try {
    assert.equal(entries().length, 8)
    for (const entry of entries()) assert.equal(!entry.disabled, componentEnabled(entry.options.id.slice('dsh-ops-'.length), platform), entry.options.id)
    assert.equal(entries().find(entry => entry.options.id === 'dsh-ops-panel').options.config.capture, true)
    // Row configs are validated by the mode converter, not mirrored on the fiber.
    const ptc = resolveModeConfig(entries().find(entry => entry.options.id === 'dsh-ops-mode-ptc').options.config)
    assert.deepEqual(ptc.allowedTools, PTC_LOADABLE_TOOLS, 'fresh mode-ptc pool follows the implemented catalogue')
    assert.ok(ptc.allowedTools.includes('read_table'))
    const standard = resolveModeConfig(entries().find(entry => entry.options.id === 'dsh-ops-mode-standard').options.config)
    assert.equal(standard.promptPolicy, true)
    const compat = entries().find(entry => entry.options.id === 'dsh-ops-compat')
    assert.equal(compat.disabled, true, 'Compatibility stays off until the operator opts in')
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), '[]', 'startup does not write a composed tree')
  } finally { await shutdown(ctx) }
})
await test('saved explicit PTC pools survive bundle refresh and a fresh profile boot', async () => {
  const choices = [{ id: 'dsh-ops-mode-ptc', name: 'dsh-ops/mode-ptc', config: { allowedTools: ['stat'], alwaysLoaded: [] } }]
  const fixture = componentProfile('defaults-saved-ptc', patch, choices)
  const original = fs.readFileSync(fixture.profile.patchPath, 'utf8')
  let host = await fixture.boot('linux')
  const check = () => {
    const entry = host.entries().find(value => value.options.id === 'dsh-ops-mode-ptc')
    assert.deepEqual(resolveModeConfig(entry.options.config).allowedTools, ['stat'])
    assert.equal(fs.readFileSync(fixture.profile.patchPath, 'utf8'), original)
  }
  try {
    check(); await host.refresh(); check()
    await shutdown(host.ctx); host = await fixture.boot('linux'); check()
  } finally { await shutdown(host.ctx) }
})
await test('the shipped mode configs are what the validators resolve', () => {
  for (const mode of ['mode-minimal', 'mode-standard', 'mode-ptc', 'mode-cordis']) {
    const row = rows.find(row => row.id === `dsh-ops-${mode}`)
    const resolved = resolveModeConfig(row.config)
    assert.deepEqual(row.config.alwaysLoaded ?? [], resolved.alwaysLoaded, mode)
  }
  // Minimal publishes no routing text, so promptPolicy is its only routing key;
  // the native modes carry the shared file resolver settings.
  const minimal = resolveModeConfig(rows.find(row => row.id === 'dsh-ops-mode-minimal').config)
  assert.equal(minimal.required, false)
  assert.equal(minimal.publishBashTool, true)
})
report('platform-defaults')
