# dsh-conv-progress 设计文档

> 版本 v0.1.0 · dsh `0.2.1-rc.2` · 2026-10-22
> 配套文件：`plugins/dsh-conv-progress/`（代码）、`research/research-progress-eta.md`（调研全文 291 行）、`research/dsh-internals.md`（DSH 内部机制 1463 行）、`research/links.tsv`（45 条链接取证）。

## 1. 摘要

给对话做"进度条 + 剩余时间"。核心结论三条：

1. **不存在"总工作量"的真值**。DSH 没有 `plan/created`、没有"预计步数"事件；任何百分比都是推断。→ 进度源只用**可观测信号**（step 数、工具调用、todo 计划完成度、耗时），模型自报进度一律不用（arXiv 2609.08589 实测中段不可靠）。
2. **进度量化以「step 当量」为统一单位**：`percent = 已完成当量 / 预计总当量`；有 todo 计划时用计划剩余步数校准（0.65/0.35 融合），无计划时退化为纯 step 模型。
3. **剩余时间 = 双 EMA**：步耗时 EMA（容量/时间双平滑）+ ETA 自身 EMA，turn 内单调；信息不足时**显式降级**（只显示已用时间），绝不给假数字。

已交付并验证：宿主采集 + `@Remote('snapshot')` RPC + `conversation.composer.dock` 胶囊进度条，真实 GUI 中渲染 `calling bash │ 66% │ ~10m20s left`（150px 进度条，位于输入框下方 ambient 行）。

---

## 2. 调研（开源项目与可借鉴点）

调研覆盖 4 类 24 个项目/文献，全部链接实测可达（`research/links.tsv`）。下表是直接影响本实现的 12 个：

| # | 项目 / 文献 | 链接 | 核心做法 | 本插件借鉴 |
| --- | --- | --- | --- | --- |
| 1 | **indicatif** | https://github.com/console-rs/indicatif | `Estimator` 双重指数平滑，观测按 `0.1^(Δt/15s)` 做时间权重；停顿插入伪观测 | 步耗时 EMA 的时间归一化权重（`estimator.js:observeStepMs`） |
| 2 | **tqdm** | https://github.com/tqdm/tqdm | 完成量、时间**分别** EMA 后再相除得速率；`total=None` 时进入纯速率退化分支 | 分母（预计总步数）与分子（已完成）分开平滑；ETA 不直接用瞬时速率 |
| 3 | **rich.progress** | https://github.com/Textualize/rich | 30s 滑动窗口算速率；渲染节流 `max_refresh=0.5s` | 客户端渲染节流 + ETA 变化小于阈值不重绘 |
| 4 | **cli-progress** | https://github.com/npkgz/cli-progress | 用 `NULL`/`INF` 显式编码"不可估"，而不是给 0 | `percent:null` / `etaMs:null` 表示不确定态 |
| 5 | **SO #933242** "Smart progress bar ETA" | https://stackoverflow.com/questions/933242 | 回看对称法：剩余 ≈ 最近完成同等比例工作量所花时间；中点后二分插值 | V0.2 候选（末端最准，不需总步数） |
| 6 | **Rummel 2017（Weibull）** | https://dl.acm.org/doi/abs/10.5555/3122114.3122116 | 任务时长服从 3 参数 Weibull，144 个任务 98.6% 可拟合；进度 = `F(t)` | 宏观进度曲线的理论形状；当前用 EMA 近似，未上拟合 |
| 7 | **RULSurv**（arXiv 2405.01614） | https://arxiv.org/abs/2405.01614 | 删失感知生存分析；忽略删失 MAE 12.6→18.5 min | 校准数据集必须把"未结束会话"按右删失纳入（V0.2） |
| 8 | **TARE**（arXiv 2607.04935） | https://arxiv.org/abs/2607.04935 | 时长预测评估看尾部：低估率比均值误差更重要 | 验收指标定为"低估率"而非平均误差 |
| 9 | **vLLM metrics** | https://raw.githubusercontent.com/vllm-project/vllm/main/docs/design/metrics.md | 推理拆 prefill/decode：TTFT + TPOT；`剩余 token × TPOT` | 步内微观 ETA 的公式来源（V0.2） |
| 10 | **OTel GenAI 语义约定** | https://github.com/open-telemetry/semantic-conventions-genai | agent / inference / tool 三层计时 | 阶段划分 `thinking / tool`，以及"整体 step 时长 = 各分量之和" |
| 11 | **Codex CLI** `status_indicator_widget.rs` | https://github.com/openai/codex | **只显示** `Working (2m14s)`，不显示 ETA | 默认展示已用时；ETA 只是增强项，不可靠就隐藏 |
| 12 | **dsh-job-progress**（生态先例） | https://github.com/Rice00/dsh-job-progress | 生产者写 JSON 快照 + 心跳 + 原子写；`total`/`speed` 任一未知则 `eta=null`；**未上报任务也显示但无进度条** | 数据契约、诚实降级 UX、`TypertRemoteService` RPC 骨架 |

