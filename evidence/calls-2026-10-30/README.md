# Real-corpus calls — 2026-10-30

Second full-corpus round for `node bench/cli.mjs calls`, run a day after the
2026-10-29 baseline (`evidence/search-baseline-2026-10-29` on the
`bench/evidence-search-20261029` branch). Parent revision: `4907657`.

The round covers all five corpora in three runs: the two in-budget corpora answer the
#384 exact/bounded question, the two over-budget corpora measure coverage instead of
speed, and `npm-runtime` shows the 30 s call cap on an unfiltered no-hit scan.

## What this round adds

- Every corpus now runs from its pin: `npm-tree` installs its committed lockfile,
  `rust-runtime` resolves a materialized `1.99.1` toolchain, `harness-client` is archived
  again from the pinned commit of the public harness repository, and `python-stdlib` checks
  the sha256 of `python3.dll` / `python.exe`.
- `npm-tree`'s declared shape now describes what its own lockfile installs
  (14,495 files / 511.7 MiB). The previous range described a live checkout the fixture never
  produced, so the first materialized run was refused.
- A second, independent round of the same four #384 queries over the same pins. The matched
  totals (3,712 and 8,621) are unchanged, so this is the same workload, not a new one.
- The over-budget pair reports budget behaviour: `npm-tree` reaches the 10,000-file budget in
  about 0.8 s per call, and `rust-runtime` stops after 1,024 files on the unfiltered scan
  (byte budget). No hit pair is declared there; the superseded attempt that tried one is kept
  under `superseded/` together with the reason.

## Runs

| run | corpora | warmup | repeat | exit | file |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | `harness-client`, `python-stdlib` | 2 | 5 | 0 | `in-budget.json.gz` |
| 2 | `npm-tree`, `rust-runtime` | 1 | 3 | 0 | `over-budget.json.gz` |
| 3 | `npm-runtime` | 1 | 3 | 1 | `npm-runtime.json.gz` |

Run 3 exits 1 because one case (the unfiltered no-hit scan) exceeded the 30 s call cap in two
of three rounds: the host reports `RESULT_UNKNOWN` and the runner keeps the error rows. That
row is the finding, not a timing; the other seven cases complete.

Commands (run sequentially, each with a fresh output path):

```text
node bench/cli.mjs calls --corpus harness-client --corpus python-stdlib --require-pinned \
  --warmup 2 --repeat 5 --out <evidence>/in-budget.json
node bench/cli.mjs calls --corpus npm-tree --corpus rust-runtime --require-pinned \
  --warmup 1 --repeat 3 --out <evidence>/over-budget.json
node bench/cli.mjs calls --corpus npm-runtime \
  --warmup 1 --repeat 3 --out <evidence>/npm-runtime.json
```

## Headline numbers

#384, confirmation run, dispatch-to-result medians:

| corpus | limit | official ms | OPS exact ms | OPS bounded ms | ratio | scanned exact → bounded |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| harness-client | 5 | 522.4 | 1088.5 | 234.3 | 4.6x | 3155 → 19 |
| harness-client | 50 | 271.0 | 1454.1 | 222.6 | 6.5x | 3155 → 28 |
| python-stdlib | 5 | 373.4 | 2137.8 | 197.1 | 10.8x | 4120 → 87 |
| python-stdlib | 50 | 374.1 | 2204.8 | 209.7 | 10.5x | 4120 → 94 |

Over-budget corpora, coverage facts (every OPS scan is `scanComplete=false`):

| corpus | case | official ms | OPS ms | scanned | truncatedBy |
| --- | --- | ---: | ---: | ---: | --- |
| npm-tree | glob-ts | 218.3 | 763.3 | 10000 | scan-budget |
| npm-tree | grep-miss | 360.4 | 12523.2 | 5859 | scan-budget |
| rust-runtime | glob-html | 2132.7 | 649.0 | 10000 | scan-budget |
| rust-runtime | grep-miss | 6990.0 | 1494.5 | 1024 | scan-budget |

`npm-runtime`: seven cases complete (exact 986 ms vs bounded 387 ms at limit 5, 967 vs 343 at
50); the unfiltered no-hit scan ran 20–30 s and was killed in two of three rounds.

## Limits

- Warmup was not enough for every series: the runner reported `glob-name`, `glob-miss`,
  `glob-html` and some candidate series still falling. Every sample is kept, including the
  first measured call.
- Timings are dispatch-to-result and include the child process. They are not model-task time
  and not portable across machines.
- Official grep has no per-call `limit`/`exactTotal`, and its sort/exclusion rules differ from
  OPS, so the official column is a reference, not proof of equal work.
- A bounded result is a lower bound, not a total; the over-budget rows are truncation facts,
  not a speed comparison.
- Real timing runs stay manual evidence; CI asserts behaviour, never a duration.

## Files

- `in-budget.*`, `over-budget.*`, `npm-runtime.*` — the three reports and their console logs
  (gzip, content unmodified; `SHA256SUMS` covers every file).
- `SUMMARY.md` — per-case tables generated from the three reports by `summarize.mjs`.
- `environment.json` — machine, builds, pins and parent revision.
- `superseded/` — the rejected eight-case report on the over-budget pair. Its console log was
  overwritten by the refused re-run, so only the refusal remains there; the report is intact.
