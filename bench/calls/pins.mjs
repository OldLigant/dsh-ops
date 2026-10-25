/**
 * Pinning: how a corpus stops being "whatever happens to be installed" and becomes a
 * version-addressed directory that a second run can still be paired with.
 *
 * Four kinds, in increasing order of what they promise:
 *
 * - `npm-ci` — a fixture `package.json` + `package-lock.json` in the repo; the corpus is
 *   materialized into `bench/runs/corpora/<id>@<lock12>/` by `npm ci`. The lockfile pins
 *   every transitive version and integrity hash, so the directory *name* is the version.
 * - `rustup` — a specific `<channel>-<target>` toolchain directory. rustup installs it
 *   once and never mutates it, so the path itself is the pin; `identity.expect` then
 *   pins the channel manifest's bytes.
 * - `git-archive` — one commit of a local clone (`repo`), archived with `git archive` and
 *   extracted into `bench/runs/corpora/<id>@<commit12>/`; `subdir` narrows it to one
 *   directory. The commit is the version, so a moved branch never changes the corpus.
 * - `content` — no materialization; `identity.expect` alone refuses a tree whose declared
 *   provenance files do not hash to the recorded values. This is the fallback for an
 *   installation that has no lockfile to install from.
 *
 * A manifest without a `pin` still runs, but the report says `pinned: false` and the run
 * cannot be claimed as reproducible. That is deliberate: no silent "probably the same".
 *
 * @module dsh-ops/bench/calls/pins
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { expandTemplate } from './paths.mjs'
import { npmInvocation } from '../../scripts/lib/build/util.js'

/** Pin kinds this resolver understands. */
export const PIN_KINDS = ['npm-ci', 'rustup', 'git-archive', 'content']

/** Where materialized corpora live, relative to the checkout. Gitignored with the rest of `bench/runs`. */
export const CORPORA_HOME = path.join('bench', 'runs', 'corpora')

const PIN_FIELDS = {
  'npm-ci': ['kind', 'fixture', 'root'],
  rustup: ['kind', 'toolchain', 'target', 'profile'],
  'git-archive': ['kind', 'repo', 'commit', 'subdir'],
  content: ['kind'],
}

/**
 * Validate a `pin` block. Called from manifest loading, so a typo names itself before a
 * run ever starts.
 * @param {object} pin - the declared block.
 * @param {string} where - the manifest id, for the error message.
 * @returns {object} the same block.
 */
export function validatePin(pin, where) {
  if (typeof pin !== 'object' || pin === null) throw new Error(`${where}: pin must be an object`)
  if (!PIN_KINDS.includes(pin.kind)) throw new Error(`${where}: unknown pin.kind "${pin.kind}" (known: ${PIN_KINDS.join(', ')})`)
  const allowed = PIN_FIELDS[pin.kind]
  for (const key of Object.keys(pin)) if (!allowed.includes(key)) throw new Error(`${where}: unknown pin field "${key}" for kind ${pin.kind} (known: ${allowed.join(', ')})`)
  if (pin.kind === 'npm-ci') {
    if (typeof pin.fixture !== 'string' || pin.fixture === '') throw new Error(`${where}: npm-ci pin needs fixture (a directory with package.json and package-lock.json)`)
    if (pin.root !== undefined && (typeof pin.root !== 'string' || pin.root === '')) throw new Error(`${where}: npm-ci pin.root must be a non-empty relative path`)
  }
  if (pin.kind === 'git-archive') {
    if (typeof pin.repo !== 'string' || pin.repo.trim() === '') throw new Error(`${where}: git-archive pin needs repo (a local clone path or a clone URL)`)
    if (typeof pin.commit !== 'string' || !/^[0-9a-f]{40}$/.test(pin.commit)) throw new Error(`${where}: git-archive pin.commit must be a full 40-character lower-case sha`)
    if (pin.subdir !== undefined) {
      const segments = typeof pin.subdir === 'string' ? pin.subdir.split('/') : []
      if (typeof pin.subdir !== 'string' || pin.subdir === '' || path.isAbsolute(pin.subdir) || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
        throw new Error(`${where}: git-archive pin.subdir must be a relative path inside the repository`)
      }
    }
  }
  if (pin.kind === 'rustup') {
    if (typeof pin.toolchain !== 'string' || pin.toolchain.trim() === '') throw new Error(`${where}: rustup pin needs toolchain`)
    const targets = Array.isArray(pin.target) ? pin.target : [pin.target]
    if (targets.length === 0 || targets.some(target => typeof target !== 'string' || target.trim() === '')) throw new Error(`${where}: rustup pin.target must be a target triple or a non-empty array of them`)
    if (pin.profile !== undefined && !['minimal', 'default', 'complete'].includes(pin.profile)) throw new Error(`${where}: rustup pin.profile must be minimal, default or complete`)
  }
  return pin
}

