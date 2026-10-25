/**
 * P14's gate: the real-corpus, host-dispatched comparison. Shape and hash are the whole
 * contract — a number filed under a tree nobody described is not evidence — and this suite
 * proves the refusals without booting a host, so it runs in the default gate.
 *
 * @module dsh-ops/test/bench-calls
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { describe, treeHash, sampleHash, checkShape } from '../bench/calls/shape.mjs'
import { readManifest, loadManifests, expandRoot, resolveRoot, adaptCase, identityOf, compareIdentities } from '../bench/calls/corpora.mjs'
import { main, parseArgs, median, defaultWorker, coverageOf, converge, MAX_REPEAT } from '../bench/calls/index.mjs'
import { validatePin, pinVersion, pinTarget, resolvePinnedRoot, materializePlan } from '../bench/calls/pins.mjs'
import { main as materializeMain, parseArgs as parseMaterializeArgs, execute as executeMaterialize } from '../bench/calls/materialize.mjs'

const LABEL = 'bench-calls'

/** Build a small tree with one binary-extension file and one nested directory. */
function buildTree(root) {
  fs.mkdirSync(path.join(root, 'nested', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n')
  fs.writeFileSync(path.join(root, 'nested', 'deep', 'b.txt'), 'world\n')
  fs.writeFileSync(path.join(root, 'nested', 'blob.dll'), Buffer.alloc(1000, 7))
  return root
}

await test('shape counts files, depth and binary bytes without reading contents', async () => {
  await withTempDir('calls-shape', async root => {
    buildTree(root)
    const shape = describe(root)
    assert.equal(shape.files, 3)
    assert.equal(shape.directories, 2)
    assert.equal(shape.maxDepth, 2)
    assert.equal(shape.binaryFiles, 1)
    assert.equal(shape.binaryBytes, 1000)
    assert.equal(shape.bytes, 'hello\n'.length + 'world\n'.length + 1000)
    assert.ok(shape.binaryBytesRatio > 0.9)
  })
})

await test('a corpus outside its declared shape is refused, and the ranges are honoured at both ends', () => {
  const shape = { files: 3, mebibytes: 0, maxDepth: 2, binaryBytesRatio: 0.99 }
  assert.equal(checkShape(shape, { files: [3, 3], maxDepth: [0, 2] }).ok, true)
  const verdict = checkShape(shape, { files: [4, 10], binaryBytesRatio: [0, 0.5] })
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.problems.length, 2)
  assert.match(verdict.problems[0], /files=3 outside \[4, 10\]/)
  assert.throws(() => checkShape(shape, { files: [1] }), /must be \[min, max\]/)
  assert.throws(() => checkShape(shape, { nope: [0, 1] }), /not a measured field/)
})

await test('the tree hash is stable for one tree and changes with the input', async () => {
  await withTempDir('calls-hash', async root => {
    buildTree(root)
    const first = treeHash(root)
    assert.equal(treeHash(root), first)
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello again\n')
    assert.notEqual(treeHash(root), first)
  })
})

await test('a pin names its kind and the fields that kind needs', () => {
  assert.equal(validatePin({ kind: 'content' }, 'x').kind, 'content')
  assert.throws(() => validatePin({ kind: 'tarball' }, 'x'), /unknown pin.kind/)
  assert.throws(() => validatePin({ kind: 'npm-ci' }, 'x'), /needs fixture/)
  assert.throws(() => validatePin({ kind: 'npm-ci', fixture: 'f', lock: 'x' }, 'x'), /unknown pin field "lock"/)
  assert.throws(() => validatePin({ kind: 'rustup', target: 'x' }, 'x'), /needs toolchain/)
  assert.equal(validatePin({ kind: 'rustup', toolchain: '1.99.1', target: ['a', 'b'] }, 'x').kind, 'rustup')
  const commit = 'a'.repeat(40)
  assert.equal(validatePin({ kind: 'git-archive', repo: '/tmp/clone', commit, subdir: 'packages/client' }, 'x').kind, 'git-archive')
  assert.throws(() => validatePin({ kind: 'git-archive', commit }, 'x'), /needs repo/)
  assert.throws(() => validatePin({ kind: 'git-archive', repo: '/tmp/clone', commit: 'abc123' }, 'x'), /40-character/)
  assert.throws(() => validatePin({ kind: 'git-archive', repo: '/tmp/clone', commit, subdir: '../outside' }, 'x'), /relative path/)
  assert.throws(() => validatePin({ kind: 'git-archive', repo: '/tmp/clone', commit, subdir: '/abs' }, 'x'), /relative path/)
})

await test('a lockfile pin derives the version from the lock and refuses an empty destination', async () => {
  await withTempDir('calls-pin-npm', async root => {
    const fixture = path.join(root, 'fixture')
    fs.mkdirSync(fixture)
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"name":"fixture","version":"1.0.0"}')
    fs.writeFileSync(path.join(fixture, 'package-lock.json'), '{"lockfileVersion":3}')
    const manifest = { id: 'tiny', pin: { kind: 'npm-ci', fixture, root: 'node_modules' }, identity: { sample: 0 } }
    const context = { repoRoot: root, home: root, env: {} }
    assert.match(pinVersion(manifest, context), /^[0-9a-f]{12}$/)
    const target = pinTarget(manifest, context)
    assert.match(target.dir, /tiny@[0-9a-f]{12}$/)
    assert.equal(target.root, path.join(target.dir, 'node_modules'))
    assert.throws(() => resolvePinnedRoot(manifest, context), /not materialized[\s\S]*materialize\.mjs tiny/)
    const plan = materializePlan(manifest, context)
    assert.equal(plan.steps.filter(step => step.type === 'copy').length, 2)
    assert.match(plan.steps.at(-1).args.join(' '), /npm|ci/)
  })
})

