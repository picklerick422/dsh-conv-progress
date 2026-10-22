# 对话实时进度 + ETA 调研（dsh-conv-progress）

> 目标：为 DSH 插件 **dsh-conv-progress**（对当前进行中的对话做实时进度分析：预估进度条 + 预估剩余时间）提供调研素材。
> 环境：DeepSeek Harness v0.2.1-rc.2 / Node 22 / Cordis 插件框架。
> 调研时间：2026-10-22。取证方式：GitHub API + raw 源码（`curl` 200 实测）、arXiv ACM/NIST/METR 正文（经 Firecrawl 桥读取）、本地已装插件源码（`~/.dsh/profiles/web/node_modules/`）。逐条状态见同目录 `links.tsv`。
> 事实与推断分开标注：**实现方式**为读到的一手事实；**【推断】**标记为本调研的分析结论。

---

## 0. 结论速览（给赶时间的人）

1. **没有任何现成库直接解决"步数未知的对话 ETA"**。最接近的是 indicatif 的 `Estimator`（双重指数平滑 + 停滞检测）与 Weibull 任务完成时间分析（Rummel 2017，144 任务中 98.6% 可用 3 参数 Weibull 拟合）。
2. **正确姿势不是"估算剩余步数"，而是"估算完成概率"**：把进度条画成 P(本轮已完成 | 已用步数、已用时长、token 增长)，ETA 取 P50/P80 分位。理由：对话步数本质不可知，而历史会话提供了大量"完成时刻"样本，且未完成会话天然是右删失样本（生存分析的标准输入）。
3. **数据源在 DSH 内部已齐备**：`step/start`/`step/end`/`assistant/attempt`/`assistant/message(usage)` 事件，加上 dsh-context 已算好的 `timing {ttftMs, genMs, speedMs, speedTokens, toolsMs}`。不需要新埋点。
4. **UI 上必须允许"不显示 ETA"**：OpenAI Codex CLI（130k★）的 SOTA 编码代理只显示 `Working (2m 14s)` + 中断提示，**没有 ETA**；arXiv 2609.08589 也证明 LLM 自报进度在任务中段不可靠。→ ETA 应是可选增强，退化路径是一等公民。
5. 推荐算法栈：**双时钟（步级 EMA + token 级 TPOT 外推） + 回看对称估计（中期） + Weibull/生存分位（宏观进度条） + 渲染层节流**。

---

## 1. CLI 进度条与 ETA 算法

> 这一类解决的是"total 已知、速率抖动"的经典问题；对话是"total 未知、步频抖动"，但平滑与展示技巧可整体平移。

### 1.1 tqdm（31,358★）

- **URL**：https://github.com/tqdm/tqdm ｜ 源码 https://raw.githubusercontent.com/tqdm/tqdm/master/tqdm/std.py
- **核心思路**：内置 EMA 平滑速率，ETA = 剩余量 / 平滑速率；进度的"瞬时速率"永远不直接用于显示。
- **实现方式**：`tqdm/std.py` 定义 `class EMA`（约 L211），默认 `smoothing=0.3`，`__call__` 里用指数加权更新；`tqdm.__init__` 中创建两组独立 EMA —— `self._ema_dn = EMA(smoothing)`、`self._ema_dt = EMA(smoothing)`、以及 `_ema_miniters`（约 L1076-1078）；`rate()` = `_ema_dn() / _ema_dt()`；剩余时间 `remaining = (total - n) / rate if rate and total else 0`（约 L573）。`total=None` 时完全不显示百分比与 ETA，只显示 n、速率、已用时间。
- **可借鉴点**：① 对"分子（完成量）"和"分母（时间）"分别做 EMA 再相除，比对 ETA 本身做平滑更稳；② `total=None` 的退化分支正是"步数未知对话"的默认形态 —— **保留一条"无 total 也好看的渲染路径"**。

### 1.2 rich（57,597★）

- **URL**：https://github.com/Textualize/rich ｜ 源码 https://raw.githubusercontent.com/Textualize/rich/master/rich/progress.py
- **核心思路**：滑动时间窗口估速率 + 渲染层节流，两件事解耦。
- **实现方式**：`Task.speed`（约 L1023）用样本窗口：保留 `speed_estimate_period: float = 30.0` 秒内的样本（L1083），计算时 `old_sample_time = current_time - self.speed_estimate_period` 裁掉旧样本（约 L1459-1460、L1530）；`Task.time_remaining = ceil(remaining / speed)`；`TimeRemainingColumn`（约 L772）带 `max_refresh = 0.5`，注释原文 "Only refresh twice a second to prevent jitter"。
- **可借鉴点**：**ETA 抖动的一半来自渲染频率**。对话插件应把"估计器频率"（每 step 更新）与"渲染节流"（0.5–1s 最多一次，且值变化超阈值才重绘）分开。

### 1.3 indicatif（5,223★）— 最贴近本场景的实现