/**
 * The version a pin addresses. It is also the directory suffix for `npm-ci` and
 * `git-archive`, so two different lockfiles or commits never share a materialized tree.
 *
 * @param {object} manifest - a manifest with a validated pin.
 * @param {{repoRoot: string, home?: string, env?: NodeJS.ProcessEnv}} context - expansion values.
 * @returns {string} the version token.
 */
export function pinVersion(manifest, context) {
  const pin = manifest.pin
  if (pin.kind === 'npm-ci') {
    const fixture = expandTemplate(pin.fixture, context)
    const lock = path.join(fixture, 'package-lock.json')
    if (!fs.existsSync(lock)) throw new Error(`${manifest.id}: pinned fixture has no package-lock.json: ${lock}`)
    return createHash('sha256').update(fs.readFileSync(lock)).digest('hex').slice(0, 12)
  }
  if (pin.kind === 'rustup') {
    // A target list lets one manifest run on every host the repo supports; the installed
    // triple wins, and an uninstalled one still produces the exact install command.
    const rustupHome = context.env?.RUSTUP_HOME ?? path.join(context.home ?? os.homedir(), '.rustup')
    const targets = Array.isArray(pin.target) ? pin.target : [pin.target]
    const installed = targets.find(target => fs.existsSync(path.join(rustupHome, 'toolchains', `${pin.toolchain}-${target}`)))
    return `${pin.toolchain}-${installed ?? targets[0]}`
  }
  if (pin.kind === 'git-archive') return pin.commit.slice(0, 12)
  return 'content'
}

/**
 * Where a pin's tree lives, whether or not it has been materialized.
 *
 * @param {object} manifest - a manifest with a validated pin.
 * @param {{repoRoot: string, home?: string, env?: NodeJS.ProcessEnv}} context - expansion values.
 * @returns {{kind: string, version: string, dir: string|null, root: string|null}} the target.
 */
export function pinTarget(manifest, context) {
  const pin = manifest.pin
  const version = pinVersion(manifest, context)
  if (pin.kind === 'content') return { kind: 'content', version, dir: null, root: null }
  if (pin.kind === 'npm-ci') {
    const dir = path.join(context.repoRoot, CORPORA_HOME, `${manifest.id}@${version}`)
    return { kind: 'npm-ci', version, dir, root: path.join(dir, pin.root ?? 'node_modules') }
  }
  if (pin.kind === 'git-archive') {
    const dir = path.join(context.repoRoot, CORPORA_HOME, `${manifest.id}@${version}`)
    return { kind: 'git-archive', version, dir, root: dir }
  }
  const rustupHome = context.env?.RUSTUP_HOME ?? path.join(context.home ?? os.homedir(), '.rustup')
  const dir = path.join(rustupHome, 'toolchains', version)
  return { kind: 'rustup', version, dir, root: dir }
}

/**
 * Resolve the pinned root, or refuse with the exact command that would create it.
 * A pin that silently falls back to a live directory would defeat its own purpose.
 *
 * @param {object} manifest - a manifest with a validated pin.
 * @param {{repoRoot: string, home?: string, env?: NodeJS.ProcessEnv}} context - expansion values.
 * @returns {{kind: string, version: string, dir: string|null, root: string|null}} the resolved target.
 */
