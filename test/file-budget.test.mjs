import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { resolveConfig } from '../lib/config.js'
import { definition, OUTPUT } from '../lib/file/contract.js'
import { NativeFileTools } from '../lib/file/runtime.js'
import { invoke, resolveWorker } from '../lib/file/worker.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

const exec = signal => ({ agent: { session: { id: 'file-budget-test', header: { cwd: process.cwd() } } }, signal })
function controlled() {
  let close, exit
  const done = new Promise(resolve => { close = resolve })
  const gone = new Promise(resolve => { exit = resolve })
  const handle = { done, waitForExit: () => gone, terminate() {}, collected: {
    stdout: { readFrom: () => ({ text: '{"status":"completed","items":[]}', lossy: false }) },
    stderr: { readFrom: () => ({ text: '', lossy: false }) },
  } }
  let spec
  const ctx = { tools: { register: () => () => {} }, get: name => ({
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) },
    subprocess: { spawn: value => { spec = value; return handle } },
  })[name] }
  return { ctx, get spec() { return spec }, close: () => close({ exitCode: 0, signal: null }), exit: () => exit(true) }
}

await test('file budget config validates independently from FastCtx RPC timeout', () => {
  const c = resolveConfig({ fileBudgets: { timeoutMs: 200, maxReadBytes: 1024 } })
  assert.equal(c.fileBudgets.timeoutMs, 200)
  assert.equal(c.fileBudgets.maxReadBytes, 1024)
  assert.equal(c.toolCallTimeoutMs, 300000)
  assert.equal(c.fileBudgets.maxOutputBytes, 98304)
  for (const fileBudgets of [{ timeoutMs: 0 }, { maxOutputBytes: 128 * 1024 }, { maxReadBytes: 1.5 }, { typo: 1 }]) {
    assert.throws(() => resolveConfig({ fileBudgets }), /fileBudgets/)
  }
})

await test('definitions declare deadline and expose scan/page/count semantics', () => {
  for (const name of ['grep', 'glob', 'inspect_local_file', 'replace']) {
    assert.equal(definition(name, () => {}, { timeoutMs: 200 }).timeoutMs, 200)
  }
  for (const key of ['scanComplete', 'pageComplete', 'totalExact', 'totalLowerBound', 'stopReason']) assert.ok(OUTPUT.properties[key], key)
})

await test('unload awaits actual call completion and managed range exit', async () => {
  const c = controlled()
  const surface = new NativeFileTools({ ctx: c.ctx, config: { workerPath: 'D:/test-worker.exe' } })
  const call = surface.call('grep', { pattern: 'hit' }, exec())
  await delay(0)
  let stopped = false
  const stop = surface.stop().then(() => { stopped = true })
  try {
    await delay(0)
    assert.equal(stopped, false, 'stop must await the running promise')
    c.close()
    await delay(0)
    assert.equal(stopped, false, 'process close alone does not prove the range is empty')
    c.exit()
    await stop
    assert.equal(surface.active.size, 0)
    assert.equal((await call).error.effectState, 'none')
  } finally { c.close(); c.exit(); await Promise.allSettled([call, stop]) }
})

await test('external cancellation is an error with no read effects; replace stays unknown', async () => {
  for (const tool of ['grep', 'replace']) {
    const c = controlled(), controller = new AbortController()
    const call = invoke(c.ctx, 'D:/test-worker.exe', tool, { pattern: 'hit', replacement: 'next' }, exec(controller.signal), controller.signal)
    controller.abort(new Error('caller cancelled')); c.close(); c.exit()
    const result = await call
    assert.equal(result.status, 'error')
    assert.equal(result.error.effectState, tool === 'replace' ? 'unknown' : 'none')
    if (tool === 'grep') assert.equal(result.error.code, 'CANCELLED')
  }
})

await test('host deadline terminates and waits instead of accepting captured JSON', async () => {
  const c = controlled(), controller = new AbortController()
  const surface = new NativeFileTools({ ctx: c.ctx, config: { workerPath: 'D:/test-worker.exe', fileBudgets: { timeoutMs: 100 } } })
  const fallback = setTimeout(() => controller.abort(new Error('test fallback')), 500)
  const call = surface.call('grep', { pattern: 'hit' }, exec(controller.signal))
  await delay(0)
  c.spec.signal.addEventListener('abort', () => { setTimeout(() => { c.close(); c.exit() }, 10) }, { once: true })
  try {
    const result = await call
    assert.equal(result.error.code, 'DEADLINE_EXCEEDED')
    assert.equal(result.error.effectState, 'none')
    assert.equal(surface.active.size, 0)
  } finally { clearTimeout(fallback); c.close(); c.exit(); await surface.stop() }
})