await test('a toolchain pin addresses a versioned directory and names the install command', async () => {
  await withTempDir('calls-pin-rust', async root => {
    const manifest = { id: 'tiny', pin: { kind: 'rustup', toolchain: '1.99.1', target: ['x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu'], profile: 'default' }, identity: { sample: 0 } }
    const context = { repoRoot: root, home: root, env: {} }
    assert.equal(pinVersion(manifest, context), '1.99.1-x86_64-pc-windows-msvc')
    assert.equal(pinTarget(manifest, context).root, path.join(root, '.rustup', 'toolchains', '1.99.1-x86_64-pc-windows-msvc'))
    assert.throws(() => resolvePinnedRoot(manifest, context), /rustup toolchain install 1\.99\.1-x86_64-pc-windows-msvc --profile default/)
  })
})

await test('a git-archive pin addresses one commit and strips exactly the named subdirectory', async () => {
  await withTempDir('calls-pin-git', async root => {
    const commit = 'b'.repeat(40)
    const context = { repoRoot: root, home: root, env: {} }
    const manifest = { id: 'tiny', pin: { kind: 'git-archive', repo: '${env:DSH_HARNESS_SRC}', commit, subdir: 'packages/client' }, identity: { sample: 0 } }
    assert.equal(pinVersion(manifest, context), 'b'.repeat(12))
    const target = pinTarget(manifest, context)
    assert.match(target.dir, /tiny@b{12}$/)
    assert.equal(target.root, target.dir)
    assert.throws(() => resolvePinnedRoot(manifest, context), /not materialized[\s\S]*materialize\.mjs tiny/)
    const plan = materializePlan({ ...manifest, pin: { ...manifest.pin, repo: root } }, context)
    assert.deepEqual(plan.steps.map(step => step.type), ['mkdir', 'run', 'run', 'remove'])
    assert.deepEqual(plan.steps[1].args.slice(0, 3), ['-C', root, '-c'])
    assert.ok(plan.steps[1].args.includes('core.autocrlf=false'))
    assert.ok(plan.steps[1].args.includes('archive'))
    assert.ok(plan.steps[1].args.includes(commit))
    assert.ok(plan.steps[1].args.includes('packages/client'))
    assert.ok(plan.steps[2].args.includes('--strip-components=2'))
    assert.equal(plan.steps[2].cwd, plan.dest)
    assert.equal(plan.steps[2].args[1], '.corpus.tar')
    assert.equal(plan.steps[3].target, path.join(plan.dest, '.corpus.tar'))
    const flat = materializePlan({ ...manifest, pin: { kind: 'git-archive', repo: root, commit } }, context)
    assert.ok(flat.steps[2].args.includes('--strip-components=0'))
    assert.equal(flat.steps[1].args.includes(undefined), false)
  })
})

