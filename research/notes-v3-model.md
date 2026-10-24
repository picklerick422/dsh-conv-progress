# ETA v3 — LightGBM 分位模型 → 纯 JS 导出（离线实验记录）

日期 2026-10-24 · 数据 `data/samples.csv`（1,344,395 行 / 786 session）· 脚本 `tools/analysis/fit_v3.py`
产物 `data/eta-v3-model.json`（343,922 B）、`data/v3-pred-sample.csv`（500 行）、`tools/analysis/verify_export.mjs`

## 0. 结论

| | v2 基线 | v3 p50 | 变化 |
|---|---|---|---|
| MAE | 265.7 s | **173.1 s** | −34.8% |
| medianAE | 132.8 s | **74.0 s** | −44.3% |
| bias | −120.7 s | **−84.6 s** | 低估减轻 30% |
| RMSE | 465.3 s | **356.3 s** | −23.4% |
| MAPE (`min(5,|e|/max(3s,actual))`) | 1.41 | **0.93** | −34.0% |

- 导出单文件 **343,922 B = 335.9 KiB**，含 3 个分位（0.1/0.5/0.9）、50 特征、250×3 棵树、7,250 节点/模型，**< 400 KB 目标达成**。
- 纯 JS 求值：**14.1 µs/样本**（只算 p50）、**40.5 µs/样本**（三个分位），Node 22 / 本机单线程。
- 保形覆盖率（名义 50/80/90）：实际 **0.4915 / 0.7952 / 0.8995**。
- 先验实验：若能把任务规模估到 σ=0.3（≈±35% 误差），MAE 从 173 s 降到 **125 s**；即使 σ=0.9（几乎无信息）仍降到 158 s。
- `verify_export.mjs` **PASS**：500 行 × 5 列，最大相对误差 **1.68e-6**（阈值 1e-4）。

## 1. 数据切分与特征

| split | 行数 | 用途 |
|---|---|---|
| train | 944,255 | 训练（配置选择另用其中 10% 按 `sid` 哈希留出的 dev 85,747 行） |
| calib | 262,877 | 保形校准（残差分位） |
| test | 137,263 | **只报指标，不参与任何选型** |

- 目标 `y = log1p(remaining_ms)`，反变换 `max(expm1(·), 1)`。
- 特征 50 列 = 31 个数值特征 + 19 个 one-hot（`model_code` 12 档 + `last_tool_cat` 7 档）。以字符串形式出现的两列类别特征被展开成 one-hot，JS 侧只是加常量，避免任何类别比较逻辑。
- 明确排除 eval-only 列：`remaining_ms, dur_ms, total_steps, v2_*, split, sid, turn, t_rel`（`reason_ok` 也排除，全为 1，无信息）。

## 2. 规模/精度权衡（alpha=0.5，train 内 dev 85,747 行）

`dump` 列 = `len(json.dumps(booster_.dump_model(), separators=(',',':')))`（题目要求的估计口径，含每节点 `split_gain/internal_value/...` 等元数据）；`compact` 列 = 实际导出后的紧凑结构字节数。**两者相差 10×**，这是本次选型最关键的一条事实。

