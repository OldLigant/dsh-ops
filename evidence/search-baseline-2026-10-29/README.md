# Real-corpus grep and glob baseline — 2026-10-29

Chinese: [中文分析](README.zh.md). Fork-only evidence for [PR #2](https://github.com/OldLigant/dsh-ops/pull/2), extending upstream #103/#87 and covering #384. Source: `1a32c1c57a9e4968baec8bd40f9777070549a50a`; upstream base: `a9174ac3257f15118b5a4683b20ca64529ddadda`.

In the confirmation run, the exact-to-bounded OPS grep median dispatch-time ratio was 3.38–10.07× while returning the same verified prefix. OPS glob medians were 620–970 ms and no-hit glob still scanned the eligible tree. These are local observations with remaining cache/noise effects; they support investigating traversal cost, not adopting an unmeasured index.

## Method and boundaries

- Windows 11 Home China 10.0.26200, x64; 13th Gen Intel(R) Core(TM) i9-13980HX; 32 logical CPUs, 31.6 GiB RAM; Node v24.22.1; rustc 1.99.1 (58cf8f9c3 2026-10-13).
- Matching release worker and compiled plugin, version 0.5.0; host packages are the runner's locked 0.2.0-rc.2 versions. Per-build SHA-256 values and corpus identities are in the JSON reports.
- Client source: pinned commit 22ddee3792402c3e70ec5f86a63c3e3e895a2f60, packages/client, 3,155 files / 21.9 MiB. Python installed Lib: pinned executable/DLL hashes, 4,121 files / 112.8 MiB. No source/runtime corpus content is published here.
- Real host dispatch-to-result timings, no model calls. Child lifetime is included, not added. Arms alternate order; query order within each round is fixed. The original 2-warmup/5-repeat run and confirmation 5-warmup/5-repeat run each have 160 measured calls, zero measured call errors, and unchanged input hashes.
- First-run downward trends prompted one predeclared confirmation with more warmups. The confirmation is the main table; both complete datasets remain available. Warmup counts do not guarantee a cold or steady OS cache. Ranges show remaining noise; no confidence interval, cold-cache claim, timing gate or universal speedup is asserted.
- Before warm measurements, Python exact grep was interrupted at 30,034.9 ms in the prefix diagnostic. The unchanged worker has a 30 s cap. Setup failures/logs are retained; warm success is not proof of cold reliability or a diagnosis of why the filesystem was slow.
- The first report predates the singular-item parser fix and has null displayedItems for Python's singleton glob. It is preserved unchanged; the confirmation correctly records 1. No timed product behavior changed between runs.

## #384: same OPS content query, exact totals versus bounded prefix

|Corpus|Limit|OPS exact median ms [range]|OPS bounded median ms [range]|Median ratio|Scanned exact → bounded|
|---|---:|---:|---:|---:|---:|
|harness-client|5|1054.5 [936.9–1520.0]|238.2 [208.3–337.5]|4.43×|3155 → 19|
|harness-client|50|1230.4 [953.3–2076.3]|364.4 [220.6–671.2]|3.38×|3155 → 28|
|python-stdlib|5|2417.3 [2083.2–5289.5]|240.2 [229.7–263.6]|10.07×|4120 → 87|
|python-stdlib|50|2369.3 [2152.7–2436.6]|266.8 [241.1–423.1]|8.88×|4120 → 94|

Source query: `^export ` in `**/*.ts`; Python query: `^def ` in `**/*.py`. Exact totals are 3,712 and 8,621. Four warmed real-host checks established byte-for-byte identical canonical items for the exact/bounded prefixes (path, line and text), with no stable continuation or invented exact total on bounded calls; see prefix-warm.json and validate-prefix.mjs. Bounded speed reflects intentionally less work, not faster exhaustive search. Limit 50 can be faster than limit 5 because fixed process overhead and noise dominate these small prefixes; do not infer a monotonic timing law from five samples.

Official grep timings for these queries are retained in JSON but are not an equal-work comparator: the pinned official API has no per-call limit/exactTotal and retains up to 250 matches inline with spill behavior. We do not claim output equivalence with official grep.

## Glob traversal baseline

|Corpus / query|Official median ms|OPS median ms [range]|OPS matched total / displayed|OPS scanned|
|---|---:|---:|---:|---:|
|harness-client / glob-name|150.2|660.9 [398.7–1013.6]|68 / 68|3155|
|harness-client / glob-miss|135.0|664.0 [461.1–708.3]|0 / 0|3155|
|harness-client / glob-ts|276.9|620.2 [475.6–762.2]|1275 / 100|3155|
|python-stdlib / glob-name|276.7|728.5 [527.1–1069.5]|1 / 1|4120|
|python-stdlib / glob-miss|189.6|795.0 [631.0–813.8]|0 / 0|4120|
|python-stdlib / glob-py|547.1|970.1 [717.3–1301.4]|2170 / 100|4120|

The filename queries are `**/package.json` and `**/os.py`; miss uses `**/BENCH_NEVER_PRESENT_87`; extension queries are `**/*.ts` / `**/*.py`. All OPS glob scans completed, including zero-hit queries, and still visited the full eligible tree. Broad queries return a 100-item page while retaining the exact match total. Official glob sorts by modified time and includes hidden/dependency paths; OPS sorts by path and excludes those paths. These are same nominal query reference timings, not equivalent result-set/order/cap proofs.

This establishes measurable repeated path-query cost in the current traversal. It does not identify how much is avoidable traversal, metadata verification, process startup or rendering. No UFFS/Everything/index implementation, index construction, invalidation or memory measurement was run. Adoption decision: insufficient evidence to adopt an index now; use this baseline to evaluate candidates later on a separate fork branch, including build/refresh and total resource costs.

## Retained unfiltered no-hit scan

|Corpus|Official median ms|OPS median ms [range]|Scan complete|Skipped files|Exact match total|
|---|---:|---:|---|---:|---|
|harness-client|321.7|2164.4 [2035.7–2501.4]|false|26|unknown|
|python-stdlib|412.7|8332.2 [6131.3–12238.6]|false|1319|unknown|

Both OPS no-hit scans report incomplete content coverage and no exact total. These timings describe attempted scans; they do not prove exhaustive absence or equal work with ripgrep. Do not use these rows alone to claim a grep regression or universal speed ratio.

## Both runs, without selecting the best samples

|Corpus / OPS query|2 warmups: median ms|5 warmups: median ms|
|---|---:|---:|
|harness-client / grep-hit-5-exact|1196.6|1054.5|
|harness-client / grep-hit-5-bounded|425.4|238.2|
|harness-client / grep-hit-50-exact|1172.3|1230.4|
|harness-client / grep-hit-50-bounded|287.4|364.4|
|harness-client / glob-name|550.0|660.9|
|harness-client / glob-miss|558.3|664.0|
|harness-client / grep-miss|2279.2|2164.4|
|harness-client / glob-ts|614.2|620.2|
|python-stdlib / grep-hit-5-exact|2876.1|2417.3|
|python-stdlib / grep-hit-5-bounded|319.4|240.2|
|python-stdlib / grep-hit-50-exact|3797.6|2369.3|
|python-stdlib / grep-hit-50-bounded|257.3|266.8|
|python-stdlib / glob-name|741.3|728.5|
|python-stdlib / glob-miss|794.3|795.0|
|python-stdlib / grep-miss|6878.5|8332.2|
|python-stdlib / glob-py|830.4|970.1|

## Reproduction and validation

Build the source revision with its locked dependencies, `npm run build`, and a release Rust worker. Materialize harness-client at the pinned commit and supply the pinned Python installation; preflight refuses different identity/shape. Create a fresh output directory and isolated temporary DSH_HOME, then run:

```powershell
node bench/cli.mjs calls --corpus harness-client --corpus python-stdlib --require-pinned --plugin-root <matching-build> --worker <release-worker> --warmup 2 --repeat 5 --out <new-directory>/real-calls.json
node bench/cli.mjs calls --corpus harness-client --corpus python-stdlib --require-pinned --plugin-root <matching-build> --worker <release-worker> --warmup 5 --repeat 5 --out <new-directory>/confirmation.json
node validate-prefix.mjs <runner-checkout> <matching-build> <release-worker> <new-directory>/prefix.json
```

Local checks: 22/23 bench suites passed initially in an isolated source copy; the only failure was missing Git history for baseline materialization. Supplying read-only Git history for that one suite passed all 10 checks. Final focused suites: 28 + 6 checks passed; red-before-green verified for added behavior and singular-item review fix. Existing smoke: 12 successful measured host calls. Manifest: 146 checks passed. No full local product gate was claimed. Fork pull-request CI: https://github.com/OldLigant/dsh-ops/actions/runs/40746025185 (consult live status).

Raw JSON is gzip-compressed without content edits. Logs, environment, prefix hashes, the initial runner patch and SHA256SUMS accompany it. The first report uses the patch on parent 8608786; confirmation uses 1a32c1c. Machine evidence stays on this fork-only branch and is not part of the upstream-targeted feature diff.