await test('materialize extracts exactly the pinned commit and leaves no archive behind', async () => {
  await withTempDir('calls-git-archive', async root => {
    const repo = path.join(root, 'clone')
    fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'pkg', 'a.ts'), 'export const a = 1\n')
    fs.writeFileSync(path.join(repo, 'other.txt'), 'not in the corpus\n')
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git(['init', '-q'])
    git(['config', 'user.email', 'bench@example.invalid'])
    git(['config', 'user.name', 'bench'])
    git(['add', '.'])
    git(['commit', '-q', '-m', 'fixture'])
    const commit = git(['rev-parse', 'HEAD'])
    assert.match(commit, /^[0-9a-f]{40}$/)
    const manifest = {
      id: 'tiny', pin: { kind: 'git-archive', repo, commit, subdir: 'pkg' },
      identity: { sample: 0 }, roots: [repo], cases: [],
    }
    const lines = []
    const io = { out: line => lines.push(line), err: line => lines.push(line), manifests: [manifest], repoRoot: root }
    assert.equal(materializeMain(['tiny'], io), 0)
    const dest = path.join(root, 'bench', 'runs', 'corpora', 'tiny@' + commit.slice(0, 12))
    assert.equal(fs.readFileSync(path.join(dest, 'a.ts'), 'utf8'), 'export const a = 1\n')
    assert.equal(fs.existsSync(path.join(dest, 'other.txt')), false)
    assert.equal(fs.existsSync(path.join(dest, '.corpus.tar')), false)
    assert.equal(materializeMain(['tiny'], io), 0)
    assert.match(lines.join('\n'), /already materialized/)
  })
})

await test('materialize dry-runs the exact steps and refuses an unpinned corpus', async () => {
  await withTempDir('calls-materialize', async root => {
    const fixture = path.join(root, 'fixture')
    fs.mkdirSync(fixture)
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"name":"fixture","version":"1.0.0"}')
    fs.writeFileSync(path.join(fixture, 'package-lock.json'), '{"lockfileVersion":3}')
    const pinned = { id: 'tiny', pin: { kind: 'npm-ci', fixture, root: 'node_modules' }, identity: { sample: 0 } }
    const lines = []
    const io = { out: line => lines.push(line), err: line => lines.push(line), manifests: [pinned] }
    assert.equal(materializeMain(['tiny', '--dry-run'], io), 0)
    assert.match(lines.join('\n'), /ci --ignore-scripts --no-audit --no-fund/)
    assert.equal(materializeMain(['missing', '--dry-run'], io), 2)
    assert.equal(materializeMain(['loose', '--dry-run'], { ...io, manifests: [{ id: 'loose', identity: { sample: 0 } }] }), 1)
    assert.throws(() => parseMaterializeArgs([]), /name one corpus/)
  })
})

await test('git materialization previews directory creation and archive removal without writing', async () => {
  await withTempDir('calls-git-preview', async root => {
    const manifest = { id: 'tiny', pin: { kind: 'git-archive', repo: root, commit: 'b'.repeat(40), subdir: 'pkg' } }
    const lines = []
    assert.equal(materializeMain(['tiny', '--dry-run'], { manifests: [manifest], repoRoot: root,
      out: line => lines.push(line), err: line => lines.push(line) }), 0)
    assert.match(lines.join('\n'), /mkdir/)
    assert.match(lines.join('\n'), /git .*archive/)
    assert.match(lines.join('\n'), /tar -xf/)
    assert.match(lines.join('\n'), /remove .*\.corpus\.tar/)
    assert.deepEqual(fs.readdirSync(root), [])
  })
})