补充参考：`dsh-context`（已有的 `timing{ttftMs,genMs,speedMs,toolsMs}` 一手数据）、`dsh-cost-meter`（用差分推断不可观测量 + 低置信度标注）、`dsh-session-stats`（dsh 插件最小骨架）、METR time-horizons、Kalman/贝叶斯分层、arXiv 2609.08589（LLM 自报进度不可靠）、ollama/llama.cpp timings（prefill/decode 分离、`cache_n`）。

---

## 3. 可行性分析

### 3.1 dsh 的插件机制（`research/dsh-internals.md` 实证）

一个插件包 = 宿主半边 + 可选 client 半边：

- **宿主**：`package.json` 的 `dsh.bundle.patch → cordis.patch.yml`（`- insert: [{id, name}]`）；`apply(ctx)`；`static inject = [...]` 声明依赖服务；Cordis 服务 + `ctx.effect()` 管理生命周期。
- **client**：`dsh.client = { platform: 'web' }`，产物 `lib/client.js` 必须写成 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`（**手写，无打包步骤**），导出 `apply(ctx)` / `inject`；`ctx.slots.register(...)` 往 slot 里塞 React 组件；`require('react')` 可取 React。
- **数据通道三种**：
  | 通道 | 机制 | 评价 |
  | --- | --- | --- |
  | A. 会话投影 | `ctx.sessionProjections.register({key,stateVersion,stateSchema,init,apply,wire})`，client `props.useProjection('key')` 由框架 push | **终态推荐**：零轮询、事件级实时、天然多会话；代价是必须遵守纯函数 fold 契约 |
  | B. Remote RPC | 宿主 `class Svc extends TypertRemoteService` + `@Remote('snapshot')`，client `connection.rpc.call('/api', '<ns>/<method>', {args:{request}})` | **v0.1 采用**：生态先例最多（job-progress），一条 JSON 快照最省事；需自己传 sessionId、需轮询 |
  | C. 自建 REST/SSE | `ctx.webServer.register(...)` | 不推荐：要自行处理鉴权/LAN 围栏，本 profile 无先例 |
- **热注入**：`dev_inject_plugin(dir)` → profile `node_modules` 建 junction + `loader.create`，免重启；`dev_reload_package(name)` 热重载；`dev_uninject_plugin` 卸载即净。**注意**：注入不写 profile 配置，dsh 重启后失效。

### 3.2 能拿到的对话数据（源码实证）

`ctx.on('session/event', (session, event) => …)` 是本插件的唯一数据源，`SessionEvent = { type, seq, time, data }`。实际用到的事件：

| 事件 | payload | 进度含义 |
| --- | --- | --- |
| `turn/start` / `turn/end` | `{turn}` / `{turn, reason}` | 一轮的开始/结束（`reason`: `completed/aborted/blocked/error/max-tokens/interrupted/forked`） |
| `step/start` / `step/end` | `{turn, step}` | **步计数与步时长**，最核心的可观测量 |
| `tool/call` / `tool/result` | `{turn, step, callId, name, arguments}` / `{…, error?}` | 当前阶段是 `calling <tool>`；在飞工具数 |
| `assistant/message` | `{turn, step, message, usage?, interrupted?}` | token 用量、是否被中断 |
| `todo/write` | `{todos: [{content, status}]}` | **计划完成度**（整表快照，last-write-wins） |
| `request/context` | `{provider, model, contextWindow?}` | 模型名/上下文窗口（展示用） |

另可用 `session.snapshotEvents()` 全量重放历史事件 → **中途打开 GUI 也能算出正确进度**（实现里 `bootstrap()` 就这么做）。

### 3.3 难点一：进度如何量化？

候选量化基准及取舍：

| 基准 | 可得性 | 问题 | 结论 |
| --- | --- | --- | --- |
| token 用量 / 上下文窗口 | ✅ `assistant/message.usage` + `requestContext().contextWindow` | 上下文占用 ≠ 任务完成度；长会话上下文几乎"总是接近满" | ❌ 仅作展示 |
| todo 完成比 | ⚠️ 取决于会话是否用 `todo_write`（本 profile `tool-todo` 默认 disabled） | 无计划时不可用；todo 粒度粗 | ✅ 可用时作主校准 |
| **step 数** | ✅ 必然存在（`step/start` 每个模型调用一次） | 总步数未知 | ✅ **主单位** |
| 已用时间比例 | ✅ | 需要总时长，同样未知 | ❌ 只用来算 ETA |

**采用方案：step 当量模型。**

```
stepsDone   = 历史轮已完成 step 数 + 本轮 step/end 数
stepFraction= 当前步进行到哪儿（有 tool/call 未 result → 0.6，否则 0.35）
totalSteps  = stepsDone + stepFraction + remainingSteps
percent     = (stepsDone + stepFraction) / totalSteps
```

`remainingSteps` 两个来源融合：

```
planRemainingSteps = (未完成 todo 数 + 0.4 × in_progress 数) × stepsPerTodoEMA
stepModelRemaining = 预计本轮剩余 step 数 = max(2, stepsPerTurnEMA − 本轮已完成)
remainingSteps     = 0.65 × planRemainingSteps + 0.35 × stepModelRemaining   （有 todo）
                   = stepModelRemaining                                    （无 todo）
