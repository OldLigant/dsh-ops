# Real-corpus tool-call timing

中文：[工具调用基准](工具调用基准.md)。Command reference: [bench](../bench/README.md).

`node bench/cli.mjs calls` measures host-dispatched `grep` and `glob` calls without a
model. It supports official tools versus OPS and two OPS builds in the same harness.
There is no separate upstream/fork benchmark branch. Measurement runs are opt-in;
tests of the harness can run in CI, but timings never decide a CI gate.

## Prepare the inputs

Run from a checkout with its locked development dependencies installed. Build each OPS
checkout with `npm run build` and
`cargo build --release --locked --manifest-path native/Cargo.toml`. Each measured build
must expose the current `lib/components/file`, `lib/components/discovery` and
`lib/policy.js` interfaces. This runner does not adapt older 0.3.x plugin APIs.

Use separate build directories (existing checkouts or worktrees); no separate copy of
the benchmark is needed. Both arms use the host packages installed in the **runner**
checkout, so this measures OPS changes under one host version, not a host upgrade.

Choose a corpus from `bench/corpora`. Pinned corpora resolve to versioned directories;
for example, `node bench/cli.mjs materialize npm-tree` installs the independent locked
npm fixture. For `harness-client`, set `DSH_HARNESS_SRC` to a clone containing the pinned
commit and run `node bench/cli.mjs materialize harness-client`. Use `--dry-run` to inspect
materialization steps. Local paths may differ between machines; the corpus pin and
recorded content identity, not the absolute directory name, describe the workload.

## The shipped corpora

Five manifests ship in `bench/corpora`, in two groups decided by the scan budget. Every
manifest declares a shape range (files, MiB, depth, binary-byte ratio) that the runner checks
before it measures anything. In-budget corpora carry all eight cases; the two that exceed the
10,000-file / 256 MiB budget carry the four coverage cases, because a full count never
completes there and a hit pair would compare two partial scans.

| Corpus | Class | Workload | Cases | Pin | Prepare |
| --- | --- | --- | ---: | --- | --- |
| `harness-client` | source | one commit's `packages/client`, 3,155 files / 21.9 MiB | 8 | `git-archive` `22ddee3` | `DSH_HARNESS_SRC=<clone with the commit> node bench/cli.mjs materialize harness-client` |
| `python-stdlib` | runtime | an installed CPython stdlib, 4,121 files / 112.8 MiB | 8 | `content` (sha256 of `python3.dll` / `python.exe`) | the DSH runtime install; nothing to build |
| `npm-tree` | npm | a frozen lockfile installed by `npm ci`, 14,495 files / 511.7 MiB | 4 | `npm-ci` fixture | `node bench/cli.mjs materialize npm-tree` |
| `rust-runtime` | runtime | a rustup `1.99.1 --profile default` toolchain, 66,077 files / 1,330 MiB | 4 | `rustup` `1.99.1` | `rustup toolchain install 1.99.1 --profile default` |
| `npm-runtime` | runtime | this checkout's installed `@deepseek-ai` packages, 6,077 files / 239.7 MiB | 8 | **none** (live directory) | the checkout's own `npm ci` |

- The over-budget corpora measure coverage, not speed. `npm-tree` stops at the 10,000-file
  budget after about 0.8 s (`truncatedBy=scan-budget`). A `<!DOCTYPE` hit query over
  `rust-runtime`'s 62,149 HTML files was tried and dropped: the official tool fails on output size
  while OPS' full count ends in `RESULT_UNKNOWN` at the 30 s cap, so no comparable pair exists.
- A 30 s call cap is a separate wall from the scan budget: `npm-runtime` is inside the byte
  budget, yet its unfiltered no-hit scan measured 20–30 s and was killed in two of three rounds.
  That row is cap evidence, not a timing, and it is why the run reports an error rather than a number.
- `npm-tree`'s pinned lockfile includes the Windows Bash payload (9,614 of its files), so its
  declared shape is the Windows x64 measurement. Another platform refuses the shape check
  instead of filing a different workload under the same name; pass `--root` for an ad-hoc run.
- `npm-runtime` deliberately has no pin: it describes whatever the runner has installed, so
  `--require-pinned` refuses it. It is the only corpus that answers "the packages I actually run".
- A `rustup` pin follows `RUSTUP_HOME`, so a toolchain can live under `bench/runs/rustup` (inside
  the workspace) instead of the operator's profile; `calls` and `materialize` read the same variable.
- A declared shape describes the *pinned* tree, not a live checkout: `npm-tree`'s range must follow
  what its lockfile actually installs, otherwise the first materialized run refuses it.

## Run a comparison