| leaves | trees | dev MAE | dev medAE | dump（估） | **compact（实）** | 节点数 | 拟合 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 8 | 120 | 210.5 s | 115.2 s | 315.3 KiB | 31.1 KiB | 1,800 | 18 s |
| 8 | 200 | 191.1 s | 101.5 s | 522.6 KiB | 52.1 KiB | 3,000 | 25 s |
| 8 | 250 | 181.8 s | 94.0 s | 652.1 KiB | 65.1 KiB | 3,750 | 26 s |
| 12 | 250 | 159.0 s | 75.4 s | 996.6 KiB | 97.4 KiB | 5,750 | 32 s |
| **15** | 120 | 175.0 s | 89.3 s | 606.1 KiB | 58.0 KiB | 3,480 | 20 s |
| **15** | 200 | 154.5 s | 73.1 s | 1,006.3 KiB | 97.1 KiB | 5,800 | 32 s |
| **15** | **250** | **146.2 s** | 66.1 s | 1,256.6 KiB | 121.6 KiB | 7,250 | 43 s |
| 20 | 200 | 139.6 s | 61.7 s | 1,351.6 KiB | 129.4 KiB | 7,800 | 31 s |
| 20 | 250 | 132.6 s | 55.7 s | 1,687.7 KiB | 162.1 KiB | 9,750 | 27 s |
| 24 | 150 | 141.0 s | 62.8 s | 1,222.7 KiB | 116.1 KiB | 7,050 | 24 s |
| 24 | 200 | 130.1 s | 54.5 s | 1,628.6 KiB | 155.2 KiB | 9,400 | 23 s |
| 31 | 120 | 138.7 s | 61.3 s | 1,270.1 KiB | 120.0 KiB | 7,320 | 50 s |
| 31 | 200 | 117.9 s | 44.4 s | 2,112.8 KiB | 200.7 KiB | 12,200 | 68 s |
| 31 | 250 | 109.8 s | 38.1 s | 2,639.5 KiB | 251.2 KiB | 15,250 | 70 s |

Pareto 前沿（compact 大小 → dev MAE）：31 KiB/210.5 → 58 KiB/175.0 → 97 KiB/154.5 → 116 KiB/141.0 → 120 KiB/138.7 → 155 KiB/130.1 → 201 KiB/117.9 → 251 KiB/109.8。
**拐点在 120 KiB 附近**：58→97 KiB 换 −20.5 s，97→120 KiB 换 −15.8 s，120→155 KiB 只换 −8.6 s。

**选定 `num_leaves=15, n_estimators=250`**（题目给的规模上限）：单模型 compact 121.6 KiB，×3 分位后整文件 335.9 KiB，留有余量。若只追求精度且不在意 leaves 上限，`leaves=31, trees=120` 在同样 120 KiB 下 dev MAE 再低 5%（138.7 s vs 146.2 s）——**同样的节点预算下"更深更少树"比"更浅更多树"更划算**，需要时可一行配置切换（把 `pick_config` 的 `max_leaves` 放开即可）。

## 3. 训练配置

```python
objective="quantile", alpha in {0.1, 0.5, 0.9}
num_leaves=15, n_estimators=250, learning_rate=0.07, min_child_samples=60
feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0
seed=42, deterministic=True, force_row_wise=True, num_threads=7
```

- 三个分位分别独立训练（不是 multi-quantile 一次训练），LightGBM 4.7.0。
- `init = 0`：LightGBM 的 quantile 目标没有 base score，导出前用「树和 vs `booster.predict`」实测确认（残差均值 < 1e-9，脚本里有硬断言，init 偏离 0 会直接失败）。

## 4. test 指标（137,263 行）

| 模型 | MAE | medAE | RMSE | bias | MAPE | p10 误差 | p90 误差 |
|---|---:|---:|---:|---:|---:|---:|---:|
| v2 基线 | 265.7 s | 132.8 s | 465.3 s | −120.7 s | 1.41 | −656 s | +207 s |
| **v3 p50** | **173.1 s** | **74.0 s** | **356.3 s** | **−84.6 s** | **0.93** | −402 s | +142 s |
| v3 p10（参考） | 294.4 s | 123.4 s | 526.2 s | −291.1 s | 0.67 | — | — |
| v3 p90（参考） | 338.3 s | 311.8 s | 435.0 s | +299.1 s | 2.33 | — | — |

- 题目给的 v2 数字是 264 s / 132 s / −120 s / 1.41；在同一批 CSV 行上复算是 265.7 / 132.8 / −120.7 / 1.41。MAPE、medAE、bias 对得上，MAE 差 0.6%，判断是取整/口径差异，不影响结论。
- p10/p90 是分位数而非点预测，MAE 天然不能和 p50 比；它们的作用是给出非对称区间（见 §6）。