- **URL**：https://github.com/console-rs/indicatif ｜ 源码 https://raw.githubusercontent.com/console-rs/indicatif/main/src/state.rs
- **核心思路**：对"步/秒"做**双重**指数平滑，并在最后一次观测后把"已过时间"当作 0 步的伪观测，防止停顿导致 ETA 冻结。
- **实现方式**：`ProgressState::eta()`（约 L291）= `(len - pos) / steps_per_second`；`struct Estimator`：`estimator_weight(age) = 0.1^(age / 15.0)`（约 L665-668，即 15s 时旧值权重 0.1，等价半衰期约 4.5s）；`record()` 取 `weight = estimator_weight(delta_t)`，`smoothed = smoothed*weight + new*(1-weight)`；启动时用 `normalization = 1 - estimator_weight(delta_t_start)` 校正；再对平滑序列做第二层 `double_smoothed = double*weight + smoothed*(1-weight)`；`steps_per_second()` 里把"距上次记录的时间"当作一次 0 增量的观测。
- **可借鉴点**：① **时间加权而非样本加权** —— 对话 step 间隔不均（思考 3s vs 工具 30s），必须按 `Δt` 折算权重；② **伪观测**：工具执行中长时间无 step 完成时，ETA 会自动拉长，而不是停在原地；③ 双重平滑的**双层输出**：一层速率、一层"ETA 变化趋势"，正好对应"当前速度"与"预计总时长"两个 UI 数字。

### 1.4 cli-progress（1,259★）

- **URL**：https://github.com/npkgz/cli-progress ｜ 源码 https://raw.githubusercontent.com/npkgz/cli-progress/master/lib/eta.js
- **核心思路**：固定长度环形缓冲区估速，并把"估不出来"显式编码。
- **实现方式**：`etaBufferLength = 100`；维护 `valueBuffer`/`timeBuffer` 两个环形数组，每次 `update()` push，用首尾差 `v_diff / t_diff` 得速率，`eta = ceil(remaining / vt_rate / 1000)`；异常分支显式返回 `'NULL'`（NaN）、`'INF'`（非有限或 >1e7 秒）。
- **可借鉴点**：**`NULL`/`INF` 是产品级设计而非边角料** —— 对话插件应有三种显示态：数字 ETA / "估算中…" / "无法估算（步数未知）"，而不是硬凑一个会打脸的数字。

### 1.5 node-progress（2,989★）— 反例基线

- **URL**：https://github.com/visionmedia/node-progress ｜ 源码 https://raw.githubusercontent.com/visionmedia/node-progress/master/lib/node-progress.js
- **核心思路**：最朴素的线性外推。
- **实现方式**：L137 `var eta = (percent == 100) ? 0 : elapsed * (this.total / this.curr - 1);`，速率 `rate = curr / (elapsed / 1000)`；无任何平滑。
- **可借鉴点**：单点外推在早期与进度突变时抖动极大（正是 SO 933242 里被吐槽的"20 秒 / 4 天 / 20 分钟"闪烁）。但它的两个边界值得抄：**完成即 ETA=0**、**无速率即不显示**。可作零依赖兜底实现。

### 1.6 python-progressbar（879★）

- **URL**：https://github.com/WoLpH/python-progressbar ｜ 源码 https://raw.githubusercontent.com/WoLpH/python-progressbar/develop/progressbar/widgets.py
- **核心思路**：把"估计器"与"展示器"拆成多个 widget，提供窗口均值 / EMA / 绝对时刻三种 ETA。
- **实现方式**：`class SamplesMixin`（L549）维护样本窗口，`samples` 可为计数或 `timedelta`（默认 `timedelta(seconds=2)`，L582），`L637-675` 追加样本并按窗口裁剪；`class ETA(Timer)`（L689）输出剩余时长；`class AbsoluteETA(ETA)`（L823）输出"预计完成时刻"；`class AdaptiveETA(ETA, SamplesMixin)`（约 L860）"基于最近 10 次更新的采样均值"，适合中途恢复的进度；`class SmoothingETA(ETA)`（L922）为 EMA 版本。
- **可借鉴点**：① **`AbsoluteETA`：显示"预计 14:32 完成"比"还剩 3 分 20 秒"更抗抖动**（时间锚点不随刷新跳动，只随时间推移平移）；② 估计器可**按阶段切换**：冷启动用窗口均值（对异常值鲁棒），稳定后用 EMA（响应快）。

---

## 2. ETA / 时长预估算法与论文

### 2.1 Stack Overflow #933242 — "Smart progress bar ETA computation"（17k 浏览，11 答案）

- **URL**：https://stackoverflow.com/questions/933242/smart-progress-bar-eta-computation
- **核心思路**：这是该问题的"总纲"：三种流派（平均速率 / 最近速率 / 双平滑）+ 一个关键升级 —— 输出**分布**而不是单点。
- **实现方式**：
  - **高票答案（Monte Carlo / bootstrap）**：把任务当 N 个独立微任务；已完成的微步时间做有放回抽样，重复模拟得到剩余时间分布，直接汇报"90% 概率还需 3–15 小时"。闭式近似：`scaling = (totalSteps - elapsedSteps) / elapsedSteps`，`sigma = sqrt(Σt² - (Σt)²/N)`，`lower = Σt·scaling - 3σ√scaling`，`upper` 同理。
  - **SPWorley（20 票，回答者本人）**：前 50% 用"平均速率外推"（稳定、不抖）；**超过 50% 切换为回看法**：剩余比例 r = 1-p，在历史进度曲线里用二分查找 + 线性插值找到"上次处于进度 p-r 的时刻"，当前时刻与该时刻之差即 ETA。末端只用最新的数据，天然自适应。
  - **Firefox 实现（被引为最佳实践）**：速度按 90% 旧值 + 10% 新值平滑，再对**ETA 本身**做二次平滑；Chrome 会乱跳；pySmartDL 取最近 30 次 ETA 的均值；Transmission 对最近 5 次读数平滑。
  - 另有答案给 EMA：`α=0.1`；采样间隔不均时用 `α = exp(-λΔt)`。
