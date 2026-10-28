import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const [repo, pluginRoot, worker, output] = process.argv.slice(2)
assert.ok(repo && pluginRoot && worker && output, 'repo pluginRoot worker output are required')
assert.ok(!fs.existsSync(output), 'refuse report overwrite')
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-prefix-test-'))
const { boot } = await import(pathToFileURL(path.join(repo, 'bench/gates/host.mjs')))
const { loadManifests, adaptCase, resolveRoot } = await import(pathToFileURL(path.join(repo, 'bench/calls/corpora.mjs')))
const { resolvePinnedRoot } = await import(pathToFileURL(path.join(repo, 'bench/calls/pins.mjs')))
const { publicToolName } = await import(pathToFileURL(path.join(pluginRoot, 'lib/policy.js')))
const rows = []
for (const manifest of loadManifests().filter(item => (process.env.CHECK_CORPUS ? [process.env.CHECK_CORPUS] : ['harness-client', 'python-stdlib']).includes(item.id))) {
  const target = resolvePinnedRoot(manifest, { repoRoot: repo })
  const root = target.kind === 'content' ? resolveRoot(manifest, { repoRoot: repo }) : target.root
  const host = await boot({ root, worker, pluginRoot, alwaysLoaded: ['grep', 'glob'], toolTimeout: true })
  try {
    const owner = await host.agent()
    for (const limit of [5, 50]) {
      const values = []
      for (const kind of ['bounded', 'exact']) {
        const item = manifest.cases.find(item => item.id === `grep-hit-${limit}-${kind}`)
        const call = adaptCase(item, 'candidate', publicToolName)
        console.log(`starting ${manifest.id}/${item.id}`)
        const run = await host.run(owner, [[call], []])
        console.log(`finished ${manifest.id}/${item.id}: ${run.results[0].durationMs}ms`)
        const value = run.results[0].result.value
        if (!value || !Array.isArray(value.items)) console.log(JSON.stringify(run.results[0].result, null, 2).slice(0, 5000))
        assert.ok(value && Array.isArray(value.items), 'host must expose canonical items')
        assert.equal(value.items.length, limit)
        assert.equal(value.failed, 0)
        values.push(value)
      }
      const [bounded, exact] = values
      assert.deepEqual(bounded.items, exact.items, `${manifest.id}: bounded prefix differs`)
      assert.equal(exact.scanComplete, true)
      assert.equal(bounded.scanComplete, false)
      assert.equal(bounded.truncatedBy, 'row-limit')
      assert.equal(bounded.matchedTotal, undefined)
      assert.ok(!bounded.continuation)
      assert.ok(exact.matchedTotal >= limit)
      const hash = createHash('sha256').update(JSON.stringify(bounded.items)).digest('hex')
      rows.push({ corpus: manifest.id, limit, prefixEqual: true, itemsSha256: hash,
        exactTotal: exact.matchedTotal, boundedObserved: bounded.matchedObserved,
        exactScanned: exact.scannedFiles, boundedScanned: bounded.scannedFiles })
      console.log(`${manifest.id}/${limit}: equal prefix, ${bounded.scannedFiles}/${exact.scannedFiles} files scanned`)
    }
  } finally { await host.close() }
}
fs.writeFileSync(output, JSON.stringify({ rows }, null, 2) + '\n', { flag: 'wx' })
