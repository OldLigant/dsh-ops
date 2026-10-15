# PR 0 file benchmark implementation plan

**Goal:** Implement the approved issue #87 PR 0 design: a manual release-worker comparison, five disposable deterministic fixtures, and baseline evidence.

**Architecture:** A CLI calls independent fixture and measurement helpers using only Node built-ins. It spawns explicitly selected workers, sends read-only native requests, waits for close, hashes canonical JSON, and excludes timeouts/errors/differences from speedup claims.

**Spec:** The three `dsh-ops-*` planning documents supplied by the user in `D:/dsh/dev`, especially section 2 of the benchmark design. User requested direct implementation in this chat, sequential PRs without stacking.

## Constraints and upstream audit

- Local clean main and upstream main both `6a7a4c79847705e7025b0467c03f005020efa263` (checked 2026-10-16).
- PR #81 overlaps output budgets, hex offset, multiline, native protocol and platform support. PR #99 changes host file boundaries; #79 adds worker acceptance tooling. Do not implement their changes here.
- Only benchmark code, its tests and documentation; no native optimization, CI gate, timing threshold, cache clearing or system changes.
- Test outputs always explicitly target dedicated temporary paths. Cleanup inventories owned files and refuses unexpected content before deleting individual files.
- Every grep/glob request declares outputMode; inspect has no outputMode parameter and must not receive an unsupported field.

## Tasks

- [x] Add benchmark self-tests for mismatch/error/timeout reporting, process reaping, canonical output, deterministic fixtures and safe cleanup. Verify missing implementation fails.
- [x] Implement `bench/fixtures.mjs`: fixed seed, small-files (10k × 4 KiB plus excluded subtrees), deep-tree (10k × 4 KiB at depth 32), big-file (33 MiB plus small files), dense-hits (200 files), edge-text (long line, UTF-8, escapes, CRLF, BOM and invalid suffix). Scale file counts, preserve size boundaries.
- [x] Implement `bench/measure.mjs`: spawn-to-close timing, 60s watchdog, bounded stdout, stable normalization without discarding result semantics, per-query empty expected-difference allowlist, median and honest comparison status.
- [x] Implement `bench/files.mjs`, explicit binary SHA-256, warmup once then five alternating paired rounds, exclusive JSON report plus console table, `bench:files` npm script and usage documentation.
- [x] Run self-tests and local verify; build/save baseline release worker and run a full baseline-vs-identical-release comparison with explicitly named test output paths; retain JSON and publish a concise table. Report any environment limits accurately. Evidence: `bench/results/2026-10-16-win32-x64.md`; full run has deep-tree timeouts, serial scale=0.01 run has 13 matching successful queries and one expected rejection. Full local verify passed all 16 suites.

## Review focus

- Unexpected files or links in fixtures: refuse cleanup rather than recursively delete.
- Matching error envelopes: report expected rejection separately; never call two failures a speedup.
- Variable JSON key order/timing versus changed content: normalize only timing fields and key order, preserve item order and counts.
- Warmup timeouts, unstable repetitions and expected semantic changes: suppress speedup.
- Long-line output and failed spawn: bounded collection and await actual child close; no hanging subprocess or parsed stdout fragments.