- **可借鉴点**：① **回看法是"步数未知"场景的最优通用解**：不需要知道总步数，只需 `(t_i, 进度_i)` 序列 —— 剩余工作量 ≈ 最近完成同等工作量所花时间；② **bootstrap 区间**可直接做 UI 的"~5 分钟（3–9 分钟）"；③ 双平滑（先平滑速率、再平滑 ETA）是 Firefox 级产品的做法。

### 2.2 NIST/SEMATECH 单指数平滑（权威公式与参数）

- **URL**：https://www.itl.nist.gov/div898/handbook/pmc/section4/pmc431.htm
- **核心思路**：`S_t = α·y_t + (1-α)·S_{t-1}`，0<α<1；α 越小越平滑、滞后越大。
- **实现方式**：NIST 工程统计手册 PMC 4.3.1 节给出递推式、初始值与 α 选择建议；同章延伸 Holt 线性趋势、Holt-Winters 季节性。
- **可借鉴点**：给"步耗时序列"提供参数依据；**采样间隔不均时要做时间归一化**：`α_t = 1 - (1-α)^{Δt/Δt0}`（tqdm/indicatif 的实际做法）。对话里 step 间隔从 2s 到 120s 不等，这一步不可省。

### 2.3 Kalman 滤波（Wikipedia + rlabbe 开源教材 19,438★）

- **URL**：https://en.wikipedia.org/wiki/Kalman_filter ｜ https://github.com/rlabbe/Kalman-and-Bayesian-Filters-in-Python
- **核心思路**：带不确定度的递推估计：`predict(状态 + 协方差)` → 用新观测按噪声方差加权 `update`。ETA = 状态向量的一个分量，**同时得到方差**。
- **实现方式**：rlabbe 教材提供从一维到 EKF/UKF/粒子滤波的 Jupyter Notebook 与统一 API（`KalmanFilter.predict()` / `.update()` / `.log_likelihood`）；一维匀速模型只需 F、Q、H、R 四个标量即可实现"速率+剩余量"的联合估计。
- **可借鉴点**：① **输出 ETA 的同时输出方差** —— UI 的"±/区间"与"模糊程度"有了理论依据；② 工具执行/思考停顿时**协方差自然增大**，ETA 自动变模糊，比手写"抖动阈值"优雅；③ 成本偏高，建议列为 V2 候选而非首发。

### 2.4 Weibull 任务完成时间分析（Rummel 2017, Journal of Usability Studies 12(2)）— 最贴合的数学框架

- **URL**：https://dl.acm.org/doi/abs/10.5555/3122114.3122116
- **核心思路**：任务完成时间服从 3 参数 Weibull；拟合后，**给定时间可反推完成率，给定完成率可反推时间**。
- **实现方式**：3 参数 Weibull（位置 γ、形状 β、尺度 η），`F(t) = 1 - exp(-((t-γ)/η)^β)`；论文实测 144 个可用性任务中 **98.6% 可拟合 3 参数 Weibull**（仅 2 个离群点被剔除）；完成率 >0.60 时，总体中位时间 ≈ 成功完成时间的几何均值 / 完成率；作者强调"中位时间应理解为任务完成过程的**半衰期**，不是均值"；模型天然支持"部分被试未完成任务"。
- **可借鉴点**：**进度条 = F(t)，ETA = 分位数反解**。对对话：用历史会话的"已用步数/已用时长"拟合 β、η（可按任务类型分桶），在线只需算 `F(t)` 与 `t_{P50}`；β 还能解释任务性质（β>1 表示"越到后面越快完成"，β<1 表示"长尾卡住"）。这是本调研推荐的主算法。

### 2.5 RULSurv：删失感知的剩余寿命预测（arXiv 2405.01614）

- **URL**：https://arxiv.org/abs/2405.01614
- **核心思路**：生存分析天然处理"事件尚未发生"的删失数据；用 KL 散度做早期检测 + 生存模型估剩余寿命。
- **实现方式**：轴承 RUL 预测；对比线性 CoxPH 与非线性 Random Survival Forest；XJTU-SY 数据集 5 折交叉；25% 随机删失下 MAE 14.7 分钟（CoxPH）/ 12.6 分钟（RSF），而**不支持删失的 LASSO 基线为 18.5 分钟**；平均累计相对精度 CRA 0.7586。
- **可借鉴点**：**忽略删失会系统性偏差**。若只用"已完成的会话"训练 ETA，会漏掉"拖很久才结束"的长尾样本（幸存者偏差 → ETA 偏乐观）。校准数据集必须把"当前未结束"的会话按右删失纳入。

