# 真实语料 grep / glob 基线 — 2026-10-29

[English and reproduction](README.md)。这是 fork [PR #2](https://github.com/OldLigant/dsh-ops/pull/2) 的独立证据，作为 #103/#87 延伸与 #384 测评。代码版本 `1a32c1c`，基于上游 `a9174ac3`。本分支只供结果复核，不随 feature PR 合入上游。

确认轮中，OPS 提前停止 grep 的中位耗时约为完整查询的 1/3.38–1/10.07，返回前缀一致；glob 中位数为 620–970 ms，零命中仍扫描整树。缓存和系统噪声仍存在，这些是本机观察值，支持进一步研究遍历成本，不能证明尚未实测的索引方案值得采用。

## 方法

Windows 11 Home China 10.0.26200, x64; 13th Gen Intel(R) Core(TM) i9-13980HX; 32 logical CPUs, 31.6 GiB RAM; Node v24.22.1; rustc 1.99.1 (58cf8f9c3 2026-10-13).

客户端固定源码 3,155 文件、21.9 MiB；Python 固定安装的 Lib 为 4,121 文件、112.8 MiB。使用匹配的 release worker 与编译插件，通过真实 host 派发，无模型调用。首轮 2 次预热、5 次实测；因部分序列仍下降，又做一次 5 次预热、5 次实测的确认。两份报告各有 160 次实测、零调用错误，输入未变化；以下主表采用确认轮，原始数据全部保留。调用臂交替，case 顺序固定；不保证 OS 冷缓存或稳态，不作跨机器推断。

预热前 Python 完整查询曾在 30,034.9 ms 被中断，触及未修改的 30 秒上限。诊断失败日志保留；预热成功不代表冷启动可靠，也不证明底层慢的具体原因。首份报告的单数计数解析尚未修正，Python 单文件 glob 的 displayedItems 为 null；保留原文，确认轮已正确记录 1。

## #384：完整扫描与提前停止

|Corpus|Limit|OPS exact median ms [range]|OPS bounded median ms [range]|Median ratio|Scanned exact → bounded|
|---|---:|---:|---:|---:|---:|
|harness-client|5|1054.5 [936.9–1520.0]|238.2 [208.3–337.5]|4.43×|3155 → 19|
|harness-client|50|1230.4 [953.3–2076.3]|364.4 [220.6–671.2]|3.38×|3155 → 28|
|python-stdlib|5|2417.3 [2083.2–5289.5]|240.2 [229.7–263.6]|10.07×|4120 → 87|
|python-stdlib|50|2369.3 [2152.7–2436.6]|266.8 [241.1–423.1]|8.88×|4120 → 94|

源码查询为 `^export ` + `**/*.ts`，Python 为 `^def ` + `**/*.py`。完整匹配数分别为 3,712 和 8,621。四组预热后真实调用验证了返回 path/line/text 前缀完全相同；提前停止仅报告下界、不伪造 total、不提供稳定续页，证据见 prefix-warm.json。收益来自明确少做完整计数工作。小结果集受进程固定开销和噪声影响，不能把 limit 50 偶尔快于 5 解读成规律。

官方 grep 没有调用级 limit/exactTotal，默认展示最多 250 项并可能溢出保存，因此保留其原始耗时作参照，不声称与 OPS 是等量工作。

## glob 基线

|Corpus / query|Official median ms|OPS median ms [range]|OPS matched total / displayed|OPS scanned|
|---|---:|---:|---:|---:|
|harness-client / glob-name|150.2|660.9 [398.7–1013.6]|68 / 68|3155|
|harness-client / glob-miss|135.0|664.0 [461.1–708.3]|0 / 0|3155|
|harness-client / glob-ts|276.9|620.2 [475.6–762.2]|1275 / 100|3155|
|python-stdlib / glob-name|276.7|728.5 [527.1–1069.5]|1 / 1|4120|
|python-stdlib / glob-miss|189.6|795.0 [631.0–813.8]|0 / 0|4120|
|python-stdlib / glob-py|547.1|970.1 [717.3–1301.4]|2170 / 100|4120|

文件名查询为 `**/package.json` / `**/os.py`；无命中查询使用唯一哨兵文件名；扩展名为 ts/py。OPS 的 glob 全部完整扫描，零命中仍遍历整个可扫描树；扩展名查询仅返回 100 项，但保留精确总数。官方按修改时间排序且包含隐藏/依赖路径，OPS 按路径排序并排除它们，不能直接把两者倍率当成同一算法的速度差。

数据证明现有重复路径查询有可测成本，但不能单独判断其中多少属于可消除的遍历、元数据校验、启动或渲染。此次没有测试 UFFS、Everything 或任何索引。采用决策：证据不足，暂不引入；后续候选实现放在 fork 独立分支，连同建库、刷新、失效和整体资源成本一起比较。

## 保留的无过滤 grep-miss

|Corpus|Official median ms|OPS median ms [range]|Scan complete|Skipped files|Exact match total|
|---|---:|---:|---|---:|---|
|harness-client|321.7|2164.4 [2035.7–2501.4]|false|26|unknown|
|python-stdlib|412.7|8332.2 [6131.3–12238.6]|false|1319|unknown|

这两行内容覆盖不完整，精确匹配总数未知，只能反映尝试扫描的成本，不能证明整个语料没有匹配，也不能直接宣称相对官方工具的通用性能倍率。

## 两轮结果完整列出

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

范围较宽，表中是本机观察值，不是稳定延迟保证或统计显著性结论。先前启动失败、预热轮和原始日志均保留，没有选取最佳样本。复现命令、验证过程与原始文件说明见英文版；压缩 JSON 未改写内容。