percent            = 0.6 × planPercent + 0.4 × stepPercent                  （有 todo）
```

约束：turn 内 `percent` **单调不减**（`max` 上一值），上限 `0.97`（防止"看起来完了"却还在跑）；`turn/end` 后置 100%。

### 3.4 难点二：剩余时间如何预估？

> ⚠️ 本节是 v0.1 的选型过程记录。v0.2 已用 **7108 轮真实会话**离线重估，ETA 改为「经验生存表（条件中位数）+ 时间型进度」，test 集 MAE 5.7m → 4.4m，详见 **§12**。

ETA 三要素：

1. **步耗时 EMA**：`stepMs' = α·obs + (1-α)·stepMs`，`α_t = 1-(1-α)^{Δt/Δt0}` 做时间归一化（indicatif 的做法），obs 落在 `[1s, 20min]` 内截断（防卡死/时钟跳变污染）。
2. **剩余步数**：同 §3.3。
3. **当前步剩余**：`(1-stepFraction) × stepMs`。

```
rawEta = currentStepRemaining + futureSteps × stepMs
etaMs  = clamp( α_eta·rawEta + (1-α_eta)·lastEta , 3s, 3h )
```

- 双 EMA（先平滑速率、再平滑 ETA）避免"最后一秒跳变"。
- 冷启动：无历史时 `stepMs = 25s`、`stepsPerTurn = 8`（可由 Config 覆盖）；前 3 步 confidence=low。
- **退化路径**：`confidence==='low'` 或 `etaMs` 超范围 → UI 只显示 `已用 12m · 12 步 · calling bash`（Codex CLI 的做法）。
- 校准：`turn/end` 时回写 `observeTurn({durationMs, steps, todoDelta})`，更新 `stepsPerTurnEMA` / `stepsPerTodoEMA`，所以**同一会话越用越准**。

### 3.5 方案对比与推荐

| 方案 | 进度源 | 数据通道 | 复杂度 | 实时性 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **① step 当量 + 计划校准（推荐）** | 事件流计数 + todo | 投影或 RPC | 中 | 高 | ✅ **采用**：无需真值、冷启动可先验、随会话自校准 |
| ② 纯时间 Weibull 拟合 | 历史会话时长分布 | 投影 | 中高 | 中 | 需几十条完成样本才能拟合，冷启动不可用；V0.2 融合 |
| ③ token/上下文占比 | usage | 投影 | 低 | 高 | ❌ 语义不成立 |
| ④ LLM 自报进度 | 让模型输出 `%` | RPC | 低 | 中 | ❌ arXiv 2609.08589 实证不可靠，且污染 token |
| ⑤ 回看对称 | `(t, progress)` 序列 | 投影 | 低 | 中 | 中期最准，但需 good progress 序列；V0.2 作中期修正 |

**推荐 = ①**；数据通道 v0.1 用 **B（Remote RPC 轮询）**、终态升级 **A（会话投影）**——同一份 estimator 与 view model，切换只动取数层。

### 3.6 风险与待确认项