await test('range observation failure resolves as an error instead of throwing', async () => {
  const c = controlled()
  const spawn = c.ctx.get('subprocess').spawn
  const ctx = { ...c.ctx, get: name => name === 'subprocess' ? { spawn: spec => {
    const handle = spawn(spec)
    return { ...handle, waitForExit: async () => { throw new Error('range inspection unavailable') } }
  } } : c.ctx.get(name) }
  const call = invoke(ctx, 'D:/test-worker.exe', 'grep', { pattern: 'hit' }, exec())
  c.close(); c.exit()
  const result = await call
  assert.equal(result.status, 'error')
  assert.equal(result.error.effectState, 'none')
})

await test('a stalled host observation is bounded before worker spawn', async () => {
  const c = controlled()
  const controller = new AbortController()
  const ctx = { ...c.ctx, get: name => name === 'fs' ? { resolve: () => new Promise(() => {}), stat: () => {} } : c.ctx.get(name) }
  const call = invoke(ctx, 'D:/test-worker.exe', 'inspect_local_file', { path: 'file.txt' }, exec(controller.signal), controller.signal, { budgets: { timeoutMs: 100 } })
  const watchdog = delay(500).then(() => 'hung')
  const result = await Promise.race([call, watchdog])
  assert.notEqual(result, 'hung')
  assert.equal(result.error.code, 'DEADLINE_EXCEEDED')
  assert.equal(c.spec, undefined)
})

const worker = process.env.DSH_OPS_FILE_BUDGET_WORKER ?? resolveWorker()
async function realHost(root, callback) {
  const host = new Context(); host.logger.level = 0
  await host.plugin(Subprocess)
  let stuck = false
  const handles = []
  const script = path.join(root, 'stuck-worker.mjs')
  fs.writeFileSync(script, 'process.stdout.write(\'{"status":"completed","items":[]}\'); setInterval(() => {}, 1000)\n')
  const ctx = { tools: { register: () => () => {} }, get: name => ({
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) },
    subprocess: { spawn: spec => {
      const handle = host.get('subprocess').spawn(stuck ? { ...spec, argv: [process.execPath, script] } : spec)
      handles.push(handle); return handle
    } },
  })[name] }
  const execution = signal => ({ agent: { session: { id: 'real-budget', header: { cwd: root } } }, signal })
  try { return await callback({ ctx, execution, handles, setStuck: value => { stuck = value } }) }
  finally {
    await host.fiber.dispose()
    // The harness deletes its owned fixture after this inventory.
    assert.ok(fs.readdirSync(root).every(name => ['stuck-worker.mjs', 'long.txt', 'a.txt', 'b.txt'].includes(name)))
  }
}

await test('real worker soft deadline and zero-hit entry budget return incomplete JSON', async () => {
  await withTempDir('file-budget-soft', async root => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'none\n')
    fs.writeFileSync(path.join(root, 'b.txt'), 'none\n')
    for (const [limits, reason] of [[{ timeoutMs: 0 }, 'deadline'], [{ maxVisitedEntries: 1 }, 'visitedEntries']]) {
      const child = spawnSync(worker, [], { encoding: 'utf8', timeout: 5000, input: JSON.stringify({
        root, scope: 'soft-budget', read_only: true, tool: 'grep', args: { path: root, pattern: 'hit', outputMode: 'summary' }, file_budget: limits,
      }) })
      assert.equal(child.status, 0, child.stderr)
      const result = JSON.parse(child.stdout)
      assert.equal(result.status, 'completed')
      assert.equal(result.stopReason, reason)
      assert.equal(result.scanComplete, false)
      assert.equal(result.totalExact, false)
      assert.equal(result.complete, false)
      assert.equal(result.total, undefined)
      assert.equal(result.omitted, undefined)
    }
    assert.deepEqual(fs.readdirSync(root).sort(), ['a.txt', 'b.txt'])
  })
})