### 按 `dur_ms` 分桶（test）

| 桶 | n | v3 MAE | v2 MAE | 变化 |
|---|---:|---:|---:|---:|
| < 30 s | 1,691 | 29.9 s | 112.4 s | −73.4% |
| 30–120 s | 13,985 | 62.7 s | 106.6 s | −41.2% |
| 2–5 m | 29,352 | 68.5 s | 101.0 s | −32.2% |
| 5–15 m | 50,744 | 117.4 s | 185.3 s | −36.7% |
| > 15 m | 41,491 | 358.5 s | 540.3 s | −33.7% |

短任务收益最大（v2 在 <30 s 段近乎失效，MAE 112 s 相当于把 30 秒的任务估成 2 分钟量级）；长任务仍是最难的一段，>15 m 的 MAE 358 s 说明跨 turn 的规模不确定性没被实时特征解释掉——这也正是 §5 先验实验的动机。

## 5. 先验模拟：「先问大模型任务规模」值多少钱

模拟：`prior_total = total_steps * exp(N(0, sigma))`，其中 `total_steps` **只用于合成先验**（不进特征集）。两个模型都在 train 全量重训、test 评估，alpha=0.5，配置同上。

- **full+prior**：在 50 个实时特征外，追加 `prior_total` 与 `max(prior_total - k, 0)`（当前步序号 `k` 本来就在特征里）。
- **prior-only**：只用 `prior_total` 一个特征（不给任何实时特征），作为「先验信息量」的参考上界。

| sigma | 等价误差量级 | full+prior MAE | vs 无先验 | prior-only MAE |
|---:|---|---:|---:|---:|
| 0（oracle） | 精确知道 | **78.5 s** | −54.7% | 213.7 s |
| 0.15 | ±16% | 105.0 s | −39.3% | 223.3 s |
| 0.30 | ±35% | 125.5 s | −27.5% | 229.4 s |
| 0.45 | ±57% | 139.2 s | −19.6% | 236.9 s |
| 0.60 | ±82% | 149.6 s | −13.6% | 244.7 s |
| 0.90 | ±146% | 158.5 s | −8.5% | 257.5 s |

读法：
1. **价值很高**：即使先验只有 ±35% 的准确度，MAE 也从 173 s 掉到 125 s（−27%），medAE 从 74 s 到 62 s。这比再堆特征/树的收益大得多（§2 里从 15 叶加到 31 叶只换来 −25 s 且体积翻倍）。
2. **衰减很慢**：σ 一路到 0.9（先验基本在 3 倍范围内瞎猜）仍有 −8.5% 收益，说明模型主要把它当成"任务量级"的粗锚，不是精确时长。
3. **只靠先验不够**：prior-only 最好也只有 213.7 s，比不带先验的实时特征模型（173.1 s）还差，但已经优于 v2（265.7 s）。所以正确姿势是"先验 + 实时特征"，不是"用先验替代实时特征"。
4. 注意：σ 是 log 正态尺度，±35% 对应真实产品里"模型报 10 步、实际 6.5–14 步"这种量级的误差；如果实际只能做到 ±2 倍，收益接近表中 σ=0.6 一行。

## 6. 保形校准与区间覆盖率

归一化残差 `r = (actual − pred_p50) / max(pred_p50, floor)`，floor 在 calib 上按「覆盖率偏离最小」选，最终 **floor = 60 s**（10 s / 30 s / 60 s 的总偏离分别是 0.016 / 0.015 / 0.014，差异很小，取 60 s）。

calib 上的残差分位表（已导出进 JSON）：

| q | q025 | q050 | q100 | q250 | q500 | q750 | q900 | q950 | q975 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| value | −0.8863 | −0.8255 | −0.7080 | −0.3565 | −0.0037 | +0.3600 | +1.3159 | +2.3348 | +3.3877 |