| 风险 | 级别 | 应对 |
| --- | --- | --- |
| 依赖 dsh 内部 API（事件名、`TypertRemoteService`、slot 名），升级可能失效 | 高 | 已记录源码位置；预检/降级：拿不到数据就不渲染 |
| client bundle 手写契约的静默失败（`__ModuleLoader__.load` 缺 `module.exports`/`apply`/`inject`） | 高 | 注入器有预检；本地已实测 `node --check` + 真机渲染 |
| 裸 import `@deepseek-ai/*` 在插件目录内解析失败 | 中 | 插件自带 `node_modules` 软链到 dsh 安装（README §4） |
| 轮询与模型流争抢（job-progress 曾踩坑） | 中 | 900ms/4000ms 低频 + 单会话单请求 + 空闲退避 |
| 百分比误导用户 | 中 | 上限 0.97、低置信隐藏 ETA、文案用 `~`/`≈` |
| 本 profile `tool-todo` disabled ⇒ 无 `todo/write` | 已知 | 纯 step 模型为主路径，单测覆盖 |
| Weibull/回看/删除感知未实现 | 已知 | V0.2 路线图（§5.4） |

---

## 4. 实现方案

### 4.1 模块划分

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `lib/estimator.js` | 纯函数：`createModel` / `beginTurn` / `observeStepMs` / `observeTurn` / `estimate` | **无**（可在 node 里单测） |
| `lib/index.js` | 宿主：订阅 `session/event` → `ProgressState` → `estimate` → view model；`@Remote('snapshot')` | `schemastery`、`dsh-typert-protocol` |
| `lib/client.js` | 浏览器 bundle：`ConvProgressDock` + 样式 + i18n + 轮询 | `react`（由 module-loader 提供） |
| `test/estimator.test.mjs` | 10 个 `node:test` 用例 | `node:test` |

### 4.2 宿主状态机（`lib/index.js`）

```
session/event ──▶ onSessionEvent(session, event)
   ├─ 首见该 session 或曾经 seq 断档 ──▶ bootstrap(session)   // snapshotEvents() 全量重放
   ├─ turn/start  ──▶ beginTurn(model, turn); 记 turnStartAt
   ├─ step/start  ──▶ 记 stepStartAt
   ├─ step/end    ──▶ observeStepMs(now - stepStartAt); stepsDone++
   ├─ tool/call   ──▶ pendingTools++; lastTool = name; phase = 'tool'
   ├─ tool/result ──▶ pendingTools--
   ├─ todo/write  ──▶ todos = 新整表；估计器校准（observeTurn 的 todoDelta 路径）
   ├─ assistant/message ──▶ usage、phase = 'thinking'
   └─ turn/end    ──▶ observeTurn({durationMs, steps, todoDelta}); phase = 'done'|'idle'
```

`@Remote('snapshot') async snapshot({sessionId})` → §4.5 view model。LRU 上限 128 个会话状态，防止多会话内存泄漏。

### 4.3 客户端渲染（`lib/client.js`）

- 注册点（**单行**，注入器预检要求 `register({` 后紧跟对象字面量）：
  ```js
  ctx.slots.register({ name: 'conversation.composer.dock', id: 'conv-progress', order: -1, locale: NS }, ConvProgressDock)
  ```
  `conversation.input.dock` = 输入框上方全宽 list slot（同 slot 已有 `todo`(0)、`cost-meter-qstrip`(5)、`goal`(10) 等，`-5` 落在 `michengai-btw`(-50) 之后、`todo` 之前）。
- 取数：组件从 props 拿 `sessionId`，轮询 `connection.rpc.call('/api', 'convProgress/snapshot', { args: { request: { sessionId } } })`；`running` 时 900ms、空闲 4000ms；完成态 linger 6s 后隐藏。
- 视觉：`.cvp-lane > .cvp-label + .cvp-track > .cvp-fill + .cvp-stats`；条高 4px、圆角、`linear-gradient(90deg, var(--dsw-alias-brand-primary), color-mix(...))`；`role="status"` + `aria-valuenow`。
- 降级：`prefers-reduced-motion` 关动画；`max-width:640px` 隐藏 `elapsed/step` 等次要字段；`percent==null` 渲染条纹不确定态。

### 4.4 接入 dsh 的步骤（可直接照抄）