await test('npm materialization runs without a shell and keeps install output in its temporary destination', async () => {
  await withTempDir('calls-npm-install', async root => {
    const fixture = path.join(root, 'fixture')
    fs.mkdirSync(fixture)
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'tiny', version: '1.0.0',
      scripts: { postinstall: 'node -e "process.exit(42)"' } }))
    fs.writeFileSync(path.join(fixture, 'package-lock.json'), JSON.stringify({ name: 'tiny', version: '1.0.0',
      lockfileVersion: 3, requires: true, packages: { '': { name: 'tiny', version: '1.0.0' } } }))
    const plan = materializePlan({ id: 'tiny', pin: { kind: 'npm-ci', fixture } }, { repoRoot: root })
    // This fixture needs no packages/network; npm's own cache/logs are isolated too.
    plan.steps.at(-1).args.push('--offline', '--cache', path.join(root, 'npm-cache'))
    const lines = []
    assert.equal(executeMaterialize(plan, { out: line => lines.push(line), err: line => lines.push(line) }), 0, lines.join('\n'))
    assert.equal(fs.readFileSync(path.join(plan.dest, 'package.json'), 'utf8'), fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'))
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false)
  })
})

await test('a recorded identity expectation is a lock, not a note', async () => {
  await withTempDir('calls-expect', async root => {
    const tree = buildTree(path.join(root, 'tree'))
    const provenance = path.join(root, 'lock.json')
    fs.writeFileSync(provenance, '{"locked":true}')
    const template = '${root}/../lock.json'
    const pinned = { id: 'tiny', identity: { files: [template], expect: { [template]: 'a'.repeat(64) }, sample: 0 } }
    assert.throws(() => identityOf(pinned, tree, { repoRoot: root }), /is not the pinned version/)
    const actual = identityOf({ id: 'tiny', identity: { files: [template], sample: 0 } }, tree, { repoRoot: root }).files[0].sha256
    assert.equal(identityOf({ id: 'tiny', identity: { files: [template], expect: { [template]: actual }, sample: 0 } }, tree, { repoRoot: root }).files[0].sha256, actual)
  })
})

await test('the sample hash moves with content, not with the sampled rule', async () => {
  await withTempDir('calls-sample', async root => {
    buildTree(root)
    const first = sampleHash(root, { count: 2 })
    assert.equal(first.files, 2)
    assert.ok(first.bytes > 0)
    assert.equal(sampleHash(root, { count: 2 }).hash, first.hash)
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n')
    assert.notEqual(sampleHash(root, { count: 2 }).hash, first.hash)
    assert.equal(sampleHash(root, { count: 0 }).hash, null)
    assert.throws(() => sampleHash(root, { count: -1 }), /non-negative/)
  })
})

await test('a corpus identity is its provenance files plus a content sample, and differences are named', async () => {
  await withTempDir('calls-identity', async root => {
    const tree = buildTree(path.join(root, 'tree'))
    const provenance = path.join(root, 'lock.json')
    fs.writeFileSync(provenance, '{"locked":true}')
    const manifest = { id: 'tiny', identity: { files: ['${root}/../lock.json'], sample: 4 } }
    const current = identityOf(manifest, tree, { repoRoot: root })
    assert.equal(current.files.length, 1)
    assert.match(current.files[0].path, /lock\.json$/)
    assert.equal(current.combined.length, 64)
    assert.deepEqual(compareIdentities(current, current), [])

    const movedLock = JSON.parse(JSON.stringify(current))
    movedLock.files[0].sha256 = 'f'.repeat(64)
    assert.match(compareIdentities(current, movedLock)[0], /lock\.json differs/)

    const movedTree = JSON.parse(JSON.stringify(current))
    movedTree.sample.hash = 'e'.repeat(64)
    assert.match(compareIdentities(current, movedTree)[0], /tree sample differs/)

    assert.match(compareIdentities(current, { files: [], sample: { hash: null } }).join(' '), /identity file not in baseline/)
    assert.throws(() => identityOf({ id: 'tiny', identity: { files: ['${root}/missing.lock'], sample: 0 } }, tree, { repoRoot: root }), /identity file missing/)
  })
})

