# Real-corpus calls — evidence 2026-10-30

Machine: win32 x64, Node v24.22.1, 32 CPUs, 32 GiB.

OPS build: 0.5.0, lib sha256 4d1af77da0f8, worker sha256 13ba443bfbcc. Official arm: dsh-tool-fs 0.2.0-rc.2, dsh-tool-fs-search 0.2.0-rc.2.

Runs: in-budget warmup 2 / repeat 5; over-budget warmup 1 / repeat 3; npm-runtime warmup 1 / repeat 3.

Exit codes: in-budget 0, over-budget 0, npm-runtime 1 (one case exceeded the 30 s call cap; see 3).

## 1. In-budget corpora — the #384 question

The exact scans complete inside the budget (the matched total is known), so the exact/bounded ratio describes doing less work, not a faster algorithm. The earlier evidence round verified identical path/line/text prefixes for these same four queries over the same pins; this round does not repeat that check. Matched totals: 3,712 and 8,621.

### harness-client (source, 3155 files / 21.9 MiB, pin git-archive@22ddee379240)

| case | official ms | candidate ms | scanned | complete | truncatedBy | matched | displayed | errors o/c |
| --- | ---: | ---: | ---: | --- | --- | --- | ---: | --- |
| grep-hit-5-exact | 522.4 | 1088.5 | 3155 | true | row-limit | 3712/3712 | 5 | 0/0 |
| grep-hit-5-bounded | 340.8 | 234.3 | 19 | false | row-limit | 5/null | 5 | 0/0 |
| grep-hit-50-exact | 271.0 | 1454.1 | 3155 | true | row-limit | 3712/3712 | 50 | 0/0 |
| grep-hit-50-bounded | 265.5 | 222.6 | 28 | false | row-limit | 50/null | 50 | 0/0 |
| glob-name | 135.8 | 458.8 | 3155 | true | none | 68/68 | 68 | 0/0 |
| glob-miss | 130.5 | 421.0 | 3155 | true | none | 0/0 | 0 | 0/0 |
| grep-miss | 156.0 | 2257.5 | 3155 | false | none | 0/null | 0 | 0/0 |
| glob-ts | 382.9 | 653.3 | 3155 | true | row-limit | 1275/1275 | 100 | 0/0 |

### python-stdlib (runtime, 4121 files / 112.8 MiB, pin content@content)

| case | official ms | candidate ms | scanned | complete | truncatedBy | matched | displayed | errors o/c |
| --- | ---: | ---: | ---: | --- | --- | --- | ---: | --- |
| grep-hit-5-exact | 373.4 | 2137.8 | 4120 | true | row-limit | 8621/8621 | 5 | 0/0 |
| grep-hit-5-bounded | 366.9 | 197.1 | 87 | false | row-limit | 5/null | 5 | 0/0 |
| grep-hit-50-exact | 374.1 | 2204.8 | 4120 | true | row-limit | 8621/8621 | 50 | 0/0 |
| grep-hit-50-bounded | 404.5 | 209.7 | 94 | false | row-limit | 50/null | 50 | 0/0 |
| glob-name | 144.3 | 507.1 | 4120 | true | none | 1/1 | 1 | 0/0 |
| glob-miss | 143.4 | 478.6 | 4120 | true | none | 0/0 | 0 | 0/0 |
| grep-miss | 303.2 | 3846.5 | 4120 | false | none | 0/null | 0 | 0/0 |
| glob-py | 198.0 | 502.1 | 4120 | true | row-limit | 2170/2170 | 100 | 0/0 |

## 2. Over-budget corpora — coverage, not speed

Every call completes, and every candidate scan stops at the 10,000-file / 256 MiB budget: the matched total is unknown, so these rows say what the budget does and how long it takes to reach it. They are not a speed comparison.

### npm-tree (npm, 14495 files / 511.7 MiB, pin npm-ci@d0d0316897fe)

| case | official ms | candidate ms | scanned | complete | truncatedBy | matched | displayed | errors o/c |
| --- | ---: | ---: | ---: | --- | --- | --- | ---: | --- |
| grep-miss | 360.4 | 12523.2 | 5859 | false | scan-budget | 0/null | 0 | 0/0 |
| glob-name | 197.9 | 807.8 | 10000 | false | scan-budget | 74/null | 74 | 0/0 |
| glob-miss | 195.5 | 759.8 | 10000 | false | scan-budget | 0/null | 0 | 0/0 |
| glob-ts | 218.3 | 763.3 | 10000 | false | scan-budget | 402/null | 100 | 0/0 |

### rust-runtime (runtime, 66077 files / 1330 MiB, pin rustup@1.99.1-x86_64-pc-windows-msvc)

| case | official ms | candidate ms | scanned | complete | truncatedBy | matched | displayed | errors o/c |
| --- | ---: | ---: | ---: | --- | --- | --- | ---: | --- |
| grep-miss | 6990.0 | 1494.5 | 1024 | false | scan-budget | 0/null | 0 | 0/0 |
| glob-name | 322.7 | 613.2 | 10000 | false | scan-budget | 41/null | 41 | 0/0 |
| glob-miss | 277.7 | 645.1 | 10000 | false | scan-budget | 0/null | 0 | 0/0 |
| glob-html | 2132.7 | 649.0 | 10000 | false | scan-budget | 9596/null | 100 | 0/0 |

## 3. npm-runtime — the 30 s wall

The seven filtered cases complete. The unfiltered no-hit scan runs into the 30 s call cap: one round finished near 20 s and two were killed, so the runner reports RESULT_UNKNOWN and exits 1. That row is the finding, not a timing.

### npm-runtime (runtime, 6077 files / 239.7 MiB, pin undefined@undefined)

| case | official ms | candidate ms | scanned | complete | truncatedBy | matched | displayed | errors o/c |
| --- | ---: | ---: | ---: | --- | --- | --- | ---: | --- |
| grep-miss | 263.5 | 19960.5 | 5393 | false | none | 0/null | 0 | 0/2 |
| grep-hit-5-exact | 199.7 | 986.2 | 5393 | true | row-limit | 297/297 | 5 | 0/0 |
| grep-hit-5-bounded | 206.2 | 387.4 | 242 | false | row-limit | 5/null | 5 | 0/0 |
| grep-hit-50-exact | 193.2 | 966.7 | 5393 | true | row-limit | 297/297 | 50 | 0/0 |
| grep-hit-50-bounded | 195.2 | 343.4 | 702 | false | row-limit | 50/null | 50 | 0/0 |
| glob-name | 190.2 | 599.9 | 5393 | true | row-limit | 290/290 | 100 | 0/0 |
| glob-miss | 173.3 | 523.0 | 5393 | true | none | 0/0 | 0 | 0/0 |
| glob-js | 197.5 | 532.6 | 5393 | true | row-limit | 972/972 | 100 | 0/0 |

## Caveats

- Warmup was not enough for every series: the runs warned that glob-name/glob-miss/glob-html and some candidate series were still falling. All samples are kept; none were dropped to get a better number.
- Dispatch-to-result time includes the tool bridge and the child process; it is not model-task time and not portable across machines.
- Official grep has no per-call limit or exactTotal, and its sort/exclusion rules differ; the official column is a reference, not proof of equal work.
- Real timing runs stay manual evidence. CI asserts behaviour, never a duration.