await test('real host hard deadline reaps its worker and a subsequent query succeeds', async () => {
  await withTempDir('file-budget-hard', root => realHost(root, async c => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hit\n')
    const surface = new NativeFileTools({ ctx: c.ctx, config: { workerPath: worker, fileBudgets: { timeoutMs: 200 } } })
    await surface.start()
    c.setStuck(true)
    const result = await surface.call('grep', { pattern: 'hit' }, c.execution())
    assert.equal(result.error.code, 'DEADLINE_EXCEEDED')
    assert.equal(result.error.effectState, 'none')
    assert.equal(await c.handles[0].waitForExit(), true)
    assert.equal(surface.active.size, 0)
    c.setStuck(false)
    const next = await surface.call('grep', { path: 'a.txt', pattern: 'hit', outputMode: 'summary' }, c.execution())
    assert.equal(next.status, 'completed', JSON.stringify(next))
    assert.equal(next.matched, 1)
    await surface.stop()
  }))
})

await test('real cancellation and unload await exited workers and reject captured success', async () => {
  await withTempDir('file-budget-cancel', root => realHost(root, async c => {
    c.setStuck(true)
    const surface = new NativeFileTools({ ctx: c.ctx, config: { workerPath: worker } })
    await surface.start()
    const controller = new AbortController()
    const call = surface.call('grep', { pattern: 'hit' }, c.execution(controller.signal))
    await delay(50); controller.abort(new Error('user cancel'))
    assert.equal((await call).error.code, 'CANCELLED')
    assert.equal(await c.handles[0].waitForExit(), true)
    const second = surface.call('grep', { pattern: 'hit' }, c.execution())
    await delay(50); await surface.stop()
    assert.equal((await second).error.code, 'CANCELLED')
    assert.equal(await c.handles[1].waitForExit(), true)
    assert.equal(surface.active.size, 0)
    assert.equal((await surface.call('grep', {}, c.execution())).status, 'rejected')
  }))
})

await test('escaped UTF-8 previews fit native/value/render budgets and advance pages', async () => {
  await withTempDir('file-budget-output', root => realHost(root, async c => {
    fs.writeFileSync(path.join(root, 'long.txt'), `hit ${'中"\\\t'.repeat(20000)}\r\nhit second\n`)
    const budgets = resolveConfig({ fileBudgets: { maxOutputBytes: 8192 } }).fileBudgets
    const surface = new NativeFileTools({ ctx: c.ctx, config: { workerPath: worker, fileBudgets: budgets } })
    await surface.start()
    const result = await surface.call('grep', { path: 'long.txt', pattern: 'hit', outputMode: 'content', limit: 1 }, c.execution())
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(result.items[0].textTruncated, true)
    assert.equal(result.nextOffset, 1)
    assert.equal(c.handles[0].collected.stdout.readFrom(0).lossy, false)
    assert.ok(Buffer.byteLength(c.handles[0].collected.stdout.readFrom(0).text) <= (8192 - 2048) / 2)
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192)
    assert.ok(Buffer.byteLength(JSON.stringify(definition('grep', () => {}, budgets).output.render({}, result))) <= 8192)
    const next = await surface.call('grep', { path: 'long.txt', pattern: 'hit', outputMode: 'content', offset: result.nextOffset, limit: 1 }, c.execution())
    assert.equal(next.nextOffset, 2)
    assert.equal(next.items[0].text, 'hit second')
    assert.equal(next.totalExact, true)
    await surface.stop()
  }))
})

await test('page satisfaction reports lower bounds until the whole scope is scanned', async () => {
  await withTempDir('file-budget-complete', root => realHost(root, async c => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hit\n'.repeat(300))
    fs.writeFileSync(path.join(root, 'b.txt'), 'hit\n')
    const surface = new NativeFileTools({ ctx: c.ctx, config: { workerPath: worker } })
    await surface.start()
    const result = await surface.call('grep', { pattern: 'hit', glob: ['*.txt'], outputMode: 'content', limit: 1 }, c.execution())
    assert.equal(result.scanComplete, false)
    assert.equal(result.pageComplete, true)
    assert.equal(result.totalExact, false)
    assert.equal(result.totalLowerBound, 300)
    assert.equal(result.total, undefined)
    assert.equal(result.omitted, undefined)
    assert.equal(result.stopReason, 'pageLimit')
    const all = await surface.call('grep', { pattern: 'hit', glob: ['*.txt'], outputMode: 'summary' }, c.execution())
    assert.equal(all.scanComplete, true)
    assert.equal(all.totalExact, true)
    assert.equal(all.matched, 301)
    await surface.stop()
  }))
})

report('file-budget')
