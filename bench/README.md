# Manual file-tool benchmark (issue #87, PR 0)

Requires Node `^22.19 || >=24` and two explicitly selected **release** workers.
Uses only Node built-ins; does not provision a worker, resolve a packaged runtime,
invoke a model API, run through DSH, or enable CI/timing gates.

## Build, preserve, compare

First verify the baseline source commit and build it in a clean checkout:

```powershell
git rev-parse HEAD
cargo build --release --locked --manifest-path native/Cargo.toml
New-Item -ItemType Directory -Force out/_test/file-bench/binaries
Copy-Item native/target/release/dsh-ops-worker.exe out/_test/file-bench/binaries/baseline-6a7a4c7.exe
```

Keep that binary while building subsequent candidates. The benchmark does not
overwrite workers or reports. Name a new report each run and create its parent
first. Always give smoke runs a dedicated test output path:

```powershell
New-Item -ItemType Directory -Force out/_test/file-bench/fixtures
npm run bench:files -- `
  --baseline out/_test/file-bench/binaries/baseline-6a7a4c7.exe `
  --candidate native/target/release/dsh-ops-worker.exe `
  --out out/_test/file-bench/comparison-01.json `
  --temp-dir out/_test/file-bench/fixtures
```

For a quick wiring check add `--scale 0.001`; for 50k small/deep files use
`--scale 5`. Scale multiplies small/deep/dense file counts and excluded subtrees,
with a minimum of one. It preserves 4 KiB files, depth 32, the 33 MiB rejection,
8 MiB hex input and 1 MiB long-line boundaries. The default watchdog is 60,000 ms
**per process**; change with `--timeout-ms`. A slow deep-tree case can make the
full run much longer than a few seconds. There is no total-run deadline.

The script prints both SHA-256 hashes. Hashes identify bytes; they cannot prove
release profile or source provenance. Record source commit, build command and
toolchain alongside the table. PR 0 should compare the preserved baseline with
the identical release build to establish repeatability, not claim a speedup.

## Fixtures and queries

Seed: `870016`. Generation happens before timing, in a unique owned directory.
Both engines use the same fixture paths and bytes, with read-only native requests.

| Fixture | Default contents | Queries |
| --- | --- | --- |
| small-files | 10,000 × 4 KiB plus 400 excluded files under node_modules/hidden/target/.venv | no-match grep summary; path glob with include/exclude |
| deep-tree | 10,000 × 4 KiB at depth 32 | no-match grep summary |
| big-file | 33 MiB, 8 MiB, four ordinary files | grep summary; oversize hex rejection; accepted hex window |
| dense-hits | 200 × 256 lines, two occurrences per matching line | summary, count, content limit=10, content offset=128 with context |
| edge-text | 1 MiB line, BOM/Chinese/quotes/backslash/tab/NUL/CRLF, invalid UTF-8 suffix, multibyte character straddling 4 KiB | separate content limit=1 queries so an early match cannot hide the invalid file |

Grep/glob always specify `outputMode`. Inspect does not accept that parameter;
it specifies `view: "hex"` instead. No hidden defaults are sent as unsupported
native fields. Hex offset is deliberately `1`, retaining the baseline semantics;
PR #81's proposed correction must appear as a result difference.

## Measurement and interpretation

Each query has one warmup per engine, then five paired rounds. Pair order is
baseline/candidate, candidate/baseline, alternating. Timing includes spawn,
stdin delivery, worker execution, stdout collection and actual process close.
Parsing/hashing and fixture generation are outside the measured interval.
These are warm filesystem measurements; no cache clearing or Defender changes.

The CLI writes JSON and prints median milliseconds. Timeout/error runs are
excluded from medians. A watchdog kills only the direct owned worker and awaits
close before another run. Stdout collection has a separate 16 MiB harness cap,
allowing the baseline 1 MiB line response to be observed without adopting the
host's 128 KiB cap. Harness overflow is a failed run, never truncated JSON success.

Canonical hashing sorts object keys and removes only `elapsedMs`/`durationMs`.
It preserves item order, paths, text, totals, completion and truncation fields.
Paths are intentionally not erased: both engines receive the same fixture root.
Hashes from separate invocations may differ because their unique roots differ.
Every repetition and warmup is checked for output stability.

- `MATCH`: stable identical successful JSON; speedup is baseline/candidate median.
- `MISMATCH` / `UNSTABLE`: different engine output / different repetition output;
  no speedup. The first differing JSON location is printed and saved.
- `TIMEOUT` / `ERROR` / `WORKER_ERROR`: watchdog, transport/parse/harness failure,
  or an unexpected native error envelope; no speedup.
- `EXPECTED_REJECTION`: both engines reject the 33 MiB inspect with OUTPUT_LIMIT;
  this is boundary evidence, with no speedup or successful-call median.
  Its timings remain available as `rejectedRunsMs` / `rejectionMedianMs`.
- `EXPECTED_DIFFERENCE`: a query-specific reason in `EXPECTED_DIFFERENCES` in
  `measure.mjs`; still no speedup. The allowlist is empty in PR 0. A future PR
  must document the semantic migration and add its own correctness tests.

Any unexpected failure/difference exits nonzero after saving the report. Identical
error envelopes cannot silently pass as a performance improvement. This script
compares behavior; it does not correct existing misleading completeness fields.
Future partial results must be described as partial in accompanying evidence.

The JSON retains individual successful run times, timeout/error counts, hashes,
output bytes, native error details and diagnostic classifications. Counts cover
the five timed runs; `warmupState` records the separate warmup, whose failure also
suppresses speedup. `outputBytes` is the largest timed-response byte count.
A report is exclusively created
(`wx`), so rerunning a command cannot overwrite existing evidence.

Cleanup first inventories the entire owned tree and rejects unexpected files,
directories or links before any deletion. It then unlinks specific owned files
and removes empty owned directories. Unexpected data is left intact with an error.

Run benchmark self-tests using `node test/run.mjs file-bench`. These do not add
the full benchmark to `npm test`; only small harness correctness tests run there.
Native resource regression assertions and `cargo test` integration belong to PR 1;
file deadline/completeness integration tests belong to PR 2.

Baseline build context and measured tables are recorded in
[the Windows baseline evidence](results/2026-10-16-win32-x64.md).

## Upstream audit before implementation (2026-10-16)

Local main and remote `T-Auto/dsh-ops` main were both
`6a7a4c79847705e7025b0467c03f005020efa263`; checkout was clean.

- [#81](https://github.com/T-Auto/dsh-ops/pull/81) touches native file results,
  output truncation, hex offsets, multiline, credential exclusions and platforms.
  Recheck before PR 1/2; do not blindly whitelist its output changes.
- [#99](https://github.com/T-Auto/dsh-ops/pull/99) changes host session file fences.
  Direct worker measurements do not constitute host permission testing.
- [#79](https://github.com/T-Auto/dsh-ops/pull/79) adds acceptance/platform probes;
  this manual performance comparison complements those correctness checks.
- [#95](https://github.com/T-Auto/dsh-ops/pull/95),
  [#90](https://github.com/T-Auto/dsh-ops/pull/90) and other platform PRs touch
  package.json; the only script added here is `bench:files`.
- [#102](https://github.com/T-Auto/dsh-ops/pull/102) proposes contribution/gate
  documentation; this PR does not claim GitHub Actions is running.