await test('a baseline with a different corpus version is refused before any host boots', async () => {
  await withTempDir('calls-baseline', async root => {
    const tree = buildTree(path.join(root, 'tree'))
    const manifest = {
      id: 'tiny', class: 'test', file: path.join(root, 'tiny.json'),
      roots: [path.join(root, 'absent')], shape: { files: [1, 10], maxDepth: [0, 3] },
      identity: { sample: 4 },
      cases: [{ id: 'grep-miss', tool: 'grep', args: { pattern: 'needle', path: '.' } }],
    }
    const io = { out: () => {}, err: () => {}, manifests: [manifest] }
    const matching = path.join(root, 'matching.json')
    const identity = identityOf(manifest, tree, { repoRoot: root })
    fs.writeFileSync(matching, JSON.stringify({ format: 'dsh-ops-calls-v1', corpora: [{ id: 'tiny', identity }] }))
    assert.equal(await main(['--dry-run', '--corpus', 'tiny', '--root', tree, '--baseline', matching], io), 0)

    const drifted = path.join(root, 'drifted.json')
    fs.writeFileSync(drifted, JSON.stringify({ format: 'dsh-ops-calls-v1', corpora: [{ id: 'tiny', identity: { ...identity, sample: { ...identity.sample, hash: 'a'.repeat(64) } } }] }))
    const lines = []
    assert.equal(await main(['--dry-run', '--corpus', 'tiny', '--root', tree, '--baseline', drifted], { ...io, err: line => lines.push(line) }), 1)
    assert.match(lines.join('\n'), /not the same software version/)
    assert.match(lines.join('\n'), /tree sample differs/)
  })
})

await test('the shipped source corpus is pinned to one commit, not to a working tree', () => {
  const manifest = loadManifests().find(item => item.id === 'harness-client')
  assert.ok(manifest, 'harness-client manifest is shipped')
  assert.equal(manifest.class, 'source')
  assert.equal(manifest.pin.kind, 'git-archive')
  assert.match(manifest.pin.commit, /^[0-9a-f]{40}$/)
  assert.equal(manifest.pin.subdir, 'packages/client')
})

await test('a manifest with a typo, a duplicate id or an unknown tool fails by name', async () => {
  await withTempDir('calls-manifest', async root => {
    const write = (name, document) => {
      const file = path.join(root, name)
      fs.writeFileSync(file, JSON.stringify(document))
      return file
    }
    const base = { id: 'tiny', roots: ['${repo}/node_modules'], identity: { sample: 4 }, cases: [{ id: 'grep-miss', tool: 'grep', args: { pattern: 'x', path: '.' } }] }
    assert.throws(() => readManifest(write('bare.json', { ...base, identity: undefined })), /identity is required/)
    assert.throws(() => readManifest(write('ident.json', { ...base, identity: { files: [], sample: 0 } })), /identity needs files or a positive sample/)
    assert.equal(readManifest(write('ok.json', base)).id, 'tiny')
    assert.throws(() => readManifest(write('typo.json', { ...base, colour: 'red' })), /unknown field "colour"/)
    assert.throws(() => readManifest(write('dup.json', { ...base, cases: [base.cases[0], base.cases[0]] })), /duplicate case id/)
    assert.throws(() => readManifest(write('tool.json', { ...base, cases: [{ id: 'x', tool: 'sed', args: { pattern: 'x' } }] })), /unknown tool "sed"/)
    assert.throws(() => readManifest(write('range.json', { ...base, id: 'Tiny' })), /lower-case/)
    // A directory load must be all-or-nothing: the broken files above are in `root`, so
    // only the clean subdirectory is loadable.
    const clean = path.join(root, 'clean')
    fs.mkdirSync(clean)
    fs.copyFileSync(path.join(root, 'ok.json'), path.join(clean, 'ok.json'))
    assert.deepEqual(loadManifests(clean).map(manifest => manifest.id), ['tiny'])
  })
})

