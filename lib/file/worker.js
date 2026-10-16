/** Native file worker bridge. The host owns path resolution and DSH authority. */
import path from 'node:path'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { denied } from '../permissions.js'
import { resolveWorker } from '../ptc/runtime.js'
import { normalizeArguments } from './contract.js'
import { resolveFileBudgets } from './budgets.js'
import { performance } from 'node:perf_hooks'

export { resolveWorker }

export function failure(code, message, phase = 'preflight', effectState = 'none') {
  return { status: code === 'POLICY_DENIED' ? 'rejected' : 'error', phase,
    changed: 0, matched: 0, skipped: 0, failed: 0, complete: false, omitted: 0,
    error: { code, phase, retryable: false, effectState,
      nextAction: effectState === 'none' ? 'Correct the request or restore host authority.' : 'Inspect the result; do not blindly retry after an unknown effect.', message } }
}

function absoluteTarget(raw, cwd) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) return undefined
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw)
}
function inside(root, target) {
  const base = path.resolve(root)
  const candidate = path.resolve(target)
  const relative = path.relative(base, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Host `fs` service, when the deployment has one; observation is skipped without it. */
function hostFs(ctx) {
  try {
    const service = ctx.get('fs')
    return typeof service?.resolve === 'function' && typeof service?.stat === 'function' ? service : undefined
  } catch { return undefined }
}

/** Resolve and stat one path through the host provider, as host read does before reading. */
async function hostObservation(fsService, file, cwd, signal) {
  if (!fsService) return undefined
  try {
    const target = await abortable(fsService.resolve(file, { cwd, signal }), signal)
    return { target, info: await abortable(fsService.stat(target, signal), signal) }
  } catch { return undefined }
}
function abortable(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('File operation cancelled'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Record an observation in the host's read-before-edit table; best effort, never fails the call. */
function emitObserved(ctx, observed, exec) {
  if (!observed) return
  const { target, info } = observed
  const observation = info === undefined ? { kind: 'absent' }
    : info.type === 'file' && info.version ? { kind: 'present', version: info.version } : undefined
  if (!observation) return
  try { ctx.emit('fs/observed', target, observation, exec) } catch { /* the completed effect stands */ }
}

/** Refresh host observations for files a completed replace wrote (#17). */
async function observeReplaced(ctx, fsService, value, cwd, exec, signal) {
  if (!fsService || value?.status !== 'completed' || value.dryRun || !(value.changed > 0) || !Array.isArray(value.items)) return
  for (const item of value.items) {
    if (typeof item?.path !== 'string') continue
    const observed = await hostObservation(fsService, item.path, cwd, signal)
    // A size mismatch means another writer landed after our publish; leave the host to report stale.
    if (observed?.info?.type === 'file' && observed.info.size === item.bytesAfter) emitObserved(ctx, observed, exec)
  }
}

export async function invoke(ctx, file, tool, args, exec, signal, options = {}) {
  const started = performance.now()
  const budgets = resolveFileBudgets(options.budgets)
  const controller = new AbortController()
  const state = { budgets, started, expired: false, handle: undefined, spawned: false }
  const abort = () => { if (signal?.reason?.name === 'TimeoutError') state.expired = true; controller.abort(signal?.reason) }
  if (signal?.aborted) abort()
  else signal?.addEventListener?.('abort', abort, { once: true })
  const timer = setTimeout(() => { state.expired = true; controller.abort(new Error('Native file deadline exceeded')) }, budgets.timeoutMs)
  try {
    const result = await invokeSettled(ctx, file, tool, args, exec, controller.signal, state)
    if (state.handle?.waitForExit) await state.handle.waitForExit()
    if (controller.signal.aborted) return interruption(tool, state, true)
    return result
  } catch (error) {
    state.handle?.terminate?.()
    return failure(tool === 'replace' && state.spawned ? 'RESULT_UNKNOWN' : 'EXECUTOR_FAILED',
      `Could not confirm native worker range exit: ${String(error?.message ?? error).slice(0, 500)}`, 'execute', tool === 'replace' && state.spawned ? 'unknown' : 'none')
  }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', abort)
  }
}
function interruption(tool, state, cancelled) {
  if (tool === 'replace' && state.spawned) return failure('RESULT_UNKNOWN', 'Worker interrupted; inspect replacement postconditions before retrying.', 'execute', 'unknown')
  const code = state.expired ? 'DEADLINE_EXCEEDED' : cancelled ? 'CANCELLED' : 'EXECUTOR_FAILED'
  return { ...failure(code, state.expired ? 'File deadline exceeded; the owned worker has exited.' : 'File operation interrupted without write effects.', 'execute'),
    scanComplete: false, pageComplete: false, totalExact: false,
    stopReason: state.expired ? 'deadline' : 'cancelled' }
}
function settledValue(value, policy, budgets, tool) {
  const result = { ...value, sandbox: { mode: policy.mode, enforcement: 'policy', boundary: 'trusted-native-file-operations' } }
  const text = JSON.stringify(result)
  // Verify both the value and its text-render wrapper, including JSON escaping.
  if (Buffer.byteLength(text) > budgets.maxOutputBytes || Buffer.byteLength(JSON.stringify([{ type: 'text', text }])) > budgets.maxOutputBytes) {
    return failure('OUTPUT_LIMIT', 'Native result exceeded the final rendered byte budget.', 'verify', tool === 'replace' ? 'unknown' : 'none')
  }
  return result
}
async function invokeSettled(ctx, file, tool, args, exec, signal, state) {
  const session = exec?.agent?.session
  const cwd = session?.header?.cwd
  if (!session?.id || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return failure('POLICY_DENIED', 'An authoritative session identity and cwd are required.')
  const policyService = ctx.get('sandboxPolicy')
  const subprocess = ctx.get('subprocess')
  if (!policyService?.resolve || !subprocess?.spawn) return failure('EXECUTOR_UNAVAILABLE', 'DSH policy and subprocess services are required.')
  let policy
  try { policy = policyService.resolve({ session }) } catch (error) { return failure('POLICY_DENIED', String(error?.message ?? error)) }
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode)
    || typeof policy.workspaceRoot !== 'string' || !path.isAbsolute(policy.workspaceRoot)) return failure('POLICY_DENIED', 'Invalid authoritative DSH policy.')

  args = normalizeArguments(tool, args)
  if (tool === 'replace' && policy.mode === 'read-only') return denied(policy, 'replace', 'workspace-write', 'The user selected read-only; no files were changed.')
  const operationPath = absoluteTarget(args?.path ?? '.', cwd)
  if (!operationPath) return failure('INVALID_ARGUMENT', 'path must be a non-empty path.')
  const canonical = value => { try { return fs.realpathSync.native(value) } catch { return value } }
  const writeRoots = [policy.workspaceRoot, tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])].map(canonical)
  if (tool === 'replace' && policy.mode === 'workspace-write' &&
    !writeRoots.some(root => inside(root, canonical(operationPath)))) {
    return denied(policy, 'replace outside the workspace or DSH temporary areas', 'danger-full-access', 'The user authorized workspace writes only; no files were changed.')
  }

  const workerArgs = { ...args, path: operationPath }
  let spawned = false
  try {
    // Trusted, fixed file operations follow DSH fs-sandbox's policy fence,
    // not an arbitrary-code runner. The worker accepts data, never shell/code.
    // This is the only file execution path, not a sandbox-failure fallback.
    const argv = [file]
    signal?.throwIfAborted?.()
    const fsService = hostFs(ctx)
    // Stat before reading, like host read: a concurrent change records the older version and fails stale later.
    const readObservation = tool === 'inspect_local_file' ? await hostObservation(fsService, operationPath, cwd, signal) : undefined
    signal.throwIfAborted()
    const current = policyService.resolve({ session })
    if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) return failure('POLICY_DENIED', 'Authority changed during preparation.')
    const remaining = Math.max(0, state.budgets.timeoutMs - (performance.now() - state.started))
    const reserve = Math.min(1000, Math.ceil(state.budgets.timeoutMs / 5))
    const input = JSON.stringify({ root: cwd, scope: String(session.id), tool, args: workerArgs, read_only: policy.mode === 'read-only',
      ...(tool === 'replace' ? {} : { file_budget: { ...state.budgets, timeoutMs: Math.max(0, Math.floor(remaining - reserve)), maxOutputBytes: Math.floor((state.budgets.maxOutputBytes - 2048) / 2) } }),
      ...(policy.mode === 'workspace-write' ? { write_roots: writeRoots } : {}) })
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) return failure('OUTPUT_LIMIT', 'Request exceeds the 2 MiB byte budget.')
    signal.throwIfAborted()
    const handle = subprocess.spawn({ argv, cwd, stdio: { stdin: { data: input }, stdout: { maxBytes: 128 * 1024 }, stderr: { maxBytes: 16 * 1024 } }, graceMs: 1000, signal })
    state.handle = handle
    state.spawned = true
    spawned = true
    const outcome = await handle.done
    const stdout = handle.collected.stdout.readFrom(0)
    const stderr = handle.collected.stderr.readFrom(0)
    if (signal?.aborted || outcome.signal) return interruption(tool, state, signal?.aborted)
    if (stdout.lossy) return failure('OUTPUT_LIMIT', 'Worker output exceeded the byte budget.', 'verify', tool === 'replace' ? 'unknown' : 'none')
    if (outcome.exitCode !== 0) return failure(tool === 'replace' ? 'RESULT_UNKNOWN' : 'EXECUTOR_FAILED', `Worker did not return a settled result: ${stderr.text.slice(0, 500)}`, 'execute', tool === 'replace' ? 'unknown' : 'none')
    let value
    try { value = JSON.parse(stdout.text) } catch { return failure(tool === 'replace' ? 'RESULT_UNKNOWN' : 'EXECUTOR_FAILED', 'Worker returned invalid JSON.', 'verify', tool === 'replace' ? 'unknown' : 'none') }
    // Report reads/writes to the host's read-before-edit table, exactly like host read/edit. (#17)
    if (tool === 'inspect_local_file' && value?.status === 'completed' && value.scanComplete !== false) emitObserved(ctx, readObservation, exec)
    if (tool === 'replace') await observeReplaced(ctx, fsService, value, cwd, exec, signal)
    return settledValue(value, policy, state.budgets, tool)
  } catch (error) {
    if (signal?.aborted) return interruption(tool, state, true)
    return failure(spawned && tool === 'replace' ? 'RESULT_UNKNOWN' : 'EXECUTOR_UNAVAILABLE', `DSH trusted file executor failed; this is not a user authorization denial. ${String(error?.message ?? error)}`, 'execute', spawned && tool === 'replace' ? 'unknown' : 'none')
  }
}