区间规则：`lo = max(1, pred + q_lo·max(pred, floor))`，`hi = max(lo, pred + q_hi·max(pred, floor))`。

**test 覆盖率**（calib 定分位，test 只测）：

| 名义 | 用到的残差分位 | 实际覆盖率 | 中位区间宽度 |
|---:|---|---:|---:|
| 50% | q250 / q750 | 0.4915 | 154 s |
| 80% | q100 / q900 | 0.7952 | 435 s |
| 90% | q050 / q950 | 0.8995 | 680 s |

- 三个档位都在 ±1 pp 内，校准可用。
- 残差分布强烈右偏（q500 ≈ 0，q950 = +2.33 而 q050 = −0.83），所以区间是**乘性上偏**的：真实剩余时间可以被低估 5.6 倍，而最多只高估不到 1 倍。产品侧显示「X 分钟（可能 0.2–3X）」会比对称区间诚实。
- 另一条可选路线：直接用 p10/p90 两个分位模型做区间，test 覆盖 **0.7979**（calib 0.8034，名义 80%），与保形表打平，但**不带宽度的乘性解释**，且要多背两个模型——两条路都已导出，可任选。

## 7. 导出格式（JS 契约）

```jsonc
{
  "schema": "eta-v3-quantile-v1",
  "features": ["k", "elapsed_ms", …, "model_code=5", …, "last_tool_cat=0", …], // 50 个，顺序即向量顺序
  "feature_layout": {
    "numeric": [ /* 31 个原始列名 */ ],
    "categorical": { "model_code": [1,2,…], "last_tool_cat": [0,1,…] }   // one-hot 的档位顺序
  },
  "target": { "space": "log1p", "inverse": "expm1", "clip": { "min": 1.0 } },
  "quantiles": { "0.1": { "init": 0, "trees": [{ "f": [...], "x": [...], "s": [...] }] }, "0.5": …, "0.9": … },
  "calibration": { "floor_ms": 60000, "table": { "q050": -0.8255, … }, "coverage_test": { "50": …, "80": …, "90": … } },
  "meta": { "generated_at": …, "config": …, "rows": …, "metrics_test_median_model": …, "sweep": [...], "prior_sigma_curve": [...] }
}
```

求值（与 `verify_export.mjs` 完全一致，14 行）：

```js
// 1) 组向量：前 31 个是原始数值，后面是 one-hot（按 feature_layout 顺序）
// 2) 每棵树：pre-order 展平，左孩子 = i+1，右孩子 = i+1+s[i]
function evalTree(t, v) {
  const { f, x, s } = t;
  let i = 0;
  while (f[i] >= 0) i = v[f[i]] <= x[i] ? i + 1 : i + 1 + s[i];
  return x[i];                       // 叶子：f[i] === -1，叶值存在阈值槽里
}
// 3) pred_log = init + Σ evalTree(...)；value = Math.max(Math.expm1(pred_log), 1)
```

设计要点：
- **去掉 `l`/`r` 两个孩子索引数组**，改用 pre-order + `s[i]`（i 的左子树节点数），比「f/x/l/r 四数组」小 20%，整文件从 403.9 KB 降到 343.9 KB。
- 叶值复用 `x` 槽位（`f[i] < 0` 表示叶子），节点记录压到 ~15 B。
- 阈值保留 7 位有效数字、叶值 9 位；`init=0` 时不写噪声。
- 校验：全量 test 137,263 行「树求值 vs LightGBM `predict`」最大偏差 **4.9e-8**（log 空间），即纯舍入误差，没有分支翻转；`fit_v3.py` 里 `maxdiff > 1e-4` 会直接 `SystemExit`，防止导出坏模型。

### 体积分解