await test('roots expand only the three documented placeholders and must exist', async () => {
  await withTempDir('calls-roots', async root => {
    const manifest = { id: 'tiny', roots: ['${repo}/node_modules'] }
    assert.equal(expandRoot('${repo}/src', { repoRoot: root, home: root, env: {} }), path.join(root, 'src'))
    assert.equal(expandRoot('${home}/x', { repoRoot: root, home: root, env: {} }), path.join(root, 'x'))
    assert.throws(() => expandRoot('${env:DSH_OPS_CALLS_MISSING}/x', { repoRoot: root, env: {} }), /is not set/)
    assert.throws(() => resolveRoot(manifest, { repoRoot: root, home: root, env: {} }), /no corpus root exists/)
    assert.throws(() => resolveRoot(manifest, { repoRoot: root, override: path.join(root, 'absent') }), /does not exist/)
    assert.equal(resolveRoot(manifest, { repoRoot: root, override: root }), root)
  })
})

await test('one logical query maps to the two projections without inventing arguments', () => {
  const name = logical => `ops_${logical}`
  const grep = { id: 'g', tool: 'grep', args: { pattern: 'needle', path: '.' } }
  assert.deepEqual(adaptCase(grep, 'official', name), { name: 'grep', args: { pattern: 'needle', path: '.' } })
  assert.deepEqual(adaptCase(grep, 'candidate', name), { name: 'ops_grep', args: { pattern: 'needle', path: '.', outputMode: 'summary' } })
  const glob = { id: 'p', tool: 'glob', args: { pattern: '**/*.ts', path: '.' } }
  assert.deepEqual(adaptCase(glob, 'official', name).args, { pattern: '**/*.ts', path: '.' })
  assert.deepEqual(adaptCase(glob, 'candidate', name).args, { pattern: ['**/*.ts'], path: '.', outputMode: 'paths', sort: 'path', limit: 100 })
  assert.equal(adaptCase({ ...glob, candidate: { limit: 5 } }, 'candidate', name).args.limit, 5)
  assert.throws(() => adaptCase(grep, 'nope', name), /unknown projection/)
})

await test('argv rejects a missing destination, a bad repeat and an unknown projection', () => {
  assert.throws(() => parseArgs([]), /--out is required/)
  assert.throws(() => parseArgs(['--out', 'x', '--repeat', '0']), /1\.\.10/)
  assert.throws(() => parseArgs(['--out', 'x', '--repeat', String(MAX_REPEAT + 1)]), /1\.\./)
  assert.throws(() => parseArgs(['--out', 'x', '--projection', 'official,nope']), /unknown projection/)
  assert.throws(() => parseArgs(['--out', 'x', '--root', 'y']), /exactly one --corpus/)
  assert.throws(() => parseArgs(['--out', 'x', '--warmup', '6']), /0\.\.5/)
  assert.equal(parseArgs(['--out', 'x', '--warmup', '0']).warmup, 0)
  assert.equal(parseArgs(['--out', 'x']).warmup, 1)
  assert.throws(() => parseArgs(['--out', 'x', '--wat', 'y']), /unknown flag/)
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['--dry-run']).dryRun, true)
  assert.deepEqual(parseArgs(['--out', 'x', '--corpus', 'a', '--corpus', 'a', '--projection', 'candidate,official,candidate']).projections, ['candidate', 'official'])
  assert.match(defaultWorker(), /dsh-ops-worker/)
  assert.equal(parseArgs(['--out', 'x', '--plugin-root', '/tmp/checkout']).pluginRoot, '/tmp/checkout')
  assert.ok(defaultWorker('/tmp/checkout').startsWith(path.join('/tmp/checkout', 'native')))
})