### 2.6 TARE：HPC 作业时长预测的尾部感知评估（arXiv 2607.04935）

- **URL**：https://arxiv.org/abs/2607.04935
- **核心思路**：时长预测的评估必须看**尾部**（少数长作业支配资源），平均值会掩盖差异。
- **实现方式**：提出 GeoAccuracy（按资源用量加权的几何精度）+ 十分位分析 + 滚动切分；对比 XGBoost、Last2 与用户提交时的 walltime 估计（UserReq）；用 NREL Eagle、ALCF Mira/Intrepid 生产 trace。结论：总体均值下各法接近，**尾部分析才分出高下**；top decile 上人类估计（UserReq）GeoAccuracy 最高、低估率最低；据此做混合调度（多数作业 XGBoost，top decile 按 proxy_cost 路由给用户估计），在线回放平均等待降 8%、回填数增 50%–115%。
- **可借鉴点**：① **评估指标用"尾部低估率"**：对用户而言"说 2 分钟、实际 20 分钟"的伤害远大于"说 20 分钟、实际 5 分钟"；② **人类/用户先验在长尾任务上强于纯 ML** —— 对话插件可把用户首条消息的长度、是否含"重构/全部/迁移"等词作为粗粒度先验；③ 离线评估 + 在线回放的验证方法可直接搬来做插件上线前的基线。

### 2.7 Bayesian 分层建模（Wikipedia + Springer 2024 综述）

- **URL**：https://en.wikipedia.org/wiki/Bayesian_hierarchical_modeling ｜ https://link.springer.com/article/10.3758/s13428-023-02204-3
- **核心思路**：参数本身有分布，跨组共享先验（部分汇聚 / shrinkage）：小样本组自动向总体均值收缩，样本变多后由数据主导。
- **实现方式**：分层先验 `p(θ_j | φ)` + 超参数 `φ`；Springer 综述（*Behavior Research Methods*, 2024, "Bayesian hierarchical modeling: an introduction and reassessment"）系统介绍建模与再评估。
- **可借鉴点**：**冷启动的正道**。新会话没有历史 → 用全局先验（按会话类型/首条消息长度分桶）给出初始进度与不确定度；随 step 累积，后验逐步接管。这正好解释并解决"前 30 秒 ETA 乱跳"。

### 2.8 METR task-completion time horizons（metr.org + arXiv 2503.14499）

- **URL**：https://metr.org/time-horizons/ ｜ 论文 https://arxiv.org/abs/2503.14499
- **核心思路**：用 logistic 回归拟合"AI 成功概率 vs 人类任务时长"，取 50%/80% 交点作为 agent 的能力视界。
- **实现方式**：对每个 agent 拟合 `P(success) = σ(a + b·log(人类任务时长))`；页面为 Time Horizon 1.1（2026-02-06 上线，2026-09-08 起停止主动更新）；数据来自 RE-Bench / HCAST 等百餘个软件任务，6 次独立运行；明确标注 **>16 小时测量不可靠**；指出 AI 在成功完成的任务上通常比人类快数倍，但方差极大。
- **可借鉴点**：对话"完成概率"的曲线形状可直接借用 `logistic-in-log-time`；且 METR 明确"任务时长分布是重尾、单点估计不可靠"，与 TARE 结论同构 —— **UI 给区间、不给承诺**。

---

## 3. LLM / Agent 场景

### 3.1 vLLM 推理指标（TTFT / ITL / TPOT）

- **URL**：https://docs.vllm.ai/en/stable/design/metrics/ （实测 429，用 raw 镜像 https://raw.githubusercontent.com/vllm-project/vllm/main/docs/design/metrics.md）
- **核心思路**：把一次推理拆成 prefill 与 decode 两段，分别用 TTFT 与 TPOT 刻画。
- **实现方式**：`vllm:time_to_first_token_seconds`（Histogram，TTFT）；`vllm:inter_token_latency_seconds`（相邻流式输出间隔，每个流式事件记一次）；`vllm:request_time_per_output_token_seconds` = `(端到端延迟 - TTFT) / (输出 token 数 - 1)`，每完成一个请求记一次（≤1 token 的请求记 0）；另有 `vllm:num_requests_running/_waiting/_swapped`、`vllm:generation_tokens_total`、`vllm:request_success_total{finished_reason}`、`vllm:request_generation_tokens`（生成长度分布）。
- **可借鉴点**：**流式阶段的 ETA 公式**：`剩余时间 ≈ (预估输出 token - 已出 token) × TPOT`。剩余 token 未知时，用历史步的**生成长度分布**（`request_generation_tokens` 的 P50/P90）作先验；TPOT 用 EMA 跟踪。长上下文时 prefill 变慢，TPOT 不应混入 TTFT。

### 3.2 OpenTelemetry GenAI 语义约定（三层计时模型）