| 部分 | 字节 |
|---|---:|
| quantile 0.1 trees（7,250 节点） | 111,561 |
| quantile 0.5 trees | 111,742 |
| quantile 0.9 trees | 112,026 |
| calibration | 714 |
| meta（含 sweep + prior 曲线） | 5,359 |
| features + feature_layout + target | 1,491 |
| **合计** | **343,922 B（335.9 KiB）** |

对比：同配置 `dump_model()` 原样序列化是 1,286,713 B（约 1.26 MB），压缩比 3.7×。

## 8. 复现命令

```bash
cd /home/user/.dsh/dsh-taskbar
export TMPDIR=/home/user/.dsh/dsh-taskbar/.cache/tmp   # 系统 /tmp 已满，必须

# 全流程（sweep 8.3 min + final/conformal/export 1.7 min + prior 8.4 min ≈ 18 min）
python3 tools/analysis/fit_v3.py

# 只重导出（复用 .cache/v3-cfg.json 与 .cache/v3-prior.json，~2 min）
python3 tools/analysis/fit_v3.py final conformal export report

# 独立 JS 复算校验（500 行 × 5 列，断言相对误差 < 1e-4）
node tools/analysis/verify_export.mjs
```

中间产物在 `.cache/`：`v3-cfg.json`（选型表）、`v3-prior.json`（sigma 曲线）、`v3-report.json`（指标/分桶）。

本次实际耗时（本机 7 核）：sweep 499 s、final+export 102 s、prior 505 s。

## 9. 已知问题与未验证项

1. **分位交叉**：三个分位独立训练，会少量交叉（500 行样本里 p10>p50 有 1 行、p50>p90 有 6 行，最大幅度 158 s）。产品侧务必先 `sort([p10,p50,p90])` 再显示，并把 lo/hi 夹到 `lo ≤ p50 ≤ hi`。
2. **区间宽度大**：90% 区间中位宽度 680 s，因为乘性归一化随预测值放大。若要更窄的区间，需改用 CQR（`max(q10−y, y−q90)` 分数）或对长任务单独建模。
3. **bias 仍为 −84.6 s**（系统性低估），比 v2 的 −120.7 s 好但没有消除。若要无偏，可在 calib 上用 `q500 = −0.0037` 做乘性去偏（几乎为 0，说明中位残差已对齐，剩余 bias 来自长尾不对称，属分位损失的正常性质）。若产品指标是 MAE，不要额外去偏。
4. **未验证**：
   - 未在真实运行时特征上验证——`data/samples.csv` 的特征由 `tools/dump-samples.mjs` 产出，生产侧特征拼装是否逐位一致（尤其 `step_ms_ema`、`prev_turn_steps_med` 的窗口定义、缺失值填充）需要实测比对；训练数据无 NaN，模型也没有处理缺失值的逻辑，**JS 侧遇 undefined 必须显式填 0**（或与 Python 相同的填充值），否则 `undefined <= threshold` 恒为 false，会静默走右支。
   - 未做按 session 的交叉验证方差估计，「dev 85,747 行」上的 146 s 与 test 上的 173 s 差距较大（dev 只覆盖 10% session，抽样偏差），选型结论对 ±3% 的 MAE 差异不敏感，但对 frontier 上的细小差别（如 15×250 vs 31×120 的 5%）建议在更多 session 上复核。
   - JS 求值耗时（14.1 / 40.5 µs）是 Node 22 单线程的微基准，未验证在浏览器/Electron 渲染进程的实测开销和内存占用（343.9 KB JSON 解析约 1 万节点/模型）。
   - 未做 `prompt_*` 类特征的漂移检查，也未验证新模型在「首轮 turn_index=1」（无历史）等边界上的行为。
5. 本次按要求只写了：`tools/analysis/fit_v3.py`、`tools/analysis/verify_export.mjs`、`data/eta-v3-model.json`、`data/v3-pred-sample.csv`、本文件。未改 `lib/`、`tools/*.mjs`、`tools/analysis/eta_study.py`，未 commit。