await test('a dry run describes the corpus and boots nothing, and a shape break exits 1', async () => {
  await withTempDir('calls-dry', async root => {
    const tree = buildTree(path.join(root, 'tree'))
    const manifest = {
      id: 'tiny', class: 'test', file: path.join(root, 'tiny.json'),
      roots: [path.join(root, 'absent')], shape: { files: [1, 10], maxDepth: [0, 3] },
      identity: { files: [path.join(tree, 'a.txt')], sample: 4 },
      cases: [{ id: 'grep-miss', tool: 'grep', args: { pattern: 'needle', path: '.' } }],
    }
    const lines = []
    const io = { out: line => lines.push(line), err: line => lines.push(line), manifests: [manifest] }
    assert.equal(await main(['--dry-run', '--corpus', 'tiny', '--root', tree], io), 0)
    assert.match(lines.join('\n'), /files=3/)
    assert.match(lines.join('\n'), /dry run, no host booted/)
    assert.equal(await main(['--dry-run', '--corpus', 'nope', '--root', tree], io), 2)
    assert.equal(await main(['--dry-run', '--corpus', 'tiny', '--root', tree], { ...io, manifests: [{ ...manifest, shape: { files: [1000, 2000] } }] }), 1)
    assert.match(lines.join('\n'), /outside its declared shape/)
  })
})

await test('a partly valid corpus selection refuses every unknown id before resolving inputs', async () => {
  const lines = []
  const code = await main(['--dry-run', '--corpus', 'known', '--corpus', 'typo', '--corpus', 'another-typo'], {
    manifests: [{ id: 'known', roots: ['missing'], cases: [] }], out: () => {}, err: line => lines.push(line),
  })
  assert.equal(code, 2)
  assert.match(lines.join('\n'), /unknown corpus.*typo.*another-typo/)
})

await test('an existing report path is refused before anything is measured', async () => {
  await withTempDir('calls-overwrite', async root => {
    const output = path.join(root, 'report.json')
    fs.writeFileSync(output, 'previous evidence')
    const lines = []
    assert.equal(await main(['--out', output], { out: line => lines.push(line), err: line => lines.push(line), manifests: [] }), 2)
    assert.equal(fs.readFileSync(output, 'utf8'), 'previous evidence')
    assert.match(lines.join('\n'), /refusing to overwrite/)
  })
})

await test('a series is steady only when its tail is flat, and the first touch is kept separate', () => {
  assert.deepEqual(converge([]), { steadyMs: null, convergedAt: null })
  assert.deepEqual(converge([30000, 4800, 1150]), { steadyMs: 1150, convergedAt: 3 })
  assert.deepEqual(converge([2000, 1000]), { steadyMs: 1000, convergedAt: 2 })
  assert.deepEqual(converge([100, 102, 99]), { steadyMs: 100, convergedAt: 1 })
})

await test('coverage facts come from the search notice, and a plain result has none', () => {
  const notice = ['changed=0', '[Notice: scanComplete=false; pageComplete=true; scannedFiles=1024; skippedFiles=127; skipReasons={"oversized":4}; matchedObserved=0.]', '[Notice: 0 items displayed; complete=false; TruncatedBy: scan-budget; nextOffset=0; matched=0.]'].join('\n')
  assert.deepEqual(coverageOf(notice), { scannedFiles: 1024, scanComplete: false, skippedFiles: 127, truncatedBy: 'scan-budget' })
  assert.equal(coverageOf('src/a.ts:3: needle'), null)
})

await test('the median is the paired statistic and an even count averages the middle pair', () => {
  assert.equal(median([]), null)
  assert.equal(median([5]), 5)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([1, 2, 3, 10]), 2.5)
})

report(LABEL)