- **URL**：https://github.com/open-telemetry/semantic-conventions-genai （原 opentelemetry.io 文档已迁移；指标定义见 https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-metrics.md）
- **核心思路**：为 GenAI 定义跨厂商的 span/metric，覆盖 operation、request、token、agent、tool 五个层级。
- **实现方式**（指标原文）：`gen_ai.client.operation.duration`（Histogram，s）；`gen_ai.server.request.duration`；`gen_ai.server.time_to_first_token`（Histogram，s，"Time to generate first token for successful responses"）；`gen_ai.server.time_per_output_token`（"Time per output token generated after the first token for successful responses"）；`gen_ai.invoke_agent.duration`、`gen_ai.invoke_agent.inference_calls`、`gen_ai.invoke_agent.tool_calls`、`gen_ai.execute_tool.duration`。
- **可借鉴点**：**分解式 ETA**：总剩余 ≈ Σ(剩余 step × step 时长)，而 `step 时长 = TTFT + 输出 token × TPOT + 工具时长`。OTel 的 agent/inference/tool 三层正好对应插件要展示的"整体 / 当前步 / 工具等待"三种粒度。

### 3.3 ollama 生成计时（prefill 与 decode 分离）

- **URL**：https://raw.githubusercontent.com/ollama/ollama/main/api/types.go
- **核心思路**：一次生成返回完整分项计时，客户端可自行算 token/s。
- **实现方式**：`GenerateResponse` 字段 `TotalDuration`、`PromptEvalCount`、`PromptEvalCachedCount`（指针，可缺省）、`PromptEvalDuration`、`EvalCount`、`EvalDuration`、`DoneReason`（L544-569）；官方文档口径 `tokens/s = eval_count / eval_duration × 1e9`。
- **可借鉴点**：**必须把 prompt 阶段与生成阶段分开估**：prefill 速率与 decode 速率可差 1–2 个数量级，且 prefill 随上下文长度增长 —— 对话越到后面"每步的首 token 等待"越长。dsh-context 的 `ttftMs` / `genMs` 正是这两个量。

### 3.4 llama.cpp server timings

- **URL**：https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md ｜ 仓库 https://github.com/ggml-org/llama.cpp（131,998★）
- **核心思路**：每次响应可带 `timings` 对象，暴露 prompt/predicted 的 n、ms、per_second。
- **实现方式**：请求参数 `timings_per_token`（默认 false，"Include prompt processing and text generation speed information in each response"，L602）；响应 `timings` 含 `prompt_n`、`prompt_ms`、`prompt_per_second`、`predicted_n`、`predicted_ms`、`predicted_per_second`、`cache_n`（L1488-1492）；总上下文 token 数 = `prompt_n + cache_n + predicted_n`（L1499）；Prometheus 计数器 `llamacpp:tokens_predicted_total` / `llamacpp:tokens_predicted_seconds_total`（L1188-1189）。
- **可借鉴点**：`cache_n`（KV cache 命中数）提醒：**要区分"新 token"与"缓存命中 token"**，否则长会话的 prefill 时间会被高估数倍。DSH 的 `cacheRead` token 桶同理 —— 输入成本/时间应按缓存命中折算。

### 3.5 OpenAI Codex CLI 状态行（重要反向证据）

- **URL**：https://github.com/openai/codex（130,410★）｜ 源码 https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/status_indicator_widget.rs
- **核心思路**：**只显示"Working + 已用时间 + 中断提示"，不显示 ETA**。
- **实现方式**：`status_indicator_widget.rs`（588 行）：`header_started_at: Instant`（L58，字段注释 "Animated header text (defaults to \"Working\")" L56）；`fmt_elapsed_compact(elapsed_secs)`（L76-88）把秒压成 `12s` / `3m 05s` / `1h 02m`；渲染时拼 `({pretty_elapsed} • …)` 或 `({pretty_elapsed})`（L260-264），后面接可选的中断/时长提示。
- **可借鉴点**：**SOTA 编码代理宁可给"已用时"也不给 ETA**（步数完全不可知、且用户对错误 ETA 的容忍度低于对"没有 ETA"的容忍度）。→ 本插件的 ETA 必须是**可选增强**，默认态展示"已用 12m · 12 步 · 当前动作"；`progress` 不确定时用不确定态进度条，而不是假百分比。

### 3.6 The Unreliable Progress Bar（arXiv 2609.08589, 2026-09）

- **URL**：https://arxiv.org/abs/2609.08589
- **核心思路**：系统评估"LLM 在任务执行全程自报进度"的可靠性 —— 结论是**不可靠，且失败点随阶段漂移**。
- **实现方式**：在 τ2-bench 与自建 StageIF（把报告检查点铺满任务生命周期）两个 testbed 上评测；发现：几乎每个部署模型都是"某些阶段可靠、某些阶段不可靠"；多数模型**开工后准确率下降、任务完成后恢复**；最新一代模型消除了中段下降，但在终点前变得过度保守（grows conservative at the finish line）；作者结论：**agent 框架不应仅凭模型的状态自报来控制任务流程**。
- **可借鉴点**：**进度源必须是可观测信号，不是模型自报 %**。可观测信号=step 数、token 数、工具调用、文件写入量；模型自报只作为低权重先验参与融合。这条直接决定 dsh-conv-progress 的架构：只做"被动观测 + 统计估计"，不做"让模型报进度"。