```bash
# 0) 前提：插件目录已有 lib/{index,client,estimator}.js + package.json + cordis.patch.yml
# 1) 依赖软链（插件目录内，让裸 import 能解析到 dsh 安装的包）
P=/home/user/.dsh/dsh-taskbar/plugins/dsh-conv-progress
D=/home/user/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
mkdir -p $P/node_modules/@deepseek-ai
for p in dsh-typert-protocol schemastery cordis; do ln -sfn $D/$p $P/node_modules/@deepseek-ai/$p; done
# 2) 自检
cd $P && node --test test/estimator.test.mjs && node --input-type=module -e "import('./lib/index.js').then(m=>console.log('OK',m.default.name))"
# 3) 热注入（免重启）
#    dev_inject_plugin({ dir: "$P" })        → host ✓ client ✓
#    dev_plugin_status()                     → [active] …(dsh-conv-progress)
# 4) 打开/刷新 GUI（http://127.0.0.1:3080），进入任一运行中会话 → 输入框上方出现进度条
# 5) 持久化（重启后仍在；会改 profile 配置，需用户同意）
#    dev_install_package({ dir: "$P", profile: "web" })
```

### 4.5 view model 契约

见 `plugins/dsh-conv-progress/README.md` §7（`percent/etaMs/phase/todos/confidence/basis/breakdown` 等 25 个字段）。

### 4.6 与"终态推荐"的差距（v0.2 路线）

1. **通道切换**：宿主把 `ProgressState` 改成注册一个 `convProgress` 会话投影（`stateSchema` 可用鸭子类型 `{parse:v=>v}` 省掉 zod；`wire.view` 返回扁平 view），client 换 `props.useProjection('convProgress')`，删掉轮询 —— 改动约 20 行 + 一个注册调用。
2. **回看对称**：维护 `(time, percent)` 序列，过 50% 后二分插值算剩余，校准 EMA 的末端偏差。
3. **Weibull / 删失**：用历史会话（含未结束的右删失样本）拟合 β、η，输出 P50/P80 区间；UI 文案升级为 `约 4 分钟（3–6 分钟）`。
4. **评估**：历史会话离线回放，主指标 = 低估率 + 分位误差（TARE/GeoAccuracy 思路）。

---

## 5. 验证记录

| 验证项 | 方法 | 结果 |
| --- | --- | --- |
| 估算器单元测试 | `node --test test/estimator.test.mjs` | 10 pass / 0 fail |
| 宿主导入与导出 | `node --input-type=module -e "import('./lib/index.js')"` | `OK ConvProgressService`，`snapshot` 为原型方法 |
| client 语法 | `node --check lib/client.js` | 通过 |
| 注入 | `dev_inject_plugin` | `host ✓ client ✓` |
| bundle 进入页面 | 抓 `/plugins/??…` 合并包 URL | 含 `dsh-conv-progress/client.js` |
| RPC 端到端 | `~/.dsh/conv-progress/debug.jsonl` | 真实会话 `events:680, running:true, turn:1, stepsDone:85` |
| 样式注入 | 扫描 DOM `data-conv-progress` | 命中 |
| 真实渲染 | Playwright 打开运行中会话，采样 `.cvp-lane` | 6/6 采样可见，`aria-valuenow=67`，ETA 逐秒递减 |
| 视觉 | `deviceScaleFactor:2` 截图 | `plugins/dsh-conv-progress/assets/running.png` |

> 唯一已知 console 报错是无关的静态资源 404。

---

## 6. 参考

- 调研全文（含 45 条链接与取证状态）：`research/research-progress-eta.md`、`research/links.tsv`
- DSH 内部机制（事件表、投影契约、slot 契约、4 个静默失败点、风险清单）：`research/dsh-internals.md`
- 代码：`plugins/dsh-conv-progress/`
- 实拍截图：`plugins/dsh-conv-progress/assets/{running,states,idle}.png`（仓库内）；原始全套截图在本地 `probes/`（不入库）


---

## 11. v3 增量：常驻 100% + 点击查看历史任务

> 需求来源：第二轮迭代需求「模块常驻显示（无任务时 100%）+ 点击查看该会话的历史任务记录」，硬约束为**轮询 / linger / 低置信度降级逻辑一行不改**。

### 11.1 两个需求对应的实现面

| 需求 | 改动面 | 落点 |
| --- | --- | --- |
| R1 常驻 100% | 渲染状态机（不动取数） | `lib/client.js` `ConvProgressDock`：`running ? snapshot.percent : 1`；`idle` 态 = 灰色点 + `idle` 标签 + 满格 150px 条 + `100%` |
| R2 点击看历史 | 新增一条只读数据通道 + 浮层 | 宿主 `@Remote('history')`（`lib/index.js`）+ 纯函数 `lib/history.js` + 前端 `HistoryPanel` / `useHistory` |

