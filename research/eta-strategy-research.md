# ETA（剩余耗时预测）策略调研

- 调研日期：2026-10-24；调研范围：剩余时间预测 / 生存分析 / 保形预测 / 分位 GBM / 软件与 agent 任务时长预测 / LLM 先验。
- 取证方式：官方文档与 GitHub 源码直读 + arXiv/期刊论文摘要 + `curl -sIL` 逐一验证链接（52 条全部 HTTP 200，状态见 `links-eta-strategy.tsv`）。
- 来源类型标注：【官方文档】【论文】【仓库源码】【未验证】（未验证项只在文字中提及，不作为表格引用链接）。
- 我们的问题：给定 turn 前缀（已完成步数 k、已用时间 elapsed、工具序列与上下文规模），预测本轮剩余时间的中位数与区间。约束：Node.js 运行时、离线拟合、在线原点预测；turn 未结束 = 右删失；步时长重尾；测试集 1600 turns / 239 sessions / 31 万采样点，当前基线 MAE 4.4m、medianAE 2.2m、MAPE 1.35。

## 0. 我们的问题与四类同构映射

| 同构领域 | 映射关系 | 可直接借的产出 |
|---|---|---|
| 业务过程剩余时间预测（process mining） | case = turn，event = step，prefix = 已完成步，目标 = remaining cycle time | 前缀特征工程、基线方法族（naive / kNN / 序列模型）、MAE + 分位评估（§4） |
| 生存分析（time-to-event） | event = turn 结束；进行中的 turn = 右删失；协变量 = k、工具、上下文 | 条件生存曲线 → 剩余时间中位数/分位；删失样本不丢弃（§2） |
| 分位回归 + 保形预测 | 重尾 + 异方差下要「中位数 + 可保证覆盖的区间」 | pinball loss 训练、split/归一化/Mondrian 保形、在线 ACI 校正（§1、§3） |
| LLM 先验/信息获取 | 缺「总工作量」→ 让模型先输出任务规模先验，再用数据校准 | 两阶段先验抽取、自报进度的可用性边界（§5） |

## 1. 保形预测 / 校准（给 ETA 区间与置信度）

