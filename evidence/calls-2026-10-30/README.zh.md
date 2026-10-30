# 真实语料 calls — 2026-10-30

`node bench/cli.mjs calls` 的第二轮全语料实测，距 2026-10-29 基线一天（基线在
`bench/evidence-search-20261029` 分支的 `evidence/search-baseline-2026-10-29`）。
父提交：`4907657`。

本轮用三次运行覆盖全部五套语料：两套预算内语料回答 #384 的完整/提前停止问题，两套超预算
语料测覆盖率而不是速度，`npm-runtime` 记录无过滤无命中扫描撞上 30 s 调用上限的行为。

## 本轮补充了什么

- 五套语料都从各自的 pin 跑起来：`npm-tree` 安装提交里的锁文件，`rust-runtime` 解析到
  已物化的 `1.99.1` 工具链，`harness-client` 再次从公开 harness 仓库的固定 commit 归档，
  `python-stdlib` 校验 `python3.dll` / `python.exe` 的 sha256。
- `npm-tree` 的 shape 现在描述它自己的锁文件实际装出来的树（14,495 文件 / 511.7 MiB）。
  旧区间描述的是一个活 checkout，夹具从来没装出过那个规模，所以第一次物化就被拒绝。
- 同样四条 #384 查询、同样 pin 的第二次独立运行。匹配总数（3,712 与 8,621）不变，
  说明测的是同一个工作量，不是新造的工作量。
- 超预算两套只报告预算行为：`npm-tree` 每次调用约 0.8 s 触到 10,000 文件预算，
  `rust-runtime` 的无过滤扫描在 1,024 个文件处停止（字节预算）。那里不声明命中对照；
  被放弃的八 case 尝试连同事由保留在 `superseded/`。

## 运行

| 轮次 | 语料 | warmup | repeat | 退出码 | 文件 |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | `harness-client`、`python-stdlib` | 2 | 5 | 0 | `in-budget.json.gz` |
| 2 | `npm-tree`、`rust-runtime` | 1 | 3 | 0 | `over-budget.json.gz` |
| 3 | `npm-runtime` | 1 | 3 | 1 | `npm-runtime.json.gz` |

第 3 轮退出码为 1：其中一个 case（无过滤无命中扫描）在三轮里有两轮超过 30 s 调用上限，
host 返回 `RESULT_UNKNOWN`，runner 保留错误行。那一行是"上限证据"，不是耗时；其余七个
case 正常完成。

命令（依次串行执行，每轮使用新的输出路径）：

```text
node bench/cli.mjs calls --corpus harness-client --corpus python-stdlib --require-pinned \
  --warmup 2 --repeat 5 --out <evidence>/in-budget.json
node bench/cli.mjs calls --corpus npm-tree --corpus rust-runtime --require-pinned \
  --warmup 1 --repeat 3 --out <evidence>/over-budget.json
node bench/cli.mjs calls --corpus npm-runtime \
  --warmup 1 --repeat 3 --out <evidence>/npm-runtime.json
```

## 关键数字

#384 确认轮，派发到结果的中位数：

| 语料 | limit | 官方 ms | OPS 完整 ms | OPS 提前停止 ms | 倍数 | 扫描 完整 → 提前停止 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| harness-client | 5 | 522.4 | 1088.5 | 234.3 | 4.6x | 3155 → 19 |
| harness-client | 50 | 271.0 | 1454.1 | 222.6 | 6.5x | 3155 → 28 |
| python-stdlib | 5 | 373.4 | 2137.8 | 197.1 | 10.8x | 4120 → 87 |
| python-stdlib | 50 | 374.1 | 2204.8 | 209.7 | 10.5x | 4120 → 94 |

超预算语料的覆盖率事实（OPS 每次扫描都 `scanComplete=false`）：

| 语料 | case | 官方 ms | OPS ms | 扫描文件 | truncatedBy |
| --- | --- | ---: | ---: | ---: | --- |
| npm-tree | glob-ts | 218.3 | 763.3 | 10000 | scan-budget |
| npm-tree | grep-miss | 360.4 | 12523.2 | 5859 | scan-budget |
| rust-runtime | glob-html | 2132.7 | 649.0 | 10000 | scan-budget |
| rust-runtime | grep-miss | 6990.0 | 1494.5 | 1024 | scan-budget |

`npm-runtime`：七个 case 正常（limit 5 时完整 986 ms / 提前停止 387 ms，50 时 967 / 343）；
无过滤无命中扫描 20–30 s，三轮里两轮被杀。

## 边界

- 预热对部分序列仍不够：runner 报告 `glob-name`、`glob-miss`、`glob-html` 及部分候选序列
  仍在下降。所有样本都保留，包括第一次实测。
- 耗时是派发到结果，包含子进程；不是模型任务时间，也不能跨机器移植。
- 官方 grep 没有调用级 `limit`/`exactTotal`，排序与排除规则也和 OPS 不同，官方列只是参照，
  不证明等量工作。
- 提前停止给的是下界，不是总数；超预算行是截断事实，不是速度比较。
- 真实计时始终是人工证据；CI 只断言行为，不裁决耗时。

## 文件

- `in-budget.*`、`over-budget.*`、`npm-runtime.*` —— 三份报告及其控制台日志（gzip，
  内容未改写；`SHA256SUMS` 覆盖全部文件）。
- `SUMMARY.md` —— 由 `summarize.mjs` 从三份报告生成的逐 case 表。
- `environment.json` —— 机器、构建、pin 与父提交。
- `superseded/` —— 被放弃的超预算八 case 报告。它的控制台日志被随后那次「拒绝覆盖」的运行冲掉了，
  因此只留下拒绝信息；报告本身完整。
