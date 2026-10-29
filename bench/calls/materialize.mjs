#!/usr/bin/env node
/**
 * `bench materialize <corpus>`: turn a *pinned* manifest into a version-addressed
 * directory under `bench/runs/corpora/`, or say exactly which command would do it.
 *
 * This is the step that makes "the corpus" a noun instead of "whatever is installed
 * today". It never overwrites an existing tree and never deletes one: a different lockfile
 * materializes into a different directory, so two versions can coexist and be compared.
 *
 * @module dsh-ops/bench/calls/materialize
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { REPO_ROOT } from '../lib/env.mjs'
import { loadManifests } from './corpora.mjs'
import { materializePlan } from './pins.mjs'

/** The `materialize` help text. */
export function usage() {
  return [
    'usage: node bench/cli.mjs materialize <corpus> [--dry-run]',
    '',
    'Materialize a pinned corpus into bench/runs/corpora/<id>@<version>/.',
    'Pinned by a fixture lockfile (npm-ci), a versioned toolchain (rustup) or one',
    'commit of a local clone (git-archive);',
    'a content-pinned corpus has nothing to build and says so. Existing trees are',
    'never overwritten or removed — a new version is a new directory.',
    '',
    '  --dry-run   print the exact steps; create nothing',
  ].join('\n')
}

/**
 * Parse `materialize` argv.
 * @param {string[]} argv - arguments after the subcommand name.
 * @returns {{help: boolean, dryRun: boolean, corpus: string|null}} the options.
 */
export function parseArgs(argv) {
  const options = { help: false, dryRun: false, corpus: null }
  for (const flag of argv) {
    if (flag === '-h' || flag === '--help') options.help = true
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag.startsWith('-')) throw new Error(`unknown flag "${flag}"`)
    else if (options.corpus === null) options.corpus = flag
    else throw new Error(`unexpected extra argument "${flag}"`)
  }
  if (!options.help && options.corpus === null) throw new Error('name one corpus to materialize')
  return options
}

/**
 * Run one plan. Copies are made first and the package manager runs in the destination,
 * so a failed install leaves an obviously incomplete directory rather than a half-tree
 * that would later pass a shape check.
 *
 * @param {object} plan - a {@link materializePlan} result.
 * @param {{out: Function, err: Function}} io - output sinks.
 * @returns {number} 0 on success, 1 on a failed step.
 */
export function execute(plan, io) {
  for (const step of plan.steps) {
    if (step.type === 'mkdir') {
      fs.mkdirSync(step.to, { recursive: true })
      continue
    }
    if (step.type === 'remove') {
      fs.rmSync(step.target, { force: true })
      continue
    }
    if (step.type === 'copy') {
      if (!fs.existsSync(step.from)) {
        io.err(`bench materialize: missing fixture file: ${step.from}`)
        return 1
      }
      fs.mkdirSync(path.dirname(step.to), { recursive: true })
      fs.copyFileSync(step.from, step.to)
      continue
    }
    io.out(`[materialize] ${step.command} ${step.args.join(' ')}`)
    try {
      execFileSync(step.command, step.args, { cwd: step.cwd ?? REPO_ROOT, stdio: 'inherit', windowsHide: true })
    } catch (error) {
      io.err(`bench materialize: ${step.command} failed: ${String(error?.message ?? error)}`)
      return 1
    }
  }
  return 0
}

/**
 * The `materialize` entry point.
 * @param {string[]} argv - arguments after `materialize`.
 * @param {{out?: Function, err?: Function, manifests?: object[], repoRoot?: string}} [io] - output sinks and the suite's seams (`manifests`, `repoRoot`).
 * @returns {number} 0 ok, 1 failure, 2 usage.
 */
export function main(argv, io = {}) {
  const out = io.out ?? (line => console.log(line))
  const err = io.err ?? (line => console.error(line))
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    err(`bench materialize: ${String(error?.message ?? error)}`)
    err('run "node bench/cli.mjs materialize --help" for usage')
    return 2
  }
  if (options.help) { out(usage()); return 0 }
  const manifests = io.manifests ?? loadManifests()
  const manifest = manifests.find(item => item.id === options.corpus)
  if (!manifest) {
    err(`bench materialize: unknown corpus "${options.corpus}" (known: ${manifests.map(item => item.id).join(', ')})`)
    return 2
  }
  if (!manifest.pin) {
    err(`bench materialize: ${manifest.id} has no pin; add a pin block (npm-ci, rustup, git-archive or content) before claiming a version`)
    return 1
  }
  // `io.repoRoot` is the suite's seam: materializing a throwaway fixture must never write
  // into the checkout's own `bench/runs/corpora/`.
  const plan = materializePlan(manifest, { repoRoot: io.repoRoot ?? REPO_ROOT })
  out(`[materialize] ${manifest.id}@${plan.version} (${plan.kind})`)
  if (plan.dest === null) {
    out('[materialize] content pin: nothing to build; identity.expect is checked on every run')
    return 0
  }
  out(`[materialize] dest ${path.relative(REPO_ROOT, plan.dest).split(path.sep).join('/')}`)
  if (plan.exists) {
    out('[materialize] already materialized at this version; a different lockfile gets a different directory')
    return 0
  }
  if (options.dryRun) {
    for (const step of plan.steps) {
      if (step.type === 'copy') out(`  copy ${step.from} -> ${step.to}`)
      else if (step.type === 'mkdir') out(`  mkdir ${step.to}`)
      else if (step.type === 'remove') out(`  remove ${step.target}`)
      else out(`  run  ${step.command} ${step.args.join(' ')}`)
    }
    return 0
  }
  const code = execute(plan, { out, err })
  if (code === 0) out(`[materialize] done: ${path.relative(REPO_ROOT, plan.dest).split(path.sep).join('/')}`)
  return code
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