Create a dedicated output directory first. These PowerShell examples use a unique
temporary directory; replace the two build paths with your existing builds:

```powershell
$benchOutput = Join-Path ([IO.Path]::GetTempPath()) ('dsh-ops-call-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $benchOutput | Out-Null

# Default: official tools versus this checkout's OPS build.
node bench/cli.mjs calls --corpus harness-client --require-pinned --warmup 2 --repeat 5 --out "$benchOutput/official-vs-ops.json"

# Current OPS versus candidate OPS, in one process.
node bench/cli.mjs calls --corpus harness-client --require-pinned --baseline-plugin-root 'D:/builds/ops-current' --plugin-root 'D:/builds/ops-candidate' --warmup 2 --repeat 5 --out "$benchOutput/current-vs-candidate.json"
```

- Without `--baseline-plugin-root`, the selected arms default to `official,candidate`.
- With it, they default to `baseline,candidate`. Add
  `--projection official,baseline,candidate` to include all three in the same run.
- Each OPS arm uses its own `lib/`, public tool names and release worker.
  `--baseline-worker` and `--worker` override the corresponding executable.
- `--dry-run` prints the corpus, arm paths and call plan without booting hosts or writing.
  It does not validate the builds; execution preflight does that before host boot.
- `--baseline <previous.json>` only checks corpus identity against a prior report. It
  does **not** select the baseline OPS build or compare historical timing samples.
- `--root` overrides one corpus's location and marks it unpinned; it is rejected with
  `--require-pinned`. Every report path must be new; existing evidence is never overwritten.

## Read the evidence

Every shipped manifest keeps its unfiltered `grep-miss` scan and pairs content queries at
limits 5 and 50 with `exactTotal` true/false (#384). `args.include` maps to the OPS `glob`
filter. Compare each exact/bounded OPS pair for prefix-query savings; `summary` still needs a
full scan. All five keep an extension glob and add an exact-basename and a no-match glob, so
each corpus answers the same eight questions.

These measure current traversal, not UFFS or an index's build/refresh/memory costs.
Official tools are a separate reference: their grep has no per-call `limit` or
`exactTotal`, and their glob uses modified-time order and includes hidden/dependency
paths that OPS excludes. Different coverage, ordering and caps mean different work.

Arms execute sequentially within each case and reverse order on alternate rounds.
Warmup calls use the same schedule but are excluded from measured rows. The report's
`arms` map identifies each OPS package version, compiled `libSha256` and worker path/hash;
the official arm records its tool-package versions. Existing top-level `pluginRoot`
and `worker` fields continue to identify the candidate, or are null if absent.

Each case/arm archives its effective `arguments`, including OPS overrides. Coverage
adds `matchedObserved`, `matchedTotal` and `displayedItems` when present; absent facts
are null, not zero. Early stops report a lower bound, not an exact total.

`corpora[].rows` preserves arm and round order, dispatch-to-result `durationMs`, child
`spawnMs`, output bytes, coverage and errors. Each case summarizes the arms separately.
Child time is included in total time; it is not an additional cost to add to the total.

Read elapsed time alongside scan completeness, truncation, skipped files and output
semantics. The two versions share the same logical query and OPS argument overrides;
the harness does not prove result equivalence. A version that stops early may appear
faster because it did less work. Official tools do not expose the same coverage facts.

`firstMs` means the first **measured** call after warmup. Even `--warmup 0` does not
guarantee a cold OS cache. `steadyMs` / `convergedAt` describe a tail within 10% of the
last sample; a one-sample tail alone cannot prove steady state. Increase warmup when
the runner reports that timings are still falling. Same-process alternation reduces
ordering drift; it does not make timings portable or eliminate machine noise.

Exit `0` means the measured calls and corpus checks succeeded, `1` means unusable
evidence (call error, input mutation, shape or identity mismatch), and `2` means invalid
arguments or missing inputs/builds. None means “the candidate is slower”. To validate
the setup, first point both version arms at the same build; this is an A/A check, not
evidence of a speedup.

## CI coverage

The default test inventory includes `bench-calls`, `bench-call-versions` and
`bench-gates-errors`: deterministic fixtures, argument/identity checks, separate plugin
loading, execution order and honest error reporting. They assert no timing or model cost.
The optional `workflow_dispatch` input `bench=true` also runs `bench/calls/smoke.mjs`
on Linux, Windows and macOS: two tiny text files, official tools and the same staged OPS
build on both sides, 12 measured calls. It checks successful dispatch and same-build
output-size/coverage consistency, uploads `calls.json`, and remains non-blocking.
Installed real corpora and cross-version performance measurements remain manual evidence.