---

## 4. DSH 生态既有插件

> 均为本机已装包（`~/.dsh/profiles/web/node_modules/`），版本号来自 package.json。

### 4.1 dsh-job-progress v1.0.5（Rice00）

- **URL**：https://github.com/Rice00/dsh-job-progress ｜ 生产者源码 https://raw.githubusercontent.com/Rice00/dsh-job-progress/main/lib/dsh-progress.mjs ｜ 客户端 https://raw.githubusercontent.com/Rice00/dsh-job-progress/main/lib/client.js
- **核心思路**：给 agent 的"长任务"提供可上报的进度面板：生产者写 JSON 快照，客户端读快照渲染。
- **实现方式**：
  - 存储：`<DSH_HOME>/job-progress/<DSH_SESSION_ID>/<key>.json`（`DSH_HOME` 默认 `~/.dsh`，L13-14、L55），原子写（tmp + rename）。
  - 记录字段（L23-24 注释）：`{label, key, unit: 'bytes'|'count', total, done, speed, eta, phase, status, note, jobId, startedAt, updatedAt}`。
  - 速率：`record.speed = Math.max(0, (Number(done) - lastBytes) / dt)`，`dt` 至少 0.4s（L143）。
  - **ETA**：`record.eta = record.total > 0 && record.speed > 0 ? Math.round((record.total - record.done) / record.speed) : null`（L152）；注释记录了一个真实 bug 及其修复（2026-10-08 之前先算 ETA 再赋 extra，导致 CLI `--speed` 时 ETA 永为 null）。
  - 心跳：`HEARTBEAT_MS = 5000`（L50），用于区分"慢"与"死"；`finish()` 时 `record.eta = null`（L168）。
  - 客户端：`percent()` 计算百分比、`formatDuration` 格式化、每任务一行（状态点 / 名称 / 进度条 / 百分比 / 已完成 / 总量 / 速度 / 剩余时间 / 已用时间）；任务列表来自 job registry，**未上报的任务也显示（只是没有进度条）→ 不谎报**。
- **可借鉴点**：① **"数据契约 + 心跳 + 原子写"三件套**可直接复用：进度快照要可被外部读取、能判断新鲜度；② **ETA 仅在 `total` 与 `speed` 都已知时给，否则 `null`** —— 这与"步数未知的对话"完全同构，是现成的降级范式；③ "未上报任务也显示但无进度条"的诚实 UX 值得照抄。

### 4.2 dsh-cost-meter v1.9.26（han-1413141，494★）

- **URL**：https://github.com/han-1413141/dsh-cost-meter ｜ 中文 README https://raw.githubusercontent.com/han-1413141/dsh-cost-meter/master/README.zh-CN.md
- **核心思路**：按会话统计成本与预算进度条，含多段"额度/用量%"进度条、峰谷计价、逐调用 ledger。
- **实现方式**：
  - Token Plan 的"每 1% 额度 / 满窗 token"估算：**以连续可信段的首尾差分推算**以压低量化误差；跨度不足 5 个百分点时标注「读数精度受限」；样本超 7 天回退当前用量折算；窗口边界按小时对齐（README.zh-CN.md L559，原文）。
  - 计划 / API 双轨计费、峰谷价、逐次调用 ledger、≥80% / ≥100% 配额告警（README L68 附近还包含订阅额度来源适配）。
- **可借鉴点**：① **用"差分/斜率"推断不可直接观测的量，并对低置信度显式标注** —— 对话完成比例同样不可直接观测，可用"上下文增速 / 步频 / 已用时长"的差分推断，并在低置信时给"≈"或区间；② "预算式进度条"的 UX（已用/总量/剩余/告警阈值）几乎可直接搬来做"时间预算"。

### 4.3 dsh-context v0.74.0（bowenliang123，3,319★）

- **URL**：https://github.com/bowenliang123/dsh-context ｜ README https://raw.githubusercontent.com/bowenliang123/dsh-context/main/README.md
- **核心思路**：上下文/时序仪表盘：逐模型请求记录 timing 与 token，并用 **Context Trend** 卡片"一请求一柱"地画堆叠构成 + 可选时长曲线。
- **实现方式**（README 与本地 `lib/index.js` 求证）：
  - 会话投影暴露 `timing` 对象：`{wallMs, ttftMs, genMs, calls, toolsMs, toolCalls, tools: {name: {calls, ms}}, speedMs, speedTokens}`（字段在本地包中确认存在）。
  - 维护 spans（`ttft` / `reasoning` / `text` / `toolarg` / `tools` / `other`，各带 start/end）。
  - 从 session 事件流取 `step/start`、`step/end`（activeMs = wallMs 扣除等待/审批）、`assistant/attempt`（首 token 时刻）、`assistant/message`（usage：input / cacheRead / cacheWrite / output → 峰谷成本 ledger）。
  - `requests[]` 带 turn/step/time/total/prompt/activeMs；统计 turns / steps / injects / compactions / prunes / skills。
  - Context Trend：Step/Turn 粒度、Total/Delta 模式、Overview 压缩带、四分位标记；Settings 中有 `trend duration curve`（默认显示，README L193）。