| 项目 | 链接 | 核心方法（一句话） | 对我们的可借鉴点 | 不适用原因 | 来源 |
|---|---|---|---|---|---|
| MAPIE | [repo](https://github.com/scikit-learn-contrib/MAPIE) · [docs](https://mapie.readthedocs.io/en/stable/) | 模型无关预测区间：在 conformalization 数据集上估不确定性，覆盖回归/分类/时间序列；含风险控制、可交换性检验、自适应保形方法 | 用 session 作为分组做 Mondrian 校准；README 列出的「可交换性检验」能力正好用于判断我们的 turn 分布漂移时还能否用保形；风险控制思想可做「置信度达标才展示 ETA」 | Python 库；默认依赖可交换性，会话间/模型间漂移会破坏覆盖；需离线导出到 Node | 【官方文档】 |
| crepes | [repo](https://github.com/henrikbostrom/crepes) · [docs](https://crepes.readthedocs.io/en/latest/) | 保形分类器/回归器/保形预测系统（predictive systems），提供 normalized 与 Mondrian 变体；用 martingale 在线检验可交换性 | normalized 回归器用「预测难度」归一化区间宽度，正对重尾；Mondrian 按已完成步数 k 分层校准；martingale 可在线上监控覆盖是否失效 | Python；需预留校准集；在线更新逻辑要自研 | 【官方文档】 |
| Conformalized Quantile Regression (CQR) | [arXiv:1905.03222](https://arxiv.org/abs/1905.03222) | 分位回归给上下界 + 保形校准，得到有限样本覆盖保证，区间宽度随异方差自适应 | 直接替换「经验表 + 缩尾」：用 §3 的分位 GBM 输出 q10/q50/q90，再用校准集对上下界做保形修正；q50 即中位数 ETA | 需要独立校准集/可交换性；删失 turn 不能直接套用 | 【论文】 |
| Conformalized Survival Analysis | [arXiv:2103.09763](https://arxiv.org/abs/2103.09763) | 包裹任意生存模型产出校准的、协变量相关的生存时间下界；Type-I 右删失下有限样本覆盖 | 正在进行中的 turn 就是删失样本；可给「最早可能何时结束」的保证下界，与 §2 的生存模型组合 | 只给单侧下界；Type-I 删失假设偏窄（我们更接近一般右删失） | 【论文】 |
| Doubly Robust Conformalized Survival | [arXiv:2412.09729](https://arxiv.org/abs/2412.09729) | 右删失数据 + 加权保形 + 插补未观测删失时间，具渐近双稳健性 | 更贴合我们的删失模式；插补 + 加权可提升区间紧致度 | 需要插补模型，理论是渐近的 | 【论文】 |
| Conformal Survival Bands | [arXiv:2505.04568](https://arxiv.org/abs/2505.04568) | 给个体生存曲线做保形带（双侧），兼容任意生存模型，用于风险筛查 | 想要双侧 ETA 区间（不早于/不晚于）时可直接借；也可做「高风险长尾」告警 | 目标是筛选而非点估计，样本效率需自测 | 【论文】 |
| Adaptive Conformal Inference (ACI) | [arXiv:2106.00170](https://arxiv.org/abs/2106.00170) | 允许数据分布随时间未知变化，在线更新保形分位数仍保长期平均覆盖 | 不同模型/工具/任务类型带来漂移时在线校正；实现只需按实际覆盖更新一个 α，适合我们流式场景 | 是长期平均覆盖而非单步保证；需要在线拿到真实标签（turn 结束时间） | 【论文】 |
| Conformal Prediction 入门综述 | [arXiv:2107.07511](https://arxiv.org/abs/2107.07511) | 分布无关、有限样本覆盖的保形预测系统教程 | 实现前统一团队口径：split conformal 的假设、非一致性分数怎么选、覆盖率怎么诊断 | 教程，非方法/库 | 【论文】 |

**关键结论（保形）**
- 保形预测能给我们「带覆盖保证的 ETA 区间」，但前提是可交换性；我们的 turn 来自不同 session/模型/工具分布，落地时必须：① 按 session 或 step 数分桶做 Mondrian；② 用 ACI 在线校正；③ 用 martingale/可交换性检验监控失效【论文 + 官方文档】。
- 删失是绕不开的：正在进行中的 turn 没有结束时间，CQR 直接丢样本会偏差；应走「保形 × 生存分析」（2103.09763 / 2412.09729）路线，而不是纯回归 + 保形【论文】。

## 2. 生存分析 / 风险模型（把「turn 何时结束」当删失问题）

| 项目 | 链接 | 核心方法（一句话） | 对我们的可借鉴点 | 不适用原因 | 来源 |
|---|---|---|---|---|---|
| scikit-survival (sksurv) | [repo](https://github.com/sebp/scikit-survival) · [docs](https://scikit-survival.readthedocs.io/en/stable/) | 基于 sklearn API 的删失生存分析：Cox、Kaplan–Meier、随机生存森林（RSF）、GradientBoostingSurvivalAnalysis | RSF 直接输出条件生存曲线，取其中位数即 ETA；GBM survival 等价于带协变量的离散 hazard 加性模型；离线拟合成熟、样本效率高于深度模型 | Python 训练；无法在线增量；树/模型导出到 Node 需自研（或 ONNX） | 【官方文档】 |
| lifelines | [repo](https://github.com/CamDavidsonPilon/lifelines) · [docs](https://lifelines.readthedocs.io/en/latest/) | 纯 Python 生存分析：Kaplan–Meier、Cox PH、参数化 AFT（Weibull/Log-Normal/Log-Logistic） | 我们的步时长重尾、且前置调研已发现 Weibull 拟合好，AFT 参数模型可给中位数/分位闭式解、样本效率极高，适合做小数据基线 | Cox 比例风险假设较强；纯 Python、无在线预测 | 【官方文档】 |
| pycox | [repo](https://github.com/havakv/pycox) | PyTorch 生存模型库：LogisticHazard（即 Nnet-survival 离散时间模型）、PMF、DeepHit/DeepHitSingle（含竞争风险）、DeepSurv/CoxPH、CoxTime、MTLR，附评估指标与数据集 | 离散时间 hazard 的做法与我们的 survival table 同构：把剩余时间按桶做 softmax/二分类，可加协变量（工具类型、上下文长度） | PyTorch 训练基建重；1600 test turns 规模下深度模型易过拟合；上线要重写 | 【仓库源码】 |
| DeepHit | [repo](https://github.com/chl8856/DeepHit) | 直接学习生存时间分布，支持竞争风险（competing risks） | 可把「正常完成 / 中断 / 报错」当竞争风险分别建模，输出各终点的条件分布 | 深度网络、样本需求大；官方实现是研究代码 | 【仓库源码】 |
| Nnet-survival（离散时间生存模型） | [arXiv:1805.00917](https://arxiv.org/abs/1805.00917) | 把生存分析转成按时间桶的逐桶二分类极大似然，可用任意神经网络（也可换 GBM） | **最易落地**：把「剩余时间」离散成桶，用 LightGBM 逐桶二分类 → 累乘生存曲线；天然处理删失、桶内样本量可控 | 需选择时间桶粒度；桶外（超长 turn）外推差，需尾巴桶合并 | 【论文】 |
| torchsurv | [repo](https://github.com/Novartis/torchsurv) | PyTorch 生存建模的 loss/metrics（C-index、IBS 等）与配套工具 | 统一删失场景的评估口径（C-index、Integrated Brier Score），可作离线评测参考 | 训练基建；不是模型库本身 | 【仓库源码】 |
| DeepSurv | [arXiv:1606.00931](https://arxiv.org/abs/1606.00931) | Cox 比例风险 + 深度网络，学习协变量的非线性效应 | 工具类型/上下文规模的非线性效应可由网络自动学；可作协变量重要性对照 | 比例风险假设；深度模型在小数据上不稳 | 【论文】 |

**关键结论（生存分析）**
- 我们的经验生存表本质上是「无协变量的离散时间 hazard」；升级路径应是：加协变量（工具、k、elapsed、session 特征）+ 显式 hazard 参数化，而不是继续查表【论文/官方文档】。
- RSF / AFT 是性价比最高的两个候选：RSF 非参数、能出完整条件分布；AFT 参数化、小样本稳、能闭式计算分位，且与已知的重尾 Weibull 形态一致【官方文档 + 论文】。
- 评估不能只用 MAE：删失下要用 C-index / IBS（torchsurv、sksurv 口径），否则删失样本会被系统性忽略【仓库源码】。

## 3. 分位回归与 GBM（含进度库的时间平滑策略）

| 项目 | 链接 | 核心方法（一句话） | 对我们的可借鉴点 | 不适用原因 | 来源 |
|---|---|---|---|---|---|
| LightGBM quantile | [docs](https://lightgbm.readthedocs.io/en/latest/Parameters.html) | `objective=quantile` + `alpha`，用 pinball loss 直接优化指定分位；配套 quantile metric | q50 即中位数 ETA，q10/q90 给区间；比平方损失更抗重尾；可加单调约束/多模型 | 分位可能交叉（需排序/单调化）；外推差；Node 推理需导出（ONNX/树 JSON） | 【官方文档】 |
| CatBoost Quantile / MultiQuantile | [docs](https://catboost.ai/docs/en/concepts/loss-functions-regression) | 回归损失含 Quantile（alpha）与 MultiQuantile，一次训练多个分位 | 多分位一次训练，减少模型维护；类别特征（工具名、turn 类型）处理友好 | 训练侧依赖；部署需导出 | 【官方文档】 |
| Quantile Regression Forests（Meinshausen） | [JMLR 2006](https://www.jmlr.org/papers/v7/meinshausen06a.html) | 随机森林叶节点保留全部训练样本，预测时取条件分布的分位数 | 给出条件分布而非均值，重尾下更稳；可同时出多个分位点 | 分位数外推受限；森林大、推理慢；需自实现 | 【论文】 |
| quantile-forest（Zillow） | [repo](https://github.com/zillow/quantile-forest) · [docs](https://zillow.github.io/quantile-forest/) | sklearn 兼容 QRF：预测时可取任意分位（不重训）、支持 OOB、quantile ranks、Cython 加速 | 快速验证 QRF 效果、生成校准残差/难度因子；离线小数据鲁棒 | Python；部署要导出 | 【仓库源码】 |
| NGBoost | [arXiv:1910.03225](https://arxiv.org/abs/1910.03225) | 自然梯度 boosting，直接输出完整概率分布（分布参数随协变量变化） | 用分布（如对数正态）一次得到中位数与区间，比逐分位省模型；适合重尾右偏 | 分布假设与调参敏感；小数据收益不保证 | 【论文】 |
| sklearn GBM 分位示例 | [docs](https://scikit-learn.org/stable/auto_examples/ensemble/plot_gradient_boosting_quantile.html) | `GradientBoostingRegressor(loss="quantile")` + 分位区间示例 | 复现基线的最小实现参考，先验证「分位 GBM 能否打过经验表」 | 仅示例 | 【官方文档】 |
| tqdm | [源码 std.py](https://raw.githubusercontent.com/tqdm/tqdm/master/tqdm/std.py) | 对步增量做指数滑动平均（EMA，默认 `smoothing=0.3`）估速率，剩余 = 剩余量 / 速率 | 只做「速率平滑」，实现极简；展示层可借 | 假设速率平稳、且已知总量（我们不知道总步数）；重尾 + 长工具调用下严重误导——正是当前插件的痛点 | 【仓库源码】 |
| rich | [源码 progress.py](https://raw.githubusercontent.com/Textualize/rich/master/rich/progress.py) | 速度 = 样本窗口内完成量/时间；`TimeRemainingColumn.max_refresh = 0.5` 秒防抖刷新 | 刷新节流（0.5s）与样本窗口平滑可直接用于 UI；避免 ETA 数字跳动 | 纯速率法，同样没有总量先验 | 【仓库源码】 |
| indicatif | [源码 state.rs](https://raw.githubusercontent.com/console-rs/indicatif/main/src/state.rs) | Estimator 对速率做双指数平滑（EWA of EWA，权重 W(t)=0.1^(t/15)），进度停滞时把经过时间当「0 步伪更新」衰减速率，非单调进度时 reset | 双重平滑降噪（我们长 tool 调用导致速率剧烈波动）；「停滞时速率衰减」的 stall 处理值得移植到 Node——长工具调用不应让 ETA 傻等 | Rust 实现需移植；仍是速率法 | 【仓库源码】 |

**关键结论（分位/GBM 与进度库）**
- 训练目标：从「误差平方」改为「pinball loss / 分位 + 中位数」；重尾下「多分位 + 中位数」比单点回归更符合产品需求（用户在意「最可能多久」和「最晚多久」）【论文 + 官方文档】。
- 分位交叉要处理：可训练多分位后做排序/保序回归（isotonic），或直接上 CQR 的单调校准【论文】。
- 进度库（tqdm/rich/indicatif）只解决「已知总量下的速率平滑与展示防抖」；它们不解决我们「总工作量未知 + 重尾」的核心问题，但 indicatif 的双指数平滑与 stall 保护、rich 的 0.5s 节流可直接借到展示层【仓库源码】。

## 4. 软件/CI/构建时长预测与 agent 任务时长

| 项目 | 链接 | 核心方法（一句话） | 对我们的可借鉴点 | 不适用原因 | 来源 |
|---|---|---|---|---|---|
| CI 构建时长预测（Bisong et al., MSR 2017） | [arXiv:1712.06796](https://arxiv.org/abs/1712.06796) | 用 TravisTorrent 的构建任务/提交特征预测 CI build time，对比多种回归模型 | 「历史同类任务 + 变更规模」特征先行；先做特征基线再上复杂模型；评估与产品价值结合 | 特征不可直接迁移；CI 构建语义与 agent turn 不同 | 【论文】 |
| 变更对构建活动的影响预测（Microsoft CloudBuild） | [arXiv:1901.07142](https://arxiv.org/abs/1901.07142) | 用代码变更特征预测其对构建活动/时长的影响 | 「变更规模 → 工作量」的映射类比「工具调用类型/输入规模 → 步时长」；增量特征很重要 | 云构建内部特征不可得 | 【论文】 |
| Bazel JSON trace profile | [docs](https://bazel.build/advanced/performance/json-trace-profile) | 构建耗时由 critical path 决定，可逐阶段剖析；`analyze-profile` 给出关键路径与阶段耗时 | ETA 不应由「步数 × 平均步时长」线性外推，而应估「剩余关键路径长度」；对应我们应对剩余步骤的依赖/工具类型做关键路径估计 | 构建是 DAG，agent turn 无显式 DAG（可近似为工具类型序列） | 【官方文档】 |
| COCOMO / COCOMO II | [wiki](https://en.wikipedia.org/wiki/COCOMO) | 项目级工作量 = 规模^指数 × 成本驱动因子乘积；贝叶斯校准版本（Chulani et al. 1999, IEEE TSE）用先验校准参数 | 「规模未知时用先验 + 成本驱动因子」的思想；指数/因子分解可映射为特征（工具数、上下文规模、步类型） | 项目级/离线/参数需本地校准；粒度与单 turn 在线预测不匹配。贝叶斯校准论文在付费墙（未验证），仅作概念参考 | 【未验证】 |
| 动态延迟预测（Bayesian，ING 实践） | [arXiv:2309.12449](https://arxiv.org/abs/2309.12449) | 用延迟模式 + 贝叶斯建模在整个项目周期内动态更新延迟风险；4040 epics / 270 teams 实证优于静态模型 | 「先验 + 执行中证据动态更新」正是我们 turn 内 ETA 更新要做的事；可用贝叶斯更新替代分段平滑 | 项目级、非实时；领域特征不同 | 【论文】 |
| 软件工作量估计的负面结果 | [arXiv:1609.05563](https://arxiv.org/abs/1609.05563) | 系统比较最新方法 vs 数十年前方法，发现新方法未必更好（负面结果） | 警惕过度建模：先做简单基线（当前生存表）对照，再引入复杂模型；论文的对比方法论可复用 | 结论是警示而非方法 | 【论文】 |
| 业务过程剩余时间预测综述 | [arXiv:1805.02896](https://arxiv.org/abs/1805.02896) | 事件日志 → 剩余周期时间；系统综述 + 分类法，并在 16 个行业真实数据集上跨基准比较 16 种方法 | **与我们的问题严格同构**：前缀 → 剩余时间；特征（前缀事件、耗时、资源）与评估（MAE/分位、跨日志基准）可整套迁移 | 事件日志特征不同；需要大量 case 训练 | 【论文】 |
| PGTNet（过程图 Transformer） | [arXiv:2404.06267](https://arxiv.org/abs/2404.06267) | 事件日志转图，用 Process Graph Transformer 预测剩余时间；20 个真实日志上优于 SOTA | 用图结构表达「步骤依赖/关键路径」，比纯序列模型更接近「剩余工作量」；强基线，可对照我们的表模型 | 需构日志图；训练重 | 【论文】 |
| METR time horizon | [arXiv:2503.14499](https://arxiv.org/abs/2503.14499) | 50% 任务完成时间视界：人类完成 AI 有 50% 成功率的任务所需时长；Claude 3.7 Sonnet 约 50 分钟，自 2019 约每 7 个月翻倍 | 跨模型/任务类型的 ETA 先验可按能力缩放；提醒「能力-时长关系非线性」，不能线性外推 | 宏观指标，不能直接给单 turn ETA | 【论文】 |
| 算力放缓下的时间视界预测 | [arXiv:2511.19492](https://arxiv.org/abs/2511.19492) | 时间视界增长与算力增长成比例，给出算力放缓下的投影 | 长期先验/漂移建模；说明外推需带不确定性 | 宏观预测，不直接可用 | 【论文】 |
| RULSurv | [arXiv:2405.01614](https://arxiv.org/abs/2405.01614) | KL 散度早期故障检测 + 生存分析预测剩余寿命（XJTU-SY 轴承数据） | 「在线检测当前轨迹是否偏离历史 → 触发 ETA 重估」；生存分析给 RUL 的做法可映射到剩余步数 | 工业设备特征不迁移 | 【论文】 |
| TARE（HPC 作业运行时长） | [arXiv:2607.04935](https://arxiv.org/abs/2607.04935) | 面向重尾的 HPC job runtime 预测评估：GeoAccuracy、按 decile 分段、数据切分分析；对比 XGBoost / Last2 / UserReq | 重尾预测必须分 decile/分位评估，不能只看总体 MAE；`UserReq`（用户报的时长上限）是强特征，说明「显式获取时间预算」有巨大价值 | HPC 日志特征与用户上限属外部信息 | 【论文】 |
| LLM 时间感知实证 | [arXiv:2604.00010](https://arxiv.org/abs/2604.00010) | 68 个任务、4 个模型家族的实证：任务前估计系统性高估 4–7 倍；事后只能到数量级；agentic 场景偏差 5–10 倍 | 为「不要直接信 LLM 自报 ETA」提供硬证据；自报只能当弱特征/先验，必须用历史校准 | 结论是负面证据，不是可用估计器 | 【论文】 |
| LLM 自报进度可靠性 | [arXiv:2609.08589](https://arxiv.org/abs/2609.08589) | 在 τ²-bench 与 StageIF 上系统评估 LLM 自报进度：可靠性阶段性变化、中段偏差最大、最新模型在完成时偏保守 | 自报进度不可用于控制流或直接展示；可作辅助特征并校准；「完成时保守」可用于收尾提示 | 同上，负面证据 | 【论文】 |

**关键结论（任务时长预测）**
- 过程挖掘的剩余时间预测是最贴近的同构问题：它已经有完整的「前缀特征 → 剩余时间」方法族与跨日志基准，建议把它作为方法基线之一【论文】。
- 构建时长预测的教训：特征（历史同类任务、变更规模）比模型复杂度更重要；critical path 说明「总工作量」应显式建模，而不是用已完成步数线性代理【官方文档 + 论文】。
- agent 场景的硬约束：LLM 自报时间/进度均有系统性偏差（4–7× 高估、阶段性不可靠），只能作为特征或先验，不能作为输出或控制信号【论文】。

## 5. LLM 先验 / 信息获取（先要规模，再估计）

| 项目 | 链接 | 核心方法（一句话） | 对我们的可借鉴点 | 不适用原因 | 来源 |
|---|---|---|---|---|---|
| LLM-Prior | [arXiv:2508.03766](https://arxiv.org/abs/2508.03766) | 把自然语言/数据/图等上下文经 LLM 转为合法、可处理的概率分布（LLM + 混合密度网络），多智能体用 log opinion pooling 聚合先验（Fed-LLMPrior） | 「任务描述/上下文长度/工具清单 → 步数或剩余时长的先验分布」；可聚合多个 session/多模型先验；把先验做成显式分布便于后续贝叶斯更新 | 需要 LLM 调用成本；先验需用历史数据校准；研究框架非生产库 | 【论文】 |
| AutoElicit | [arXiv:2411.17284](https://arxiv.org/abs/2411.17284) | 用 LLM 抽取「专家先验」喂给贝叶斯预测模型；少标签即显著降误差、优于 in-context learning，可用自然语言细化先验 | 两阶段模板：LLM 先给先验 → 数据更新；并给出「直接让 LLM 预测」vs「LLM 给先验 + 模型拟合」的对照方法 | 面向线性/可解释模型与医疗等场景；未覆盖在线 ETA | 【论文】 |
| 迭代 ICL 先验抽取 | [arXiv:2406.01860](https://arxiv.org/abs/2406.01860) | 用迭代学习（MCMC）从 LLM 采样先验分布；GPT-4 先验在因果学习、比例估计、日常量估计上与人类先验一致 | 可 prompt 模型输出「预计步数/时长的先验分布」；多轮迭代采样比单次提问稳 | 重复采样成本高；先验偏差未校准；研究原型 | 【论文】 |
| LLM 多智能体敏捷工作量估计 | [arXiv:2509.14483](https://arxiv.org/abs/2509.14483) | 用 LLM 多智能体框架做敏捷工作量（story point）估计，强调可解释、可交互 | 「先让模型给估计+解释，再由人或数据修正」的产品化模式 | 面向敏捷 story、非实时；评估场景不同 | 【论文】 |
| Story Point 估计（LLM） | [arXiv:2603.06276](https://arxiv.org/abs/2603.06276) | 用 LLM 从需求文本估计 story point | 文本 → 规模的映射可做冷启动先验（新任务类型无历史数据时） | 估计偏差大；不适用于连续剩余时间 | 【论文】 |
| ProD（重尾 prompt 条件长度预测） | [arXiv:2604.07931](https://arxiv.org/abs/2604.07931) | 证明「同一 prompt 的长度是重尾分布而非标量」，用多次独立生成构造分布目标：ProD-M（中位数稳健点预测）与 ProD-D（分布目标） | 训练标签不要用单次采样：对每 turn 的「总步数」用同任务多次运行/相似 turn 采样得中位数或分布；重尾下用中位数目标更稳 | 面向 LLM 服务长度预测，但结构同构 | 【论文】 |
| EGTP / PLP（渐进长度预测） | [arXiv:2602.11812](https://arxiv.org/abs/2602.11812) | 复用主模型 hidden state + token 熵做静态长度预测（EGTP），并逐步预测剩余长度（PLP）；发布 ForeLen 基准 | 「在线原点预测剩余量」：每步更新剩余预测，而不是只用已完成步；对应我们 step-level 在线更新 ETA | 需要模型内部状态；我们只能用工具/文本特征替代 | 【论文】 |
| 推理 Scaling Laws | [arXiv:2408.00724](https://arxiv.org/abs/2408.00724) | 推理时计算与性能的 scaling law（compute-optimal inference，成本-质量权衡） | 用 token/计算预算做「工作量代理特征」；可估算不同预算下的成本，辅助先验 | 关注质量-成本，不是时间预测 | 【论文】 |

**关键结论（LLM 先验）**
- 「先问模型要任务规模，再用数据校准」在方法层面有明确支撑（LLM-Prior / AutoElicit / 迭代 ICL 先验），但没有找到已工程化的开源「planning-then-ETA」产品（未验证/缺口）；最接近产品化的是敏捷工作量估计（2509.14483）与 TARE 里的 `UserReq` 特征（显式时间预算）。【论文】
- 失败模式必须写进设计：LLM 自报时间系统性高估 4–7×（任务前），面板级进度自报阶段性不可靠；因此 LLM 输出只能作为**先验/特征**，必须经过历史数据 + 保形/贝叶斯校准，且要有「自报明显离谱时降权」的机制。【论文】
- 可操作形态（两阶段）：① turn 开始时用任务描述 + 上下文规模让模型给出「预计步数分布或剩余时长先验」；② 用前缀数据（k、elapsed、工具序列）+ 历史 turn 训练生存/分位模型，把 LLM 先验作为特征或先验参数；③ 保形/ACI 在线校准输出区间。【论文】

## 6. 对我们最有价值的 5 个方法（排序 + 理由）

1. **业务过程剩余时间预测框架（prefix → remaining time；1805.02896 / PGTNet 2404.06267）**
   与我们的问题严格同构（case/turn、event/step、prefix/已完成步），已有完整的方法族、特征与评估范式可整套迁移；成本最低、见效最快，应作为方法基线先做（尤其「前缀特征 + 分位评估」）。不适用点：事件日志特征需要映射到 agent 的 step 语义。

2. **离散时间 hazard 生存模型（Nnet-survival 1805.00917 思路 + sksurv RSF / lifelines AFT）**
   正面解决「进行中的 turn 无法用」的删失问题，输出条件生存曲线 → 中位数/分位 ETA；离散 hazard 可用 LightGBM 逐桶分类实现，离线拟合、导出到 Node；AFT 在小样本上稳且与已知 Weibull 重尾形态一致。这是替换经验生存表的首选。

3. **CQR + ACI 在线校准（1905.03222 + 2106.00170；MAPIE/crepes 提供实现参考）**
   同时解决「点估计」与「带覆盖保证的区间」；CQR 用分位 GBM 提供自适应宽度，ACI 处理 session/模型漂移下的在线校准；是我们 ETA 输出「置信度」的标准路径。前提：先解决删失（与第 2 项组合）。

4. **Normalized / Mondrian 保形（crepes / MAPIE）**
   重尾 + 异方差下的关键工程技巧：用难度因子归一化区间宽度，按已完成步数 k 分层校准，避免「所有 turn 一个区间」；配合 martingale 监控可交换性，覆盖失效可告警。

5. **LLM 两阶段先验 + 自报仅作特征（LLM-Prior 2508.03766 / AutoElicit 2411.17284；反证 2604.00010 / 2609.08589）**
   直击误差根因「不知道总工作量」：让模型先输出规模先验（步数/时长分布），再用数据校准融合；同时用「自报不可靠」的实证约束设计降权/回退。没有现成产品，必须自研，但方法论清晰。

**明确不适用 / 不推荐直接采用的方法**
- **tqdm / rich / indicatif 的纯速率法**：假设匀速且已知总量；我们不知道总步数、步时长重尾且长 tool 调用频繁，直接套用会更差（这也解释了当前产品观感差）。只借展示层：indicatif 双指数平滑 + stall 处理、rich 0.5s 刷新节流【仓库源码】。
- **DeepHit / pycox 深度生存网络**：1600 test turns / 239 sessions 规模太小，深度模型易过拟合且部署重；先用 RSF / AFT / 离散 hazard LGBM【官方文档 + 论文】。
- **COCOMO / COCOMO II**：项目级、离线、参数需本地校准，粒度不匹配；只借「先验 + 成本驱动因子」的建模思想（贝叶斯校准原始论文在付费墙，未验证）【未验证】。
- **纯 split conformal 直接上**：忽略 session/模型漂移会破覆盖；必须 Mondrian + ACI 组合【论文】。
- **把 LLM 自报 ETA/进度直接展示或用于控制流**：有系统性偏差的实证证据（4–7× 高估、阶段性不可靠）【论文】。

## 验证说明

- 51 条引用链接均于 2026-10-24 用 `curl -L` 验证，状态码全为 `200`，逐条记录见 `links-eta-strategy.tsv`。
- 未作为引用链接的候选（验证失败，未使用）：MDPI 论文页（403，Cloudflare）、ACM DL Docker build 论文（403）、USC COCOMO II 手册 PDF（000）、IEEE TSE「Bayesian analysis of empirical software engineering cost models」DOI 跳转（202 反爬质询，无法确认内容，故标注未验证）。
- 论文结论均来自 arXiv abs 页摘要或官方文档/源码直读，未做全文复现。
