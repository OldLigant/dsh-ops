import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { bm05 } from '../bench/gates/tasks.mjs'
import { publicToolName } from '../lib/policy.js'

await test('BM-05 preserves a failed read control and its error instead of crashing on missing items', async () => {
  await withTempDir('bm05-error-report', async root => {
    const pluginRoot = path.join(root, 'plugin')
    const fileDir = path.join(pluginRoot, 'lib/components/file')
    const discoveryDir = path.join(pluginRoot, 'lib/components/discovery')
    fs.mkdirSync(fileDir, { recursive: true }); fs.mkdirSync(discoveryDir, { recursive: true })
    fs.writeFileSync(path.join(pluginRoot, 'package.json'), '{"type":"module"}')
    fs.writeFileSync(path.join(discoveryDir, 'index.js'), 'export function apply() {}')
    fs.writeFileSync(path.join(fileDir, 'index.js'), `
      export const inject = ['tools']
      export function apply(ctx) {
        for (const name of ${JSON.stringify(['read_files', 'write_file'].map(publicToolName))}) ctx.tools.register({
          name, description: 'error fixture', parameters: {type:'object',properties:{}},
          output: {schema:{type:'object'},render:()=>[{type:'text',text:'INVALID_ARGUMENT: Unknown capability'}]},
          execute: async () => ({status:'error',error:{code:'INVALID_ARGUMENT',message:'Unknown capability',effectState:'none'}}),
        })
      }
    `)
    const temporary = path.join(root, 'task'); fs.mkdirSync(temporary)
    const result = await bm05({ temporary, pluginRoot, worker: process.execPath })
    assert.equal(result.status, 'failed')
    assert.equal(result.gates.ordinaryReadSucceeded, false)
    assert.equal(result.outsideOrdinaryRead, null)
    assert.equal(result.read.results[0].result.value.error.code, 'INVALID_ARGUMENT')
    assert.match(result.reason, /ordinary read control.*INVALID_ARGUMENT.*Unknown capability/)
  })
})

report('bench-gates-errors')