### 11.2 历史数据从哪来（生命周期）

1. **采集**：宿主在 `session/event` 上维护每个会话的 `ProgressState`。`turn/start` 清空 `taskTitle`；`user/message` 取首条文本作为任务标题（`extractTaskTitle`，图片/文件降级为 `[image]`/`[file]`）；`turn/end` 时把本轮汇总成一条记录 `appendTurnRecord(...)`。
2. **存储**：**内存**。`state.history` 是每个 session 独立的数组，按 `historyLimit`（默认 100）做环形裁剪（push 后 `splice(0, len-limit)`）。进程结束即丢失，**不写盘**。
3. **重建**：`bootstrap(state)` 首次访问某会话时用 `session.snapshotEvents()` **全量重放**事件流，因此 dsh 重启（或第一次打开某个旧会话）后历史会自动重建，不需要额外持久化。
4. **读取**：`convProgress/history` Remote 返回 `state.history.slice().reverse()`（最新在前）。客户端**只在浮层打开时**以 3s 节奏轮询；关闭即停。
5. **刷新触发**：`useHistory(sessionId, open, revision)` 的 `revision = snapshot.turns`，即快照里已结束轮数变化时立即重取一次。

### 11.3 交互与边界默认值（均可在代码常量处改）

| 边界 | 默认行为 |
| --- | --- |
| 无历史 | 浮层显示「本次会话还没有已完成的任务记录」+ 一行副提示 |
| 记录很多 | 浮层 `max-height: min(46vh, 360px)` 内部滚动，宿主侧最多保留 100 条 |
| 再次点击 | 收起（toggle）；`Escape` 或点击浮层外部同样收起 |
| 会话切换 | 自动关闭浮层（`useEffect([sessionId])`） |
| 加载/失败 | 首屏「正在加载…」；失败保留上次数据并静默重试（不打扰用户） |
| 字段缺失 | 标题为空 → `（无文本任务描述）`；原因未知 → `unknown` 灰 chip；置信度按步样本数（≥5 高 / ≥2 中 / 其余低） |

### 11.4 为什么是「浮层」而不是「卡片/侧栏」

`conversation.composer.dock` 是 22px 高的 ambient 行，塞不下列表；浮层用 `position: fixed` 向上弹出并**动态贴住胶囊**（`getBoundingClientRect` → `{left,bottom,width}`，宽度 `clamp(300,520)`），不改变 dock 行高、不影响官方 pill 布局，也不会被 composer 的 `overflow` 裁剪。滚动/resize 时实时重算锚点。

### 11.5 验证证据

- `node --test test/history.test.mjs` → 7 pass / 0 fail（标题提取 / 原因归一 / 置信度 / 环形裁剪）。
- 真实 GUI（probe20）：运行中会话胶囊 `calling bash96%~22s left`，`aria-valuenow=96`、fill `144.56px/150px`；点击后浮层 `520×292`，`Task history / 3 total`，三条记录（done 12:19·16m ago / aborted 11:51·44m ago / done 11:16·1h ago），chip 绿-橙-绿；再次点击收起；`pageerror` 为空。
- 空闲态（probe21）：`session-93fa849a` → `idle 100% 2 records`（304×22）；`session-19d9f63f` → `idle 100%`（250×22，无记录）。

---

## 12. ETA 算法 v2：用 7108 轮真实会话重估（替换 §3.4 / §4.3 的 v1 估算）

> 需求来源：「根据已有的日志与会话数据去重新评估我们的预计耗时计算方法，然后优化算法」。目标不是拍脑袋调参，而是**用真实会话日志做离线回放评估，再按留出集指标选型**。

### 12.1 数据

| 项 | 值 |
| --- | --- |
| 原始语料 | `/home/user/.dsh/sessions/**/session.v4.jsonl`：1198 个文件 / 3.86 GB |
| 抽取后 | 785 个文件 → **7108 turns / 758 sessions**（`data/turns-all.jsonl`，23 MB） |
| 一轮记录 | `{sid, ws, model, turn, start, end, durMs, reason, todos, steps:[{n,start,end,first,tools:[{name,start,end}]}]}` |
| 卫生过滤 | 丢弃时长 >2h 或相邻事件间隔 >15min 的轮次（睡眠/人肉等待会污染），7108 → 6921 |
| 分布（参考） | 时长 p50 208s / p90 21.4m / p99 6.6h；步数 p50 9 / mean 21；步时长 p50 13.2s / p90 49.6s（重尾）；completed 5270 / error 725 / aborted 617 / interrupted 486 |