export function resolvePinnedRoot(manifest, context) {
  const target = pinTarget(manifest, context)
  if (target.kind === 'content') return target
  if (!fs.existsSync(target.root) || (target.kind === 'git-archive' && fs.readdirSync(target.root).length === 0)) {
    const fix = target.kind === 'rustup'
      ? `rustup toolchain install ${target.version} --profile ${manifest.pin.profile ?? 'default'}`
      : `node bench/calls/materialize.mjs ${manifest.id}`
    throw new Error(`${manifest.id}: pinned tree is not materialized: ${target.root}\nRun: ${fix}`)
  }
  return target
}

/**
 * The materialization plan for one corpus, as data so `--dry-run` and the real run
 * cannot drift apart.
 *
 * @param {object} manifest - a manifest with a validated pin.
 * @param {{repoRoot: string, home?: string, env?: NodeJS.ProcessEnv}} context - expansion values.
 * @returns {{kind: string, dest: string|null, steps: {type: 'copy'|'mkdir'|'remove'|'run', from?: string, to?: string, target?: string, command?: string, cwd?: string, args?: string[]}[], exists: boolean, version: string}} the plan.
 */
export function materializePlan(manifest, context) {
  const target = pinTarget(manifest, context)
  const exists = target.dir !== null && fs.existsSync(target.root)
  if (target.kind === 'npm-ci') {
    const fixture = expandTemplate(manifest.pin.fixture, context)
    return {
      kind: target.kind, dest: target.dir, exists, version: target.version,
      steps: [
        { type: 'copy', from: path.join(fixture, 'package.json'), to: path.join(target.dir, 'package.json') },
        { type: 'copy', from: path.join(fixture, 'package-lock.json'), to: path.join(target.dir, 'package-lock.json') },
        { type: 'run', ...npmInvocation(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', target.dir]) },
      ],
    }
  }
  if (target.kind === 'rustup') {
    return {
      kind: target.kind, dest: target.dir, exists, version: target.version,
      steps: [{ type: 'run', command: 'rustup', args: ['toolchain', 'install', target.version, '--profile', manifest.pin.profile ?? 'default'] }],
    }
  }
  if (target.kind === 'git-archive') {
    const repo = expandTemplate(manifest.pin.repo, context)
    const subdir = manifest.pin.subdir
    // `git archive <commit> <subdir>` keeps the subdir as the tar's leading segments, so the
    // extraction strips exactly as many as the manifest named — never a guessed depth.
    const strip = subdir === undefined ? 0 : subdir.split('/').length
    // The archive stays *inside* the destination and tar runs there with a relative name:
    // GNU tar on Windows reads `D:\\...` as a remote host, and a relative name is the one
    // spelling that works for GNU tar, bsdtar and Windows bsdtar alike.
    const archive = path.join(target.dir, '.corpus.tar')
    return {
      kind: target.kind, dest: target.dir, version: target.version,
      // An empty destination is what a failed `git archive` leaves behind; it is not a corpus.
      exists: exists && target.dir !== null && fs.readdirSync(target.dir).some(name => name !== '.corpus.tar'),
      steps: [
        { type: 'mkdir', to: target.dir },
        // Line endings are part of the bytes: force LF so an operator's `core.autocrlf`
        // cannot change the corpus the commit names.
        { type: 'run', command: 'git', args: ['-C', repo, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', `--output=${archive}`, manifest.pin.commit, ...(subdir === undefined ? [] : [subdir])] },
        { type: 'run', command: 'tar', cwd: target.dir, args: ['-xf', '.corpus.tar', `--strip-components=${strip}`] },
        { type: 'remove', target: archive },
      ],
    }
  }
  return { kind: 'content', dest: null, exists: true, version: target.version, steps: [] }
}
