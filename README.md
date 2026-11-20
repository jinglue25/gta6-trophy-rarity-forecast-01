# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/jinglue25/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/jinglue25/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

## 任务与接口

预测 GTA VI 的 55 个 PS5 奖杯在指定 target 时刻的 Exophase 获得率，输出 5%、25%、50%、75%、95% 分位数。评分是 logit 尺度的平均 pinball loss，越低越好。

唯一参赛入口为 `main.ts`，面向 Node 22，仅使用标准库，无网络、无依赖。程序按文件名排序读取 `$MAKEFUN_INPUT_DIR`（默认 `/input`）中的每个 `*.in`，解析 `makefun/gta6-trophies-case/v1` JSON，按 case 的 `id` 写入 `$MAKEFUN_OUTPUT_DIR`（默认 `/output`）下的 `<id>.out`。

输出结构如下，每个奖杯恰好一行，ID 不重复；每行五个有限数值均在 0..100 内并非递减，保留至多四位小数，文件不超过 65,536 字节。

```json
{"trophies":[{"id":1,"q":[0.1,0.2,0.3,0.4,0.5]}]}
```

## 分解模型与假设

Exophase 按自身节奏刷新页面。kit 记录的首轮刷新中，被追踪玩家从 638 增至 3,868，除了恒为 100% 的奖杯，其余 rate 均下降。因此直接拟合 rate 的趋势会把玩家池扩张造成的稀释与获得奖杯的真实进度混在一起。本实现独立组织回归、收缩和扩散逻辑，分别预测分母 players 和分子 earners，再相除。

1. **观测处理。** 对每个奖杯的 null rate 使用最近一次非 null 值前向填充；首次有效值之前的 null 不参与拟合。计算近似人数 `E_i = rate_i / 100 × P`。人数来自两位小数百分比的反推，允许非整数；收缩权重中的 n 只统计真实非 null 读数。
2. **时间与 players。** 定义 `x = ln(1 + 距 2026-11-19T00:00:00Z 的小时数)`；发布前少量读数的小时数下截为零。对 `ln(P)` 关于 x 做全历史最小二乘回归，斜率限制为 `[0, 1.5]`，预测人数不低于最后读数。历史 P 恒定或回归失败时保持最后人数。
3. **earners 趋势与收缩。** 对每个奖杯拟合 `ln(E_i + 0.5)` 关于 x 的直线。合并斜率为各奖杯内部去均值后的 `Σxy / Σxx`，各奖杯保留独立截距，全零序列不参与合并。个体斜率以 `n/(n+4)` 权重保留，其余权重收缩到合并斜率；最终斜率限制为 `[-0.5, 3]`。收缩后重定截距，使直线仍经过该奖杯的观测均值。外推到 target 后减去 0.5，得到非负的预测 earners。
4. **rate 与 logit 趋势保护。** 中位数为 `100 × E_i(T)/P(T)`，限制在 `[0.01, 99.99]`。计数趋势在对数尺度拟合；logit 尺度用于 rate 位移保护、扩散和评分，而非直接替代计数分解回归。预测中位数相对最后 rate 的 logit 位移限制为 `±2.5`，避免短历史造成极端外推。
5. **由 history 估计扩散。** 汇总所有奖杯相邻可用读数的 `Δlogit(rate)/√间隔天数`，用 `MAD × 1.4826` 估计稳健标准差，限制为 `[0.40, 1.20]`。间隔非正的读数对不参与估计。若 players 从未变化，说明没有观察到分母刷新，标准差下限改为 0.60。第一版为 0.55；验证显示练习历史完全静止、MAD 为零，结合 kit 所述的未见刷新风险，第二版保守提高该下限，中位数不变。这是模型假设，未经真实目标答案验证。
6. **逐奖杯分位数。** 对 horizon 天数 d，使用 `s_i = sqrt(s_rw² × d + 0.25² + 1/max(E_i,last,1))`；全零奖杯另将局部 s_rw 下限提高至 0.9。以标准正态偏移 `[-1.645,-0.674,0,0.674,1.645]` 在中位数 logit 上加 `z × s_i`，经逆 logit 转回百分数，四舍五入至四位并保证非递减。
7. **退化回退。** 少于三个真实有效读数、时间坐标无变化或回归失败时，保持最后前向填充的 rate 为中位数。始终为零的 earners 取 0.02% 并使用宽扩散；始终为 100% 的奖杯中位数保持 99.99%。完全没有有效 rate 时以 0.01% 回退。leading null 不使用未来观测反向填补。

模型假设对数年龄下的计数增长可向目标延续，玩家追踪群体的构成变化无法由这些汇总数据完全识别。重复的静止读取仍参与回归及 MAD；扩散下限缓解 MAD 被大量零差分压低的问题。没有使用目标答案、当前时钟或随机数，所有输出仅由输入确定。最终目标未知，不能保证击败官方基线。

## 本地运行与验证

```bash
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/tmp/gta6-output node main.ts
node verify.mjs
```

验证器默认读取 `~/workspace/makefun/gta6-trophy-rarity-forecast-01-kit/input`。它对练习输入执行两次并逐字节比较输出，同时检查 55 行、ID 恰为 1..55、严格输出结构、数值范围、分位数顺序及字节上限。若 kit 不可读，会打印原因，仍对仓库中的 fixture 双跑。临时输入副本与输出位于系统临时目录，验证结束清理，不改动 kit。

`dev-fixture.in` 是人工构造的测试数据：普通奖杯的 earners 从 100 缓慢升至 160，players 从 1,000 升至 8,000，最后 rate 为 2%。验证断言预测中位数继续下降；同时覆盖全零、恒 100% 和稀疏有效读数的前向填充回退。fixture 的奖杯元数据只保留本程序读取所需的 ID。

本地最终验证结果：

- p00、p01 的中位数与官方持久性基线一致，平均和最大绝对差均为 0；各输出 2,648 字节。
- fixture 普通奖杯预测中位数为 1.1981%，低于最后的 2%；输出 2,807 字节。
- 三个 case 均通过全部格式、确定性与行为断言。验证不使用答案数据，也不计算比赛 loss。
- 本环境 Node 为 v24.22.1，沙箱拒绝子进程启动（EPERM）。验证器保留正常环境中的独立子进程执行路径，并在本环境改用不同模块 URL 的动态 import 各执行一次入口；这验证了两次完整入口执行的字节一致性，但不等同于两个独立进程。最终一轮每次执行连同被拒绝的启动尝试约 170–329 ms。尚未在本环境实际测试 Node 22。

## 数据来源

原始来源为 [Exophase 的 GTA VI PS5 奖杯页面](https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/)，case 来自主办方（house）按固定时钟保存的页面读取。rate 是该站追踪玩家中获得奖杯的比例，不代表所有游戏玩家；页面显示的 EXP 不用于预测。读取时刻与站点刷新时刻可能不同，过去的读取无法从当前页面重新获取。详见 kit 的 `input/NOTICE.txt` 和 `RULES.txt`。

开发与运行均未联网抓取页面，程序只读取提供的 case。保留原有 MIT LICENSE；未使用 Rockstar 官方 logo、原画或字体。