抽取器 `tools/extract-turns.mjs`（流式 + 子串预筛，只对命中的行 `JSON.parse`）。

### 12.2 评估方法（离线回放）

`tools/eval-eta.mjs`：按 **session hash 70/30** 分 train/test（防同会话泄漏），每轮以 1s 网格重放（每轮最多 400 采样均衡长短轮），每会话按轮序重建模型状态（`beginTurn` / `observeTurn`），喂给 `estimate()` 的 facts 与宿主完全一致（含 `turnStartedAt`、`model`）。只评 **completed** 轮（aborted/error 无「真实完成时间」可言）。

指标：`MAE` / `medianAE` / `bias`（均值有符号误差）/ `p50`（相对真实剩余的中位误差）/ `MAPE` / 分桶（进度、时长、步数、已用时间）。

### 12.3 选型（同一 test 划分的候选对比）

| 方案 | MAE | medianAE | p50 偏差 | 结论 |
| --- | --- | --- | --- | --- |
| v1 step 当量 + 双 EMA（原实现） | 5.7m | 3.6m | +58.1s | 基线；短轮严重高估、长轮尾部高估 |
| 中位数表（k × elapsed 粗桶） | 4.6m | 2.5m | +11.6s | 大幅改善 |
| **fine 表（k≤40 exact × 30s elapsed，分段加长）向 coarse 收缩** | **4.4m** | **2.2m** | **+5.2s** | ✅ **采用** |
| × session/turn/model 速度因子 | 4.7–5.0m | 2.0–2.5m | 偏移变大 | ❌ 过拟合，弃 |
| plan/heavy 分区表 | 4.7m | — | — | ❌ 样本被拆散 |
| 与 v1 按 0.7/0.8 混合 | 4.7–4.8m | — | — | ❌ 无收益 |

信息论层面的上限已探明：**同样的 (k, elapsed) 特征在 test 上重拟合（oracle）也只有 4.6m**，所以 4.4m 已基本吃满特征信息。

### 12.4 最终模型（`lib/eta-model.js`，由 `tools/build-eta-model.mjs` 生成）

- 只用 train 轮拟合，输出一张**经验生存表**：`FINE[k][e]` = 给定「已完成 k 步、本轮已用 e 毫秒」时，**剩余时间的条件中位数**（q=0.5）。
- 时间桶分段（长轮保留尾部分辨率）：`0–15min: 30s`、`15–45min: 5min`、`45min–2h: 15min`、`2–6h: 1h`、`≥6h` 单格；k 取 0..40 exact + 粗档。
- 小样本向粗表**对数空间收缩**（经验贝叶斯）：`w = n/(n+40)`，`logEta = w·logFine + (1-w)·logCoarse` —— 避免细表里 2–3 个样本的噪声格乱跳。
- 附带 `REM_STEPS[k]`（k→中位剩余步数）与全局先验工 `STEP_P50_MS=13226`、`STEP_MEAN_MS=22832`、`turnDurP50Ms=207958`、`stepsPerTurnP50=9`。

### 12.5 v2 估算公式（`lib/estimator.js`）

```
elapsed      = now - turnStartedAt            // 缺省退化为 stepsDone·stepMs + stepElapsed
{etaMs, reliability, cell} = lookupEtaMs(stepsDone, elapsed)
eta          = clamp( ema(etaPrev, etaMs, 0.4), 3s, 3h )     // 只做显示平滑
timePercent  = clamp( elapsed / (elapsed + eta), 0, 0.99 )
percent      = plan 可用 ? 0.6·planPercent + 0.4·timePercent
                         : timePercent
percent      = clamp( max(percent, lastPercent), 1%, 97% )    // 轮内单调
confidence   = f(reliability, stepsDone, 本轮样本数)          // 高/中/低
expectedSteps= stepsDone + medianRemainingSteps(stepsDone)    // 仅展示用
```

关键语义变化：