- **可借鉴点**：**ETA 所需的一手数据它已经全有**：`step` 边界（步数/步频）、`ttftMs/genMs`（prefill/decode 拆分）、`speedMs/speedTokens`（现成输出速率）、`tools` 分项（工具耗时估计）、逐请求时间序列（平滑/回看法的样本源）。实现上建议直接消费 `@deepseek-ai/dsh-session-projection` 的投影而非自己解析事件日志。（注意：发布包 `lib/index.js` 是打包产物，读源码请看仓库 `src/`。）

### 4.4 dsh-session-stats v0.2.1（pangzi-club/dsh-custom-plugins 的 dsh-stats 目录；npm 最新 0.2.0）

- **URL**：https://github.com/pangzi-club/dsh-custom-plugins ｜ 插件 README https://raw.githubusercontent.com/pangzi-club/dsh-custom-plugins/main/dsh-stats/README.md ｜ npm https://registry.npmjs.org/dsh-session-stats
- **核心思路**：输入框统计行下方挂"会话用量"胶囊，点击展开面板，按模型分组的 4 个 token 桶 + 计费样本数。
- **实现方式**（README"原理"节）：
  - 宿主半边 `src/index.ts` + `src/host/`（TS 源码，`node build.mjs` → `lib/`），`inject: ['webServer', 'connection', 'sessionQuery', 'tools']`。
  - `webServer` exact 路由 `GET /dsh-stats/ping`（JSON 心跳，验证挂载与路由存活）。
  - `connection.fetch` 已鉴权路由 `GET /api/dsh-stats/summary?session=<id>`：`sessionQuery.readSession` 读会话事件日志 → `summarizeUsage` 把逐条 `assistant/message` 样本按 `message.source` 的模型路由折叠成四桶（未缓存输入 / 缓存命中 / 缓存写入 / 输出），并按样本时间戳划分高峰/空闲档 → `src/host/pricing.ts` 逐档计价（缓存写入按未缓存输入计费）。
  - 缓存策略：结果按会话缓存，`session/event`（`assistant/message`）落盘后标脏，下次请求重算。
  - 客户端 `src/client/index.tsx` → `lib/client.js`：向 `conversation.composer.dock` 席位注入条目（id `dsh-stats`）；`tokenUsage` 投影非零才渲染；取数防抖、面板定位与点外关闭复用 `@deepseek-ai/dsh-client-ui-primitives`；zh/en 词表。
  - 配置：`{label, timestamp, timeZone, pricing}`，非法配置加载即抛错（fail loudly）。
- **可借鉴点**：**这就是 dsh-conv-progress 的最佳骨架**：同一个 `sessionQuery.readSession` 数据源 + 已鉴权 GET 路由 + composer dock 胶囊/面板 + "事件落盘标脏、下次重算"缓存。差别只是把 `summarizeUsage` 换成"时序 ETA 估计器模块"。其"投影非零才渲染"的技巧可直接用于"进度未知时隐藏面板"。

---

## 5. 横向对比（选型表）

| 算法 | 需要的数据 | 抖动 | 冷启动 | 步数未知 | 对话场景评价 |
| --- | --- | --- | --- | --- | --- |
| 线性外推（node-progress） | total + 已完成 | 高 | 差 | ✗ | 仅作兜底 |
| EMA（tqdm / NIST） | 时间序列 | 低（α 小） / 中（α 大） | 一般 | 部分（速率可显示） | 步耗时/TPOT 的基础估计器 |
| 滑动窗口（rich / python-progressbar） | 最近 N 秒样本 | 中 | 好 | 部分 | 冷启动阶段更稳 |
| 双重平滑 + 伪观测（indicatif） | 时间序列 + 时间戳 | 低 | 中 | 部分 | **步级宏观 ETA 首选**（原生支持步数/秒） |
| 回看对称（SO 答案 2） | `(t, 进度)` 序列 | 低 | 差（需 50% 后） | ✓（只需进度本身） | **中期主算法**，与平滑互补 |
| bootstrap 区间（SO 答案 1） | 已完成微步耗时 | — | 差 | 部分 | 给 P50/P80 区间 |
| Kalman | 状态+噪声模型 | 极低 | 中 | 可建模 | V2；输出方差 |
| Weibull / 生存分析（Rummel 2017、RULSurv） | 历史会话完成样本（含删失） | 低 | **需先验** | ✓ | **宏观进度条 + 分位 ETA 首选** |
| 贝叶斯分层 | 分桶历史 + 当前观测 | 低 | **最佳** | ✓ | 冷启动/多任务类型 |
| logistic log-time（METR） | 任务难度先验 | 低 | 好 | ✓ | 先验形状参考 |

---

## 6. 对 dsh-conv-progress 的直接启示（8 条，可复用算法级）

