#!/usr/bin/env node
/** Opt-in real-host A/A smoke. No model, large installed corpus or timing threshold. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPO_ROOT } from '../lib/env.mjs'
import { main } from './index.mjs'

const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1]
  assert.ok(['--worker', '--out'].includes(flag) && value && !value.startsWith('--'), 'usage: node bench/calls/smoke.mjs --worker <binary> --out <new-report.json>')
  assert.equal(options[flag], undefined, `duplicate flag: ${flag}`)
  options[flag] = path.resolve(value)
}
assert.ok(options['--worker'] && options['--out'], '--worker and --out are required')
assert.ok(!fs.existsSync(options['--out']), 'refusing to overwrite smoke evidence')

const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-calls-smoke-')))
process.env.DSH_HOME = path.join(temporary, 'dsh-home')
const corpusRoot = path.join(temporary, 'corpus')
fs.mkdirSync(process.env.DSH_HOME); fs.mkdirSync(corpusRoot)
fs.writeFileSync(path.join(corpusRoot, 'hello.txt'), 'needle\nsecond line\n')
fs.writeFileSync(path.join(corpusRoot, 'other.txt'), 'other text\n')
const manifest = {
  id: 'calls-smoke', roots: [corpusRoot], identity: { sample: 2 },
  cases: [
    { id: 'grep-hit', tool: 'grep', args: { pattern: 'needle', path: '.' } },
    { id: 'glob-text', tool: 'glob', args: { pattern: '**/*.txt', path: '.' } },
  ],
}
manifest.file = path.join(temporary, 'manifest.json')
fs.writeFileSync(manifest.file, JSON.stringify(manifest))
fs.mkdirSync(path.dirname(options['--out']), { recursive: true })
const code = await main(['--corpus', manifest.id, '--projection', 'official,baseline,candidate',
  '--baseline-plugin-root', REPO_ROOT, '--plugin-root', REPO_ROOT,
  '--baseline-worker', options['--worker'], '--worker', options['--worker'],
  '--warmup', '1', '--repeat', '2', '--out', options['--out']], { manifests: [manifest] })
assert.equal(code, 0, 'every measured host call must succeed')
const report = JSON.parse(fs.readFileSync(options['--out'], 'utf8'))
assert.equal(report.arms.baseline.libSha256, report.arms.candidate.libSha256)
assert.equal(report.arms.baseline.worker.sha256, report.arms.candidate.worker.sha256)
const corpus = report.corpora[0]
assert.equal(corpus.inputChanged, false)
assert.equal(corpus.rows.length, 12)
assert.ok(corpus.rows.every(row => !row.isError))
for (const testCase of corpus.cases) {
  assert.equal(testCase.baseline.bytesMedian, testCase.candidate.bytesMedian)
  assert.deepEqual(testCase.baseline.coverage, testCase.candidate.coverage)
  assert.ok(testCase.baseline.commands.length > 0, 'OPS calls must reach the real worker')
}
console.log(`[calls-smoke] 12 measured calls passed; timings were not judged. Fixtures retained at ${temporary}`)