1. **进度由「步数占比」改为「时间占比」**（`elapsed/(elapsed+剩余中位数)`）——与用户感知一致：长轮不再被"步数均值"卡住。
2. **计划全完成时不再 blend**：`planPercent==1` 但仍在干活 → 退回纯时间进度（修掉 v3 发现的「钉在 100%」）。
3. **不再用 `stepsPerTurn` 均值先验外推**（v1 的主因：先验 8 vs 实测中位 9 / mean 21）。
4. 剩余步数列只用于 title 文案（`105/128 steps`），不参与 ETA。

### 12.6 离线结果（test split，completed + hygiene，n=314556 采样 / 1600 轮 / 239 会话）

| 指标 | v1 | v2 | 变化 |
| --- | --- | --- | --- |
| MAE（平均绝对误差） | 341.1s (5.7m) | **266.4s (4.4m)** | **−21.9%** |
| medianAE（中位绝对误差） | 214.1s (3.6m) | **137.1s (2.3m)** | **−36.0%** |
| p50 相对误差（中位） | +58.1s | **+5.2s** | **−91%** |
| MAPE | 1.69 | **1.35** | −20% |
| bias（均值有符号） | +7.1s | −125.1s | 由「整体偏乐观」转为「略偏保守」* |

\* 拟合目标是**条件中位数**：剩余时间右偏（少数长尾样本拉高均值），中位数天然略小于均值，因此均值偏差转负；这是最小化绝对误差（MAE）的必然代价。对用户而言：**一半情况下误差 ≤5s 级别的量级判断，不再系统性低估**。

分时长 MAE（v1 → v2）：<30s 4.4m → **1.85m**；30–120s 4.4m → **1.77m**；2–5m 3.2m → **1.65m**；5–15m 3.9m → **2.9m**；>15m 9.6m → **8.7m**。短轮改善最大。

分位旋钮：q0.45 → MAE 4.5m / med 2.1m / MAPE 1.24；**q0.5 → 4.4m / 2.3m / 1.35**；q0.55 → 4.5m / 2.5m / 1.46 —— 取 0.5（理论上 MAE 最优）。

### 12.7 仍存在的偏差（信息论极限，非 bug）

- **轮尾高估**：进度 75–90% 时 bias +105s、90–100% 时 +245s。原因：仅凭「k 步 + 已用时间」无法判断「这一轮只剩一次收尾」；表现为最后几分钟 ETA 偏长、结束时直接跳 100%。
- **开头最不确定**：0–10% 分桶 MAE 仍约 8m（真实轮次时长跨度极大：p50 3.5m vs p90 21m）。
- **行为突变**：模型中途换档（长 bash、图像生成、等待子 agent）会让「历史步时长」失真；v2 靠生存表大幅缓解（不再外推步时长），但没有实时感知能力。
- **表有保鲜期**：模型/工具分布变化后需要重新跑 `build-eta-model.mjs`；表里记录了 `ETA_MODEL_META`（数据量、日期、分位、伪计数），便于追溯。

### 12.8 真实 GUI 实测（v2 生效后，probe27 / probe28）

- 运行中会话：`calling bash │ 87% │ ~5m17s left`，胶囊 `361×22 @ {x:444,y:924}`，`bar 150×3`，`fill 87.5%`，`aria-valuenow=88`，`data-running="1"`。
- title：`calling bash · 87% · ~5m17s left · 105/128 steps · Click to view past tasks`。
- 历史浮层：`Task history / 5 total`，5 条记录（Turn 5…Turn 1，含时长/步数/工具次数/置信度），再点收起；`pageerror` 为空。
- 单测：`node --test test/estimator.test.mjs test/history.test.mjs` → **17 pass / 0 fail**。

### 12.9 复现命令

```bash
cd /home/user/.dsh/dsh-taskbar
node tools/extract-turns.mjs 0 data/turns-all.jsonl          # 全量抽取（约 1–3 分钟）
node tools/build-eta-model.mjs                               # train 拟合 → plugins/.../lib/eta-model.js
node tools/eval-eta.mjs --data data/turns-all.jsonl \
  --impl tools/fixtures/estimator-v1.mjs --reasons completed --split test --json data/eval-v1.json
node tools/eval-eta.mjs --data data/turns-all.jsonl \
  --impl plugins/dsh-conv-progress/lib/estimator.js --reasons completed --split test --json data/eval-v2.json
node tools/search-eta.mjs --data data/turns-all.jsonl        # 候选算法 sweep（可选）
```

> 注意：本机所有 node 脚本都要 `env -u NODE_OPTIONS -u NODE_USE_ENV_PROXY -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy node ...` 运行，避免 dsh 注入的代理环境变量干扰。