1. **双时钟 ETA**：宏观时钟（整轮）= 剩余步数 × 步耗时 EMA（indicatif 双重平滑 + 时间归一化权重 `0.1^(Δt/15s)`）；微观时钟（当前步内流式）= 剩余 token × TPOT 外推（vLLM 公式），剩余 token 用历史生成长度 P50/P90 当前验。两个数字分别对应"整轮还剩 ≈X 分钟"与"本条回复还需 ≈Y 秒"。
2. **进度条画"完成概率"而非"剩余步数"**：用历史会话拟合 Weibull（3 参数，Rummel 2017 证明 98.6% 任务可拟合），进度 = `F(已用步数/已用时长 | β,η)`；ETA 取 `t_{P50}` 与 `t_{P80}` 分位。β>1 表示"越接近完成越快"（常见于收敛的编码任务），β<1 表示"卡在长尾"。
3. **中期改用"回看对称"**：剩余工作量 ≈ 最近完成"同等比例工作量"所花时间；只需保存 `(时间戳, 进度)` 序列，二分查找 + 线性插值（SO 答案 2），末端最准、且完全不依赖"总步数"。
4. **平滑做两层、刷新做节流**：先平滑速率、再平滑 ETA（Firefox 双平滑）；UI 渲染最多 0.5–1s 一次（rich 的 `max_refresh = 0.5`），且 ETA 变化小于阈值不重绘。**抖动的主要来源是渲染频率，不是算法**。
5. **退化路径是一等公民**：步数未知 / 前 3 步 / 工具长等待 / 高不确定时，不显示百分比与 ETA，显示"已用 12m · 12 步 · 当前：读文件"（Codex 的做法）；用 `null` / `INF` 显式编码不可估计（cli-progress），UI 显示"估算中…"，绝不硬凑数字。
6. **进度源只信可观测信号**：session 事件（`step/start`、`step/end`、`assistant/attempt` 首 token、`assistant/message` usage）优先；dsh-context 的 `timing {ttftMs, genMs, speedMs, speedTokens, toolsMs}` 次优先；模型自报进度权重最低（arXiv 2609.08589：中段不可靠，且"完成后恢复"会产生跳变）。
7. **冷启动用贝叶斯分层收缩**：全局先验（按会话类型/首条消息长度分桶）→ 新会话开局即给"模糊区间"，随 step 累积后验接管；校准数据集把"进行中会话"按右删失纳入（RULSurv：忽略删失 MAE 从 12.6→18.5 分钟）。
8. **评估用尾部指标、上线前离线回放**：主指标 = **低估率**（"说 2 分钟实际 20 分钟"的次数）与按代价加权的分位误差（TARE 的 GeoAccuracy 思路），辅以 P50 绝对误差；用历史会话做离线回放（TARE 的 online replay 方法）验证再上线。人类先验在长尾上更强 → 可用用户消息特征做粗粒度先验。

### 附：建议的最小数据契约（避免后续返工）

估算器输出统一为：

```ts
type ConvEta = {
  progress: number | null;      // 0..1；null = 不确定（渲染为不确定态进度条）
  etaMs: number | null;         // 点估计
  etaP50Ms: number | null;      // 分位（可选，来自 Weibull/回看分布）
  etaP80Ms: number | null;
  confidence: 'low' | 'medium' | 'high';
  basis: 'prior' | 'steps' | 'tokens' | 'lookback'; // 当前主导信号，便于调试与 UI 文案
  stepsDone: number;
  stepDurMs: number;            // 当前步耗时 EMA
  tpotMs: number;               // 当前输出 token 速率（EMA）
  updatedAt: number;
};
```

**展示建议**：`high` → "约 4 分钟（3–6 分钟）"；`medium` → "约 5 分钟"；`low` → "估算中 · 已用 12m · 12 步"。`basis='prior'` 时优先显示已用时间而非 ETA。

---

## 7. 取证与局限说明

- **已验证（HTTP 200 或读到正文）**：全部 45 条链接，状态见 `links.tsv`。其中 3 条需桥接取证：
  - Stack Overflow #933242：直连 `curl` 返回 403（反爬），正文经 Firecrawl 桥读取并引用。
  - ACM DL（Rummel 2017 Weibull）：直连 403，正文（含摘要、样本量、拟合比例）经 Firecrawl 桥读取。
  - docs.vllm.ai：本次实测 429（限流），指标口径引自 vLLM 仓库 raw 版 `docs/design/metrics.md`（200）。
- **本地插件事实**：dsh-job-progress / dsh-cost-meter / dsh-context / dsh-session-stats 的版本、字段与算法均从本机已装包（`node_modules`、README）读取，非上游 GitHub 当前 head；引用时已标注版本号。
- **[未验证]**：dsh-session-stats 的 npm 发布页 `npmjs.com/package/dsh-session-stats` 直连 403（Cloudflare），但其 registry API 与仓库 README 均 200，包信息可信；`dsh-stats` 构建产物 `lib/` 不入库，所以 npm tarball 才是真实分发物（本次未下载 tarball 核对）。
- **[推断]** 标记：第 6 节的算法组合（双时钟 + Weibull + 回看）是本调研的分析建议，**没有单一来源直接实现它**；Weibull 原始论文场景是"人做可用性任务"，迁移到"LLM 对话"属合理推断而非论文结论。
- 时间敏感：METR 页面自 2026-09-08 起不再主动更新；arXiv 2609.08589 为 2026-09 新论文，尚未见独立复现。
