# DSH 内部机制调研 —— `dsh-conv-progress` 技术依据与 API 手册

> 调研对象：DeepSeek Harness **0.2.1-rc.2**（Cordis 插件框架，Node **22.23.2**），profile `web`。
> 产出用途：最终设计文档「可行性分析」章节的技术依据 + 实现时的 API 手册。
> 调研时间：2026-10-22。全部结论标注来源等级。

## 标注约定

| 标记 | 含义 |
|---|---|
| 【实】 | **源码已证实**：直接读过该文件（路径:行号附后） |
| 【文】 | 文档已证实：`~/.dsh/docs/kb/*.md` 原文 |
| 【推】 | **推断**：由源码片段/类型反推，未逐行验证运行时行为 |
| 【未验证】 | 明确未读/未测，实现前需确认 |

路径简写（后文所有 `dsh-*` 相对路径均指这个目录）：

```
$D = /home/user/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
$PROFILE = /home/user/.dsh/profiles/web
$PLUGINS = /home/user/.dsh/plugins
```

---

## 0. 结论速览（TL;DR）

1. **推荐架构（零轮询、零 REST、零 ws 代码）**：
   host 插件注册一个 **client-visible 会话投影** `convProgress`（纯函数 fold `session/event`），
   client 手写 module-loader 插件，在 slot `conversation.input.dock`（输入框上方全宽 list slot）
   注册进度条组件，`props.useProjection('convProgress')` 取数据。
   host 侧投影变更由框架自动 push 给浏览器，**不需要自建路由或轮询**。
   证据：`dsh-session-projection` + `dsh-api-session-controller/index.js:1202,1238`（§4.2）。

2. **现成投影可直接白捡**（client 侧 `useProjection(key)`）：
   `todos`（todo 列表）、`goal`（目标轮次）、`plan`（计划模式）、`sessionStats`（历史耗时）、
   `turnOutline`（各轮摘要）、`tokenUsage` / `contextPressure` / `contextBreakdown`（token 与上下文占用，
   全部 client 可见，见 §2.7）。

3. **进度信号的 ground truth 不存在**：DSH 没有"总工作量"事件。可确定性计算的是
   `turn/step 计数、工具在飞数、todo 完成比、goal 轮次、token/耗时`；
   **ETA 必须启发式**（§6 给公式与置信度分级），不要对外承诺精确。

4. **准确的事件词汇表**：`KNOWN_SESSION_EVENT_TYPES` 共 **62 个**事件（本 build 认得全集，§2.3），
   进度插件真正需要的只有 ~12 个（turn/step/message/tool/request-context/todo/goal/compaction）。

5. **最大风险**：client bundle 手写契约的 4 个静默失败点（§8/§9）、外部插件**依赖解析路径**问题
   （源目录加载无法解析 `@deepseek-ai/*` 与 `zod`，实测见 §7.3）、以及 `stateVersion`/投影契约升级易碎。

---

## 1. 调研环境与包分布

- dsh 安装：`/home/user/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/`，
  其 `node_modules/@deepseek-ai/` 下约 300 个包【实】。
- profile 额外依赖：`$PROFILE/node_modules/`（372 个目录，含 `dsh-job-progress`、`dsh-cost-meter`、
  `dsh-context`、`zod` 等现成插件范例）【实】。
- 关键包与职责：

| 包 | 职责 | 对本插件 |
|---|---|---|
| `dsh-session` | 会话日志、`SessionEventMap`、`Session`/`SessionStore` | 事件模型权威 |
| `dsh-session-projection` | `ctx.sessionProjections` 投影注册表（fold + 推送） | ★ 数据通道 |
| `dsh-api-session-controller` | host↔client 的会话控制流（projection 帧/baseline） | 推送链路 |
| `dsh-client-ui-renderer` | `SlotRegistry`（client 侧 `ctx.slots`） | slot 注册 |
| `dsh-client-ui-conversation` | 会话 UI 的 slot 契约（`conversation.*`） | 插槽选择 |
| `dsh-client-ui-session` | slot 标准 props（`useSession`/`useProjection`） | 组件取数 |
| `dsh-token-meter` | `tokenUsage`/`contextPressure`/`contextBreakdown` 投影（client 可见） | token 数据 |
| `dsh-session-stats` / `dsh-session-turn-outline` / `dsh-tool-todo` / `dsh-goal` / `dsh-plan-mode` | 现成投影 | 直接复用 |
| `dsh-host-webserver` / `dsh-api-gateway` / `dsh-typert-protocol` | REST 路由 / `/api` Remote 网关 | 备选通道 |
| `dsh-launcher`(?) 等 | — | 未读 |

> 说明：profile 内已有 `dsh-context`（官方，3.3k★ 生态插件）与 `dsh-cost-meter` 的 client bundle，
> 是"投影 + slot"的成熟先例；`dsh-job-progress` 是**手写 client bundle + Remote RPC 轮询**的
> 可读范例（513 行，未压缩）【实】。

---

## 2. Host 侧：插件解剖与会话事件模型

### 2.1 最小 host 插件形态（Cordis）

官方投影插件的**最干净模板**是 `dsh-session-stats`，全文 198 行【实】：

```js
// $D/dsh-session-stats/lib/index.js:186-198
/** Cordis plugin name. */
const name = "session-stats";
/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
const inject = ["sessionProjections"];
function apply(ctx) {
  ctx.sessionProjections.register(sessionStatsProjectionDefinition);
}
export { apply, inject, name };
```

要点：
- **命名导出** `name` / `inject` / `apply` 即插件契约；`inject` 缺服务 ⇒ fiber 永远 pending、`apply` 不执行（静默）【文+实】。
- `ctx.sessionProjections.register(def)` 本身是 effect（登记在调用方 fiber 上）：插件卸载/热重载 ⇒ key 自动消失【实：`dsh-session-projection/lib/types/index.d.ts` register 注释】。
- 插件可以是函数插件（如上），也可以是 `Service` 类（`dsh-job-progress` 默认导出 `class JobProgressService extends TypertRemoteService`，`static inject = ['sessions']`）【实：`$PROFILE/dsh-job-progress/lib/index.js:229-259,543`】。

本 profile 的装配四件套（bundles 路径）【文：`~/.dsh/docs/kb/20-plugins.md`】：
`$PROFILE/package.json` 的 `dependencies["<pkg>"]:"link:$PLUGINS/<pkg>"` + `dsh.bundles` 数组 + 包内 `cordis.patch.yml` + `node_modules/<pkg>` junction。

### 2.2 会话事件信封 `SessionEvent`

【实】`dsh-session/lib/types/types.d.ts`：

```ts
// types.d.ts:246 附近（SessionEventEnvelope）
interface SessionEvent<K extends SessionEventType = SessionEventType> {
  readonly type: K;
  readonly seq: SessionSeq;          // 日志内单调递增
  readonly time: number;             // Unix epoch ms —— 唯一的时间源
  readonly data: SessionEventMap[K];
  readonly ignorable?: true;         // 外部插件事件的安全跳过标记
  // 仅 surface 事件另有 surfaceOp / sourceEventSeqs
}
```

> **`time` 是 ETA 的唯一可靠时间源**（不要用 host `Date.now()` 折叠，否则投影不可重放）。

### 2.3 事件词汇表全量（62 个）【实】

`dsh-session/lib/types/known-event-types.js:24-88`（GENERATED，`KNOWN_SESSION_EVENT_TYPES`）：

```
agent-preset/selected
agent/inbox/spliced
approval/asked
approval/decided
approval/policy
assistant/attempt
assistant/message
command/done
command/run
compaction/end
compaction/prune
compaction/start
compaction/summary
deliverables/presented
developer/message
feedback/message-delete
feedback/message-put
feedback/record
goal/change
hook/invoked
hook/result
image/offload
job/registered
job/settled
llm/retry
llm/retry-started
model/selection
permission/preset
plan/mode
request/context
request/header
sandbox/mode
schedule/change
session-log-deepseek/delivery-accepted
session/end-seed
session/title
session/title-llm-request
step/end
step/start
subagent/catalog
subagent/descriptor
subagent/model-selection-policy
system/message
team/member
team/message/delivered
team/message/queued
team/task
todo/write
tool-workflow/agent-end
tool-workflow/agent-start
tool-workflow/run-end
tool-workflow/run-start
tool/call
tool/ptc-dispatch
tool/ptc-dispatch-start
tool/result
turn/end
turn/start
user/message
web/deepseek-search-llm-request
working-directory/change
workspace/changes
```

（共 62 项，已按字母序排列；与 `known-event-types.js:24-88` 的 Set 逐项核对一致。外部插件自定义事件**不在此表**，必须带 envelope 的 `ignorable: true` 才能被读取路径容忍。）

**进度插件相关度分级**：

| 事件 | 进度用途 |
|---|---|
| `turn/start` / `turn/end` | 轮次开始/结束、运行态、总耗时 |
| `step/start` / `step/end` | ★ step 计数（**`step/end` 是 step 生命周期唯一权威**，见下） |
| `assistant/message` | ★ usage（token）+ 模型调用完成（llmMs） |
| `tool/call` / `tool/result` | ★ 在飞工具数、工具耗时、当前工具名 |
| `todo/write` | ★★ 语义进度（完成比）——最有价值的"总工作量"信号 |
| `goal/change` | goal 轮次 `roundsStarted` / `maxGoalRounds` |
| `request/context` | ★ 上下文窗口 `contextWindow`（只在变化时记录） |
| `compaction/start` / `compaction/end` | "正在压缩上下文"状态 |
| `approval/asked` / `approval/decided` | "等待审批"状态（payload 未读，§10） |
| `llm/retry` / `llm/retry-started` | 重试提示（payload 未读，§10） |
| `plan/mode` | 计划模式（payload 未读；有 `plan` 投影可直接用） |
| `session/title`、`workspace/changes` 等 | 与本插件无关 |

> **重要**：官方 `dsh-session-stats` 注释原文（`$D/dsh-session-stats/lib/index.js:10-20`）：
> "`step/end` — not `assistant/message` — is the counted step event because it is the step lifecycle
> authority: the loop appends exactly one per entered step, in a `finally`, so completed, failed,
> cancelled, and max-tokens steps all land one."【实】

### 2.4 核心 payload 的 TypeScript 形状【实】

`dsh-session/lib/types/types.d.ts`（`SessionEventMap` 主体 :256-436，逐段核对）：

```ts
// —— 轮/步 ——
'turn/start': { turn: number }                                    // :263
'turn/end':   { turn: number; reason: TurnEndReason }             // :274
'step/start': { turn: number; step: number }                      // :279
'step/end':   { turn: number; step: number }                      // :284

// —— 可见消息 ——
'user/message':      UserMessage                                  // :294（整条消息，含 content/source）
'developer/message': { turn: number; step: number; message: DeveloperMessage; headerSeq?: SessionSeq }  // :300
'system/message':    { turn: number; step: number; message: SystemMessage }                            // :316

// —— 模型输出 ——
'assistant/message': {
  turn: number;
  step: number;
  message: AssistantMessage;
  stream: AssistantStreamRecord[];   // 精确到 token 的时间流（首 token 时间可从这取）
  usage?: TokenUsage;                // ★ 该 step 的 token 账本；适配器未报则缺失
  interrupted?: true;                // 回合因取消中断时，已投递前缀的标记
}                                                                    // :337-346
'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[] }  // :352

// —— 工具 ——
'tool/call': {
  turn: number; step: number;
  callId: ToolCallId;
  name: string;
  arguments: string;                 // ★ 模型原始 JSON 字符串（未解析）
}                                                                    // :363-369
'tool/result': {
  turn: number; step: number;
  message: ToolResultMessage;        // message.source.callId 与 call 配对
  error?: { name: string; code: string; reason?: string };  // 仅在 isError:true 时
  meta?: JsonValue;                  // 工具私有的展示载荷（JSON 可序列化）
}                                                                    // :380-391

// —— 请求上下文（上下文窗口来源）——
'request/header':  { header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true }  // :400
'request/context': RequestContext；只在 route/capacity/systemPrompt 变化时记录         // :405
'session/end-seed': { inherited?: true }                                                     // :436
```

`TurnEndReasonMap`（:166-211，merge-extensible）【实】：

```ts
export interface TurnEndReasonMap {
  completed:   { kind: 'completed' };
  aborted:     { kind: 'aborted'; reason: TurnEndCancelCause };   // AgentCancelCause | {kind:'legacy'}
  blocked:     { kind: 'blocked' };
  error:       { kind: 'error'; error: LlmFailure };              // 结构化失败；扁平化时为 code:'UNKNOWN'
  'max-tokens':{ kind: 'max-tokens' };
  interrupted: { kind: 'interrupted' };   // 崩溃后补写的 closer（loop 不实时发）
  forked:      { kind: 'forked' };        // fork 种子关闭源轮次（loop 不发）
}
export type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap];
```

`TokenUsage`（`dsh-llm/lib/types/message.d.ts:112-128`）【实】：

```ts
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
```

`RequestContext`（types.d.ts:231-240）【实】：

```ts
export interface RequestContext {
  provider: string;
  model: string;
  contextWindow?: number;        // ★ "Maximum combined request and response context in tokens, when advertised"
  systemPromptUpdate?: SystemPromptUpdate;
}
```

`TodoItem`（`dsh-tool-todo/lib/types/types.d.ts:16-24`）【实】：

```ts
interface TodoItem { content: string; status: 'pending' | 'in_progress' | 'completed' }
```

`todo/write` 是**整表快照**（latest-wins，jointly with 同名 `todos` 投影，:27-45）【实】。

`goal/change` 的 payload 由 `dsh-goal` 定义（`GoalChangeMeta`，含 `goal: GoalSnapshot`、`roundsStarted`、
`createdAt`、`updatedAt`；`GoalSnapshot` 含 `objective/phase/maxGoalRounds/blockedReason?`）；
**完整 operation 枚举本次未逐条读 ⇒ 未验证**（§10）。`GoalProjection` 形状【实，`dsh-goal/lib/types/types.d.ts:82-97`】：

```ts
interface GoalProjection {
  goal: GoalSnapshot;      // { objective, phase: 'active'|'paused'|'blocked'|'complete', maxGoalRounds, blockedReason? }
  roundsStarted: number;   // ★ 已开始的轮次
  createdAt: number;
  updatedAt: number;
}
```

### 2.5 订阅方式与"当前 session"

**Cordis 事件订阅**（推荐用于命令式逻辑；投影自动订阅，无需手写）【实，`dsh-session/lib/types/index.d.ts:26-71`】：

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/created'(this: Scoped<Session>, session: Session): void;
    'session/disposed'(this: Scoped<Session>, session: Session): void;
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;   // ★
    'session/flush'(this: Scoped<Session>, session: Session): Promise<void>;
  }
  interface Context { sessions: SessionStore }
}
```

用法：

```js
export const inject = ['sessions']
export function apply(ctx) {
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') { /* ... */ }
  })
}
```

**历史事件同步读取：官方已废弃**。`Session.eventAt()` / `Session.snapshotEvents()` / `Session.ownEvents()`
在 0.2.1 被标记 deprecated（设计文档：
`$D/dsh-session/../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`，
**该路径在安装目录外，未直接打开**；deprecation 标记本身在 `lib/types/index.d.ts` 的 JSDoc 里）【实+推】。
替代路径：**订阅 `session/event`** 或用 **`ctx.sessionProjections.snapshot(session)`**（同步、整切、带 `asOfSeq`）【实】。
> 结论：进度插件**绝不轮询历史**；fold 交给投影。

**"当前 session"在 host 不存在全局概念**：Session 并行独立，UI 的"当前会话"是 client 侧概念。
host 侧任何按会话的入口都必须显式传 `sessionId`（`dsh-job-progress` 的 Remote 方法即如此：
`connection.rpc.call('/api', 'jobProgress/snapshot', { sessionId })`，`$PROFILE/dsh-job-progress/lib/client.js:233-249`）【实】。
**投影方案天然按 session 分片**，client 组件 props 自带 `sessionId`，因此无需"当前会话"逻辑。

`SessionStore` 关键方法【实，`dsh-session/lib/types/index.d.ts`（SessionStore 段）】：
`get(id): Session | undefined`（仅 live 会话）、`list(): Session[]`、`flush(session): Promise<boolean>`；
`Session`：`id`、`header: SessionHeader`、`seq`、`firstLiveSeq`、`inheritedEventCount`、`append(type,data,opts)`。

### 2.6 Agent / turn 生命周期（"是否正在生成"）

- `AgentStatus = 'idle' | 'running'`；`idle` = 无 driver 活动；`running` = 从唤醒输入开始 pre-step 到
  driver 排空/关闭/检查点。**disposal 不算 status 变化**【实，`dsh-agent/lib/types/runtime-types.d.ts:84-89`】。
- Cordis 事件 `'agent/status'`：`{ agent: Agent; status: AgentStatus }`（另有 `'agent/inbox/inserted'` 等）【实，`dsh-agent/lib/types/runtime-types.d.ts`】。
- **client 侧权威运行信号**：`SessionSnapshot.running: boolean`
  【实，`dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts:58-80`】。
  slot 组件里：`props.useSession(s => s.running)`（selector hook）；全局 slot 里可用 `props.useSessionStatus()`。
- turn 层面：`running === true` 且最近事件是 `turn/start` 未配 `turn/end` ⇒ 本轮进行中。
  投影 fold 里用 `turn/start` / `turn/end` 自行维护 `running` 与 `lastEndReason` 即可（与 client 的
  SessionSnapshot 互为校验）。

### 2.7 Token / usage / 上下文窗口

| 数据 | 来源 | client 可见 | wire 形状 |
|---|---|---|---|
| 每次模型调用 usage | `assistant/message.data.usage`（`TokenUsage`） | ✓（event 里就有） | `{inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?}` |
| 累计 token 账本 | 投影 `tokenUsage` | ✓ **有 wire view** | `TokenUsageProjection { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }` |
| 上下文占用 | 投影 `contextPressure` | ✓ **有 wire view** | `ContextPressureProjection { pressureTokens?, projectedTokens?, contextWindow? }` |
| 上下文构成 | 投影 `contextBreakdown` | ✓ **有 wire view** | `{ systemTokens, toolsTokens, messageTokens }`（启发式估算） |
| 上下文窗口 | `request/context.data.contextWindow`（变化时才记录） | ✓（可自行 fold 保留最后一个值） | `number` |
| 成本估算 | 投影 `costUsage`（`dsh-cost-meter`） | ✓ | token 桶按模型拆分 |

> **修正（重要）**：`dsh-token-meter/lib/types/projection.d.ts:64-72` 同时声明了
> `SessionProjectionMap { tokenUsage; contextPressure; contextBreakdown }` ⇒ 三个 key **client 可见**
> （该文件头注释自述 "Pure client-safe token-projection vocabulary"）【实】。
> 所以进度条显示"上下文占用 %"**直接 `props.useProjection('contextPressure')` 即可**：
> `pct = pressureTokens / contextWindow`，无需自己 fold；只有需要"本轮新增 token"这类
> 跨投影聚合时，才在自有投影里 fold `assistant/message.usage`。
>
> `contextPressure` 语义（源码注释原文，`projection.d.ts:23-52`）【实】：
> - `pressureTokens` = **最近一次请求**的 prompt 大小（未缓存输入 + cache 读 + cache 写；不含响应输出）；
>   两次请求之间不随流式输出增长。
> - `projectedTokens` = 下一次请求的预估成本（= pressureTokens + 表面新增/压缩后的启发式 delta），
>   用于 context 占用条更实时。
> - `contextWindow` = 最新记录的 route 容量；无适配器上报则缺失。
> - 注意：三个字段是**不同时刻的 last-wins 记录**，非同一请求的原子快照（换模型时可能"新容量 + 旧压力"），
>   官方明说这是 user-facing reference，不用于计费/门控。

### 2.8 现成投影清单（可直接复用/参考）【实】

| key | 包 | client 可见 | 值形状 | 对本插件 |
|---|---|---|---|---|
| `todos` | `dsh-tool-todo` | ✓ | `TodoItem[] \| null` | ★ 直接 useProjection 渲染清单 |
| `goal` | `dsh-goal` | ✓ | `GoalProjection \| null` | ★ goal 轮次进度 |
| `plan` | `dsh-plan-mode` | ✓ | `{ active: boolean; pending: boolean }` | 计划模式徽标 |
| `sessionStats` | `dsh-session-stats` | ✓ | `{ turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }` | ★ ETA 校准 |
| `turnOutline` | `dsh-session-turn-outline` | ✓ | `TurnOutlineEntry[]` | 轮次摘要（也可自己 fold） |
| `costUsage` | `dsh-cost-meter` | ✓ | token 桶按模型拆分 | 成本显示 |
| `tokenUsage` / `contextPressure` / `contextBreakdown` | `dsh-token-meter` | ✓ | 见 §2.7 | ★ 上下文占用 % 直接取用 |
| `inbox` / `userQuestions` / `subagentCatalog` / `agentTeam` / `sessionStats`… | 各包 | 视包 | — | 与本插件无关 |

---

## 3. 会话投影机制（推荐数据通道）

### 3.1 `ProjectionDefinition` 契约【实，`dsh-session-projection/lib/types/index.d.ts`】

```ts
interface ProjectionDefinition<K, S> {
  key: K;                                    // 投影 key（SessionProjectionStateMap 的键）
  stateSchema: ZodType<S>;                   // 校验持久化缓存/输入
  init(header: SessionHeader, inheritedEventCount: SessionLogOffset): S;
  /**
   * 纯同步 fold：prev state + 一个已提交事件 → next state。
   * 本 unit 不关心的事件必须 return 同一引用（Object.is 相等 ⇒ 零下游工作）。
   */
  apply(state: S, event: SessionEvent): S;
  wire?: {                                   // 省略 = host-only
    viewSchema: ZodType<SessionProjectionMap[K]>;
    view(state: S): SessionProjectionMap[K]; // 纯函数；对象值请复用引用以免内部变化也推送
  };
  stateVersion: number;                      // 持久化缓存失效版本；state 字段/语义变了必须 +1
}
```

关键约束（原文注释）：所有函数**必须同步**（异步会撕裂 carrier 一致性切面）；`state` **必须是 plain JSON**
（持久化缓存前提）；注册是 effect，随 fiber 销毁 ⇒ key 从快照消失【实】。

### 3.2 注册表 API【实】

```ts
ctx.sessionProjections: SessionProjectionRegistry extends Service
  register(definition): () => void          // wire 非空 → client-visible；wire 省略 → host-only
  onChanged(listener: (session, key, value, seq) => void): () => void
  stateOf(session, key): S | undefined      // host 读：materialize 该 session 全部 unit
  snapshot(session, keys?): { asOfSeq, values }   // 同步整切（所有 client-visible unit）
  cachedSnapshot(session, keys?) / checkpoint(session) / restore(...) / ...
```

> **运行时只调用 `stateSchema.parse()` / `viewSchema.parse()`**（`$D/dsh-session-projection/lib/index.js:254,258,296,304,421`）【实】。
> 推论【推】：JS 插件可用**鸭子类型 schema** `{ parse: v => v }` 代替 zod，从而零运行时依赖；
> 若将来升级改为 `safeParse`，此技巧失效（列入风险 §9）。

### 3.3 推送链路（为什么 client 不需要任何请求代码）【实】

1. host：注册表 eager drive 所有 unit；`apply` 改变状态且 `view` 结果 `Object.is` 变化时，
   触发 `onChanged`（`$D/dsh-session-projection/lib/index.js:414-432`）。
2. `dsh-api-session-controller` host 半边订阅 `onChanged`，把每个变化包成
   `{type:'projection', ...}` 帧 push 给订阅该 session 的客户端
   （`$D/dsh-api-session-controller/lib/index.js:1202` 附近；baseline 在 `snapshot(session)` :1238/1243）【实】。
3. client `projection-store` 是 **push 模型**：host 是唯一计算点，client 只存完成值；
   两类行：`sequenced { value, seq }`（follow baseline / 逐帧）与 `cached`（旧值，避免闪烁）
   【实，`$D/dsh-api-session-controller/lib/types/client/sessions/projection-store.d.ts` 头注释】。
4. slot 组件 `props.useProjection(key)` 从 store 取当前值 → React 重渲染。

**结论**：注册一个 client-visible 投影后，client 侧**一行网络代码都不用写**，数据自动随推送更新；
fork/restore/冷读由框架的 checkpoint 机制保证（`stateVersion` 不符则丢弃缓存重放）【实】。

### 3.4 方案对比与推荐

| 方案 | 代码量 | 实时性 | 多会话 | 冷启动/分页 | 风险 |
|---|---|---|---|---|---|
| **A. 投影 + `useProjection`（推荐）** | 极小 | 事件级即时（push） | 天然按 session | 框架保证（缓存+重放） | 需遵守 fold 契约（纯/JSON/stateVersion） |
| B. Remote RPC 轮询（`/api`） | 中（host 服务 + client 轮询） | 2-10s 级 | 需自行传 sessionId | 自己处理 | 轮询压力、与模型争一次性流（job-progress 已踩坑） |
| C. 自建 REST/SSE（`ctx.webServer`） | 中 | SSE 可即时 | 自行处理 | 自己处理 | 鉴权/LAN 围栏/CSRF；**最不建议** |

**推荐 A**；仅当需要**非会话事件数据**（宿主时钟、文件系统、进程指标）时，才增加 B 作为补充。

### 3.5 备选 B：Remote RPC 骨架（`dsh-job-progress` 实证）【实】

`$PROFILE/dsh-job-progress/lib/index.js`：`import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'`，
类 `extends TypertRemoteService`、`static inject=['sessions']`、方法用 `@Remote('snapshot')` 装饰、
endpoint 命名为 `<namespace>/<method>`（此处 `jobProgress/snapshot`）；默认导出该 Service 类。
注意该文件**手写了 stage-3 装饰器的 `__esDecorate` 转译辅助**（:24-60）——外部插件若用装饰器需自行处理，
或改用其 `TypertRemoteService` 提供的非装饰器注册方式（**未验证**，需通读该文件）。

client 调用侧【实，`$PROFILE/dsh-job-progress/lib/client.js:233-249`】：

```js
const result = await connection.rpc.call('/api', 'jobProgress/snapshot', { sessionId })
// 轮询：POLL_MS = 2000，空闲 POLL_IDLE_MS = 10000
```

### 3.6 备选 C：host REST 路由（不推荐，骨架供极端情况）【实 API + 推用法】

`$D/dsh-host-webserver/lib/types/index.d.ts`：`ctx.webServer: WebServer`；
`WebRoute { kind: 'exact'|'prefix'; path: string; ... }`；事件 `'webserver/index-inject'`。
**本环境 GUI 经 `:3080` + `/api` 网关 + LAN 围栏，插件自建路由需自行处理鉴权与跨域**；本 profile 的
既有插件全部走 Remote 网关而非自建路由 ⇒【推】自建路由是"最后手段"，冷/热更新与 LAN 围栏都可能踩坑。

---

## 4. Client 侧：bundle 格式、slot、取数

### 4.1 client bundle 契约（手写 module-loader，无打包步骤）【实】

`$PROFILE/dsh-job-progress/lib/client.js:1-20`（原文，这是本 profile 唯一未压缩的可读 client 范例）：

```js
/**
 * Hand-written against the module-loader contract (no bundler step): the shell
 * evaluates this file, the factory receives `require`, and the exported `apply`
 * runs with the client root context.
 */
window.__ModuleLoader__.load({
  id: 'dsh-job-progress',
  factory: (require) => {
    // 模块加载器契约：factory 收到 require，必须返回 module.exports。下面两行不能省 ——
    // 2026-09-20 就是漏了它们：客户端半边一加载就抛 ReferenceError: exports is not defined，
    // 渲染层的插件图随之崩掉、界面起不来，而宿主半边照常挂载、日志里一条异常都没有。
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    // ...
    exports.apply = apply;
    exports.inject = inject;   // client 服务依赖：['sessions','slots','locale','connection','jobs']
    return module.exports;
  }
});
```

要点：
- **不是 ESM**：不写 `import/export`；由 shell 以脚本求值，`window.__ModuleLoader__.load({id, factory})`。
- factory 内可用 `require('react')`（loader 提供）。
- **必须** `const module={exports:{}}; const exports=module.exports; ... return module.exports`，
  并在 `module.exports` 上挂 `apply`（函数）与 `inject`（数组）。
- `inject` = **client 服务名**（`slots`/`locale`/`sessions`/`connection`/`jobs`…）。缺任一服务 ⇒
  fiber 永远 pending ⇒ `apply` 不执行、无报错（静默失败）。
- package.json 需 `"exports": { "./client": "./lib/client.js" }` 与
  `"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-connection", ...] } }`
  （后者是**要预先加载的 client 插件包**，不是服务名）【实：job-progress package.json】。
  entry 文件的解析细节（loader 用 `exports['./client']`？）【推】。

### 4.2 可插入的 slot 全清单（`conversation.*`）【实】

`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`（`declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap }`）：

| slot 名 | kind | scope | 位置/语义 | 进度条适配 |
|---|---|---|---|---|
| **`conversation.input.dock`** | list | session | **输入框（composer）上方的全宽条目** | ★★★★★ **首选** |
| `conversation.composer.dock` | list | session | composer 卡片下方的 ambient 条目 | ★★★★ 备选（常驻状态行） |
| `conversation.session.header.actions` | list | session | 会话头部右侧动作区（按钮/胶囊） | ★★★ 小徽标/可点开面板 |
| `conversation.session.header.utilities` | list | session | 头部工具区 | ★★ |
| `conversation.session.header.corner` | list | session | 头部角落 | ★★ |
| `conversation.input.overlay` | list | session | composer 卡片内浮层（绝对定位） | ★ 适合 popover，不宜常驻条 |
| `conversation.input.left` / `.right` | list | session | composer 工具行左/右的紧凑控件 | ★★ 小状态点 |
| `conversation.input.activity` | **single** | session | 模型选择器后的活动区（owner=InputActivityOwnerProps） | ✗ **single，被核心占用** |
| `conversation.composer.bar` | single | session-maybe | composer 主体 | ✗ 核心占用 |
| `conversation.session` | list | session | 会话根（整列） | ✗ 太粗 |
| `conversation.view` | list(tab) | session | 会话内页签（如 dsh-context 的"上下文"页） | 详情页可考虑 |
| `conversation.chat.assistant-actions` | list | session | 助手消息动作区（dsh-context 用） | ✗ |
| `conversation.hero.*` / `main.conversation` / `header.*` | — | — | 新会话页/顶栏 | ✗ |

> 但**不要注册根 slot**（如 `conversation.content`/单例根）：`registry.d.ts` 注释明确"single slot 会遮蔽整个
> AppFrame"；全屏浮层用 `shell.overlay`（list，additive）【实：`$D/dsh-client-ui-renderer/lib/types/client/registry.d.ts`】。
> `shell.overlay` 亦可作为拖拽球类 UI 的位置（job-progress 没用 slot，直接固定定位——它注册的是 header.actions 触发器）。

**推荐**：进度条常驻 `conversation.input.dock`（order 10–20）；若要"折叠式详情"，另在
`conversation.session.header.actions` 挂一个状态胶囊（order 21，与 job-progress 同区不冲突）。

**本 profile 的 slot 占用实况（决定 order 取值）**【实，读 3 个插件的 client.js】：

| slot | 占用者 | id / order |
|---|---|---|
| `conversation.input.dock` | cost-meter | `cost-meter-qstrip` / 5 |
| `conversation.chat.turnTail` | cost-meter | `cost-meter-turn` / 10 |
| `conversation.chat.assistant-actions` | dsh-context | `context-jump` / 20 |
| `conversation.input.overlay` | dsh-context | `context-modal` / 10 |
| `conversation.session.header.actions` | job-progress | `job-progress` / 21 |
| `conversation.view` | dsh-context | `context` / 20（页签） |

⇒ 同 slot 不同 id **可共存**，order 只决定排列；本插件 `conversation.input.dock` 取 **order 12** 即可。

### 4.3 slot 注册 API（准确签名）【实】

`ctx.slots` 是 `SlotRegistry`（`$D/dsh-client-ui-renderer/lib/types/client/registry.d.ts:46`）。
两段式写法（官方 dsh-context / job-progress 均如此）：

```js
// 1) inject 声明"该 slot 存在时我要登记"；回调返回 disposer
ctx.slots.inject('conversation.input.dock', () =>
  // 2) register(spec, Component) → disposer
  ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'conv-progress',        // 全局唯一；同 slot 同 id 同 order 重复注册会抛错
    order: 12,                  // 升序排列
    locale: NS,                 // 绑定 locale 命名空间 ⇒ 组件 props.t 可用
    // inject: (props) => ({ hooks: {...} })   // 可选：给组件注入额外 props/hooks
  }, ConvProgressBar)
)
```

`ctx.effect(() => ..., 'label')` 用于样式/字典等副作用（返回 disposer）【实：job-progress client.js:499-500】。

**`register` 规格字段（从 3 个真实插件反推，均已运行验证）**【实】：

| 字段 | 类型 | 说明 | 实例 |
|---|---|---|---|
| `name` | slot key 字符串 | 必须与 `slots.inject` 的 key 一致 | 全部 |
| `id` | string | 全局唯一；同 slot 同 id 重复注册抛错 | `job-progress`、`context-modal` |
| `order` | number | 升序排列（小在前） | job-progress 21、dsh-context 10/20、cost-meter 5 |
| `locale` | string | 绑定 locale 命名空间 ⇒ 组件 `props.t` 可用 | job-progress `locale: NS` |
| `label` | `() => string` | 页签类 slot 的显示名 | dsh-context `conversation.view` |
| `key` | string | 页签/配置类 slot 的二级键 | dsh-context `conversation.view` / `plugins.bundle.config` |
| `inject` | `(props) => object` | 给组件注入额外 props/hooks（不得覆盖标准 seat） | cost-meter、dsh-context |

真实注册片段（可直接对照）【实】：

```js
// $PROFILE/dsh-job-progress/lib/client.js:501-506 —— header.actions 胶囊按钮
ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
  name: 'conversation.session.header.actions', id: 'job-progress', order: 21, locale: NS
}, JobProgressAction))

// $PROFILE/dsh-cost-meter/lib/client.js —— 输入框上方（★ 与本插件同一 slot，order 5）
//   .register({name:'conversation.input.dock', id:'cost-meter-qstrip', order:5, inject: ...})
// dsh-context client —— 浮层 + 页签
//   slots.register({name:'conversation.input.overlay', id:'context-modal', order:10, locale:NS, inject: ...})
//   slots.register({name:'conversation.view', id:'context', order:20, locale:NS, label:()=>t('tab.context')})
```

`SlotRegistry` 的公开方法（`registry.d.ts:85-211`）【实】：
`register`（类型面 `SlotCore['register']`）、`registerFactory`、`inject(key, cb)`、`entries(key)`、
`entriesOfSlot(key)`、`snapshot(root?)`、`subscribe(key, fn)`、`getVersion(key)`、`onEntryError(fn)`、
`install(renderer)` / `installLocale(face)`（boot-once，shell / locale 插件专用）、`provideRoot`、
`installScope`、`bindStoreScope`。

**必须知道的两条实现细节**（源码注释原文，`registry.d.ts:69-84`）【实】：
- `register` / `registerFactory` **必须保持 prototype 方法**（不能写成实例箭头属性）：Cordis service proxy
  在调用时把 `this.ctx` 绑定到**调用方 plugin 的 ctx**，注册因此挂在调用方 fiber 上、随插件卸载自动回收。
  写成箭头函数会冻结到 service 自己的 root ctx ⇒ 卸载泄漏。
- `inject` 回调：slot **已声明** ⇒ 同步执行；**未声明** ⇒ 等声明提交后执行；声明被折叠 ⇒ dispose 并等待下次声明。
  注册与声明注入都走调用方 `ctx.effect` ⇒ 插件卸载 = 级联注销（无需手写 disposer）。

### 4.4 slot 组件 props（client 取数入口）【实】

`dsh-client-ui-session/lib/types/client/index.d.ts:68-100`（`declare module '@deepseek-ai/dsh-client-ui-slots'`）：

```ts
interface SessionStandardProps {           // scope:'session' 的 slot 组件
  sessionId: SessionId;                    // ★ 当前会话 id
  useSession: SessionSnapshotSelector;     // props.useSession(s => s.running)
  useProjection: UseProjection;            // ★ props.useProjection('convProgress')
  useAccess: (action: RemoteEndpoint) => boolean;
}
interface SessionMaybeStandardProps {      // scope:'session-maybe'
  sessionId: SessionId | undefined;
  useSession: MaybeSnapshotSelectorHook<SessionSnapshot>;
  useProjection: UseProjection;            // 无 session 时各 key 均 undefined
  useAccess: ...;
}
interface GlobalStandardProps {            // 全局 slot
  useSessions: UseSessions;
  useSessionStatus: UseSessionStatus;
  useSessionRetainInfo: UseSessionRetainInfo;
  useSessionAccess: ...;
}
```

`UseProjection` 签名【实，`dsh-api-session-controller/lib/types/client/sessions/projection-store.d.ts:28-31`】：
`<K>(key: K): SessionProjectionMap[K] | undefined`；带 selector 的重载：
`<K,S>(key: K, selector: (v) => S, eq?) => S`。
> 手写 JS 不受 TS 键名约束：**任意 string key 运行时都可用**（服务端注册了什么就能取到什么；
> 未注册/未加载 = `undefined`，据此做优雅降级）。

`SessionSnapshot`（client）关键字段【实，`snapshot.d.ts:58-80`】：
`sessionId`、`running`（★ 是否正在生成）、`awaitingFirstTurn`、`openState`、`lastAgentError`、
`removed`、`blank`、`pendingSubmissions` 等。

### 4.5 官方可读范例的完整 apply（dsh-context，压缩后仍可辨认）【实】

```js
// $PROFILE/dsh-context/lib/client.js（压缩，已格式化）
function apply(ctx) {                       // exports = { name:'dsh-context', inject:['slots','locale'], apply }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `dsh-context: dictionaries`);
  const t = ctx.locale.bind(NS);
  ...
  ctx.slots.inject('conversation.input.overlay', () =>
    ctx.slots.register({
      name: 'conversation.input.overlay', id: 'context-modal', order: 10, locale: NS,
      inject: (e = '') => ({ hooks: { contextModal: O(e) } })
    }, e => React.createElement(c, e)));
  ctx.inject(['configForms'], ...)          // 可选服务用 ctx.inject 兜底
}
```

---

## 5. 完整骨架代码

### 5.1 Host 采集骨架（可直接落盘 `lib/index.js`）

```js
// $PLUGINS/dsh-conv-progress/lib/index.js
// 零运行时依赖：不 import 任何包；schema 用鸭子类型（注册表运行时只调用 .parse，见 §3.2）。
// 导出契约与官方 dsh-session-stats 一致：命名导出 name / inject / apply。

export const name = 'dsh-conv-progress'

// 只依赖投影注册表；缺它 fiber 保持 pending、apply 不执行（静默，见 §2.1）
export const inject = ['sessionProjections']

/** 运行时只调用 .parse()，故可零依赖（【推】：若升级改用 safeParse 需改回 zod） */
const passthroughSchema = { parse: (value) => value }

const STEP_WINDOW = 40   // 保留最近 40 步耗时
const TURN_WINDOW = 8    // 保留最近 8 轮耗时

function initialState() {
  return {
    turn: 0,
    step: 0,
    running: false,          // 本轮是否进行中（turn/start 未配 turn/end）
    compacting: false,
    turnStartedAt: 0,
    stepStartedAt: 0,        // 最近一次 step/start 的时间
    lastEventAt: 0,
    stepMs: [],              // 已完成 step 的耗时样本（最近 N 个）
    turnMs: [],              // 已完成 turn 的总耗时样本（最近 N 个）
    stepsTotal: 0,
    stepsThisTurn: 0,
    toolsTotal: 0,
    toolsInFlight: [],       // [{ callId, name, startedAt }] —— JSON 数组，不用 Set/Map
    todoDone: 0,
    todoInProgress: 0,
    todoTotal: 0,
    goalRound: 0,
    goalMax: 0,
    contextWindow: 0,
    contextTokens: 0,        // 最近一次 assistant/message 的输入侧 token 近似值
    outputTokens: 0,
    lastEndReason: null,
    seq: -1
  }
}

/** 只保留最近 n 项 */
function push(list, value, n) {
  const next = list.concat([value])
  return next.length > n ? next.slice(next.length - n) : next
}

function average(list) {
  if (list.length === 0) return null
  let sum = 0
  for (const v of list) sum += v
  return sum / list.length
}

const definition = {
  key: 'convProgress',
  stateVersion: 1,
  stateSchema: passthroughSchema,

  init: () => initialState(),

  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return {
          ...state,
          turn: event.data.turn,
          step: 0,
          stepsThisTurn: 0,
          running: true,
          turnStartedAt: event.time,
          stepStartedAt: 0,
          toolsInFlight: [],
          lastEventAt: event.time,
          seq: event.seq
        }

      case 'step/start':
        return {
          ...state,
          turn: event.data.turn,
          step: event.data.step,
          stepStartedAt: event.time,
          lastEventAt: event.time,
          seq: event.seq
        }

      case 'step/end': {
        const stepMs = state.stepStartedAt > 0 ? Math.max(0, event.time - state.stepStartedAt) : null
        return {
          ...state,
          stepsTotal: state.stepsTotal + 1,
          stepsThisTurn: state.stepsThisTurn + 1,
          stepMs: stepMs === null ? state.stepMs : push(state.stepMs, stepMs, STEP_WINDOW),
          stepStartedAt: 0,
          lastEventAt: event.time,
          seq: event.seq
        }
      }

      case 'tool/call':
        return {
          ...state,
          toolsTotal: state.toolsTotal + 1,
          toolsInFlight: state.toolsInFlight.concat([{
            callId: event.data.callId,
            name: event.data.name,
            startedAt: event.time
          }]),
          lastEventAt: event.time,
          seq: event.seq
        }

      case 'tool/result': {
        const callId = event.data.message?.source?.callId
        return {
          ...state,
          toolsInFlight: state.toolsInFlight.filter((t) => t.callId !== callId),
          lastEventAt: event.time,
          seq: event.seq
        }
      }

      case 'assistant/message': {
        const usage = event.data.usage
        if (!usage) return { ...state, lastEventAt: event.time, seq: event.seq }
        // 【推】近似上下文占用；精确值需对照 dsh-token-meter 的 pressure 定义（§2.7）
        const contextTokens =
          (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        return {
          ...state,
          contextTokens,
          outputTokens: state.outputTokens + (usage.outputTokens ?? 0),
          lastEventAt: event.time,
          seq: event.seq
        }
      }

      case 'request/context': {
        const window = event.data.contextWindow
        if (typeof window !== 'number' || !Number.isFinite(window)) {
          return { ...state, lastEventAt: event.time, seq: event.seq }
        }
        return { ...state, contextWindow: window, lastEventAt: event.time, seq: event.seq }
      }

      case 'todo/write': {
        const todos = Array.isArray(event.data.todos) ? event.data.todos : []
        let done = 0
        let inProgress = 0
        for (const todo of todos) {
          if (todo?.status === 'completed') done += 1
          else if (todo?.status === 'in_progress') inProgress += 1
        }
        return {
          ...state,
          todoTotal: todos.length,
          todoDone: done,
          todoInProgress: inProgress,
          lastEventAt: event.time,
          seq: event.seq
        }
      }

      case 'goal/change': {
        // 【未验证】goal/change 的完整 operation 枚举未逐条读（§10）；这里按 GoalProjection 字段防御性读取
        const goal = event.data?.goal
        if (!goal) {
          return { ...state, goalRound: 0, goalMax: 0, lastEventAt: event.time, seq: event.seq }
        }
        return {
          ...state,
          goalRound: typeof event.data.roundsStarted === 'number' ? event.data.roundsStarted : state.goalRound,
          goalMax: typeof goal.maxGoalRounds === 'number' ? goal.maxGoalRounds : state.goalMax,
          lastEventAt: event.time,
          seq: event.seq
        }
      }

      case 'compaction/start':
        return { ...state, compacting: true, lastEventAt: event.time, seq: event.seq }

      case 'compaction/end':
        return { ...state, compacting: false, lastEventAt: event.time, seq: event.seq }

      case 'turn/end': {
        const turnMs = state.turnStartedAt > 0 ? Math.max(0, event.time - state.turnStartedAt) : null
        return {
          ...state,
          running: false,
          compacting: false,
          lastEndReason: event.data.reason?.kind ?? 'completed',
          turnMs: turnMs === null ? state.turnMs : push(state.turnMs, turnMs, TURN_WINDOW),
          turnStartedAt: 0,
          stepStartedAt: 0,
          toolsInFlight: [],
          lastEventAt: event.time,
          seq: event.seq
        }
      }

      // 不重要的事件：必须返回同一引用（零下游工作）
      default:
        return state
    }
  },

  wire: {
    viewSchema: passthroughSchema,
    // 纯函数：只从 state 推导，不读 Date.now()（时间来自 event.time / lastEventAt）
    view: (state) => {
      const stepAvg = average(state.stepMs)          // ms；样本不足 → null
      const turnAvg = average(state.turnMs)

      // —— 进度百分比：有 todo 时用完成比（确定性），否则 indeterminate ——
      let mode = 'indeterminate'
      let pct = null
      if (state.todoTotal > 0) {
        mode = 'determinate'
        pct = (state.todoDone + 0.5 * state.todoInProgress) / state.todoTotal
        if (pct < 0) pct = 0
        if (pct > 1) pct = 1
      } else if (state.goalMax > 0) {
        mode = 'determinate'
        pct = Math.min(1, Math.max(0, state.goalRound / state.goalMax))
      }

      // —— ETA（启发式，见 §6；无样本返回 null 表示"无法估计"）——
      let etaMs = null
      if (state.running && stepAvg !== null) {
        const inStepElapsed = state.stepStartedAt > 0 ? Math.max(0, state.lastEventAt - state.stepStartedAt) : 0
        const thisStepLeft = Math.max(0, stepAvg - inStepElapsed)
        const pendingTodos = Math.max(0, state.todoTotal - state.todoDone - state.todoInProgress)
        // 经验：一个 pending todo ≈ 1 个 step 的量级（【推】，需用真实会话校准）
        etaMs = pendingTodos > 0 ? thisStepLeft + pendingTodos * stepAvg : thisStepLeft
      }

      return {
        turn: state.turn,
        step: state.step,
        stepsTotal: state.stepsTotal,
        stepsThisTurn: state.stepsThisTurn,
        running: state.running,
        compacting: state.compacting,
        mode,
        pct,
        etaMs,
        // 已用时间：运行中 = 上次事件距本轮开始；空闲 = 最近一轮时长均值
        elapsedMs: state.running
          ? Math.max(0, state.lastEventAt - state.turnStartedAt)
          : Math.round(average(state.turnMs) ?? 0),
        updatedAt: state.lastEventAt,          // ★ client 用它扣减 ETA 倒计时
        stepAvgMs: stepAvg === null ? null : Math.round(stepAvg),
        turnAvgMs: turnAvg === null ? null : Math.round(turnAvg),
        tools: {
          total: state.toolsTotal,
          inFlight: state.toolsInFlight.length,
          last: state.toolsInFlight.length > 0 ? state.toolsInFlight[state.toolsInFlight.length - 1].name : null
        },
        tokens: {
          context: state.contextTokens,
          contextWindow: state.contextWindow,
          output: state.outputTokens
        },
        todos: {
          done: state.todoDone,
          inProgress: state.todoInProgress,
          total: state.todoTotal
        },
        goal: { round: state.goalRound, max: state.goalMax },
        lastEndReason: state.lastEndReason
      }
    }
  }
}

export function apply(ctx) {
  ctx.sessionProjections.register(definition)
}
```

> 说明：host 骨架里 fold 了 `contextTokens` / `contextWindow`，只是为演示"单帧聚合"；
> 若 UI 只需上下文占用百分比，**删掉这两段 fold**，client 直接 `useProjection('contextPressure')`
> 取官方值更准（§2.7）。`wire.view` 里 JSON 值请保持小对象（< 1KB）并复用引用以抑制无谓推送（§3.1）。

TypeScript 工程需补模块增强（否则 `register` 类型不通过）【实：各包 d.ts 的写法】：

```ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { convProgress: ConvProgressState }
  interface SessionProjectionMap { convProgress: ConvProgressWire }   // 需要 client 可见才写这行
}
```

### 5.2 Client 渲染骨架（可直接落盘 `lib/client.js`）

```js
// $PLUGINS/dsh-conv-progress/lib/client.js
// 手写 module-loader 契约（无打包步骤）。★ 三处契约不能漏：module/exports 两行、返回 module.exports、导出 apply+inject。
window.__ModuleLoader__.load({
  id: 'dsh-conv-progress',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const NS = 'convProgress'
    const CSS_ID = 'dsh-conv-progress'

    const zh = {
      'bar.title': '对话进度',
      'bar.idle': '空闲',
      'bar.running': '进行中',
      'bar.step': '第 {n} 步',
      'bar.tools': '{n} 个工具执行中',
      'bar.tool': '正在执行 {name}',
      'bar.eta': '预计剩余 {time}',
      'bar.elapsed': '已用 {time}',
      'bar.todos': '任务 {done}/{total}',
      'bar.goal': '目标 {round}/{max}',
      'bar.compacting': '正在压缩上下文…',
      'bar.waiting': '等待审批',
      'bar.done': '本轮完成',
      'bar.aborted': '本轮中断',
      'bar.error': '本轮出错',
      'bar.interrupted': '会话恢复'
    }
    const en = {
      'bar.title': 'Conversation progress',
      'bar.idle': 'Idle',
      'bar.running': 'Working',
      'bar.step': 'step {n}',
      'bar.tools': '{n} tool calls running',
      'bar.tool': 'running {name}',
      'bar.eta': '~{time} left',
      'bar.elapsed': '{time} elapsed',
      'bar.todos': 'tasks {done}/{total}',
      'bar.goal': 'goal {round}/{max}',
      'bar.compacting': 'compacting context…',
      'bar.waiting': 'waiting for approval',
      'bar.done': 'turn complete',
      'bar.aborted': 'turn aborted',
      'bar.error': 'turn failed',
      'bar.interrupted': 'recovered session'
    }

    /**
     * 样式只注入一次；用 data-plugin-css 做去重键（与官方 dsh-context 一致）。
     * 颜色全部走主题令牌，暗色/亮色自动适配。
     */
    function injectStyles() {
      const selector = `style[data-plugin-css=${JSON.stringify(CSS_ID)}]`
      if (typeof document === 'undefined' || document.querySelector(selector) !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = CSS_ID
      style.dataset.pluginCss = CSS_ID
      style.textContent = `
        .dcp-root { display: flex; align-items: center; gap: 8px; padding: 0 2px 6px;
          color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.4; }
        .dcp-root[hidden] { display: none; }
        .dcp-track { position: relative; flex: 1 1 auto; min-width: 60px; height: 4px;
          border-radius: 999px; overflow: hidden;
          background: color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent); }
        .dcp-fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px;
          background: var(--dsw-alias-brand-primary);
          transition: width var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out); }
        .dcp-fill-indeterminate { width: 35%; animation: dcp-slide 1.4s ease-in-out infinite; }
        @keyframes dcp-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
        .dcp-meta { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
        .dcp-name { max-width: 14em; overflow: hidden; text-overflow: ellipsis;
          color: var(--dsw-alias-label-primary); }
        .dcp-eta { font-variant-numeric: tabular-nums; }
        .dcp-dot { width: 6px; height: 6px; border-radius: 50%; flex: none;
          background: var(--dsw-alias-state-success-primary); }
        .dcp-dot-idle { background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
        .dcp-dot-warn { background: var(--dsw-alias-state-warn-primary); }
        .dcp-dot-error { background: var(--dsw-alias-state-error-primary); }
        @media (prefers-reduced-motion: reduce) { .dcp-fill { transition: none; } .dcp-fill-indeterminate { animation: none; } }
      `
      document.head.appendChild(style)
    }

    /** ms → "1m 23s" / "12s"；超过 1 小时显示 "1h 02m" */
    function formatDuration(ms) {
      const total = Math.max(0, Math.round(ms / 1000))
      if (total < 60) return `${total}s`
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
      const hours = Math.floor(minutes / 60)
      return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
    }

    /** 迷你 i18n：支持 {name} 占位符；t 由 slot 的 locale 提供，缺失时回退 */
    function interpolate(template, params) {
      return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''))
    }

    /**
     * 进度条组件。props（SessionStandardProps）：
     *   sessionId、useSession(selector)、useProjection(key)、useAccess、t（locale 提供）
     */
    function ConvProgressBar(props) {
      const t = props.t ?? ((key, params) => interpolate(zh[key] ?? key, params ?? {}))
      const progress = props.useProjection('convProgress')   // ★ 唯一数据入口（host 投影推送）
      const running = props.useSession((state) => state.running)

      // 每秒 tick：只用于扣减 ETA 倒计时与"已用时间"，不触发任何网络请求
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        if (!progress || !running) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [running])

      if (!progress) return null          // host 半边未加载/投影未注册 → 安静降级

      const active = progress.running || progress.compacting || running
      const updatedAt = progress.updatedAt || now

      // ETA：host 给出的是"上次事件时刻的预计剩余"，client 按流逝时间扣减
      const etaLeftMs = progress.etaMs === null
        ? null
        : Math.max(0, progress.etaMs - Math.max(0, now - updatedAt))

      // 状态点：运行/压缩/空闲/失败
      let dotClass = 'dcp-dot'
      if (!active) dotClass += ' dcp-dot-idle'
      if (progress.compacting) dotClass += ' dcp-dot-warn'
      if (progress.lastEndReason === 'error') dotClass += ' dcp-dot-error'
      if (progress.lastEndReason === 'aborted' || progress.lastEndReason === 'blocked') dotClass += ' dcp-dot-warn'

      // 主状态文案
      const parts = []
      if (progress.compacting) parts.push(t('bar.compacting'))
      else if (active) {
        if (progress.todos.total > 0) {
          parts.push(t('bar.todos', { done: progress.todos.done, total: progress.todos.total }))
        } else if (progress.goal.max > 0) {
          parts.push(t('bar.goal', { round: progress.goal.round, max: progress.goal.max }))
        } else {
          parts.push(t('bar.running'))
        }
      }
      else if (progress.turn > 0) {
        const reason = progress.lastEndReason
        parts.push(reason === 'aborted' ? t('bar.aborted')
          : reason === 'error' ? t('bar.error')
          : reason === 'interrupted' ? t('bar.interrupted')
          : t('bar.done'))
      } else {
        parts.push(t('bar.idle'))
      }
      if (active) parts.push(t('bar.step', { n: Math.max(1, progress.step) }))
      if (active && progress.tools.inFlight > 0) {
        parts.push(progress.tools.inFlight === 1 && progress.tools.last
          ? t('bar.tool', { name: progress.tools.last })
          : t('bar.tools', { n: progress.tools.inFlight }))
      }
      if (active && etaLeftMs !== null) parts.push(t('bar.eta', { time: formatDuration(etaLeftMs) }))
      if (active) parts.push(t('bar.elapsed', { time: formatDuration(progress.elapsedMs ?? 0) }))

      // 进度条：determinate 用 pct，否则 indeterminate 动画；空闲时隐藏（或显示为 0）
      const width = progress.mode === 'determinate' && progress.pct !== null
        ? Math.max(2, Math.round(progress.pct * 100))
        : null

      return h('div', {
        className: 'dcp-root',
        dir: 'auto',
        title: `${t('bar.title')} · ${parts.join(' · ')}`
      }, [
        h('span', {
          key: 'dot',
          className: dotClass,
          'aria-hidden': 'true'
        }),
        h('div', { key: 'track', className: 'dcp-track', role: 'progressbar',
          'aria-valuemin': 0, 'aria-valuemax': 100,
          ...(width === null ? {} : { 'aria-valuenow': width })
        }, [
          h('div', {
            key: 'fill',
            className: width === null ? 'dcp-fill dcp-fill-indeterminate' : 'dcp-fill',
            style: width === null ? undefined : { width: `${width}%` }
          })
        ]),
        h('div', { key: 'meta', className: 'dcp-meta' }, parts.map((text, i) =>
          h('span', { key: i, className: i === 0 ? 'dcp-name' : 'dcp-eta' }, text)))
      ])
    }

    /** Required client services: slot registry + locale. （不用 connection/sessions，投影走 slot props） */
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => injectStyles(), 'dsh-conv-progress: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-conv-progress: dictionaries')
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'conv-progress',
          order: 12,
          locale: NS
        }, ConvProgressBar))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
```

> 说明：`elapsedMs` 与 `etaMs` 都由 host 在 `view()` 里算好（§5.1），client 只用每秒 tick 做倒计时扣减，
> **client 不需要知道 `turnStartedAt`**。若不想显示已用时间，删掉对应一行即可。
> 这份 skeleton 的 host 与 client 是配套的最小数据契约：`{turn, step, running, compacting, mode, pct, etaMs,
> elapsedMs, updatedAt, tools, tokens, todos, goal, lastEndReason}`。

### 5.3 package.json（照 `dsh-job-progress` 契约）

```json
{
  "name": "dsh-conv-progress",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale"] }
  }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: conv-progress
      name: 'dsh-conv-progress'
```

> `dsh.client.inject` 的语义 = **要预加载的 client 插件包名**（不是服务名）【实，package.json 对比；
> `dsh-conv-progress` 只依赖 locale 服务，若不确定 `@deepseek-ai/dsh-client-locale` 包名是否存在于本 build，
> 可先留空数组，`ctx.locale` 由 loader 侧注入（【推】，实现时以 job-progress 的写法为模板确认）。

---

## 6. 进度 / ETA 模型（哪些是事实、哪些是启发式）

### 6.1 确定性信号（可直接展示，无需估算）

| 信号 | 来源 | 说明 |
|---|---|---|
| 轮次 | `turn` | `turn/start` 递增 |
| 步数 | `step` / `stepsTotal` | `step/end` 权威计数 |
| 在飞工具 | `toolsInFlight` | `tool/call` 增、`tool/result` 减 |
| todo 完成比 | `todoDone/todoTotal` | `todo/write` 整表快照，唯一"有总工作量"的信号 |
| goal 轮次比 | `roundsStarted/maxGoalRounds` | 有 goal 时可用 |
| 已用时间 | `lastEventAt - turnStartedAt` | host 折叠 |
| 上下文占用 | `useProjection('contextPressure')`：`pressureTokens / contextWindow` | 官方投影，见 §2.7 |
| 历史耗时 | `sessionStats`（或自 fold 的 `stepAvgMs`/`turnAvgMs`） | 用于校准 ETA |

### 6.2 ETA 启发式（**全部是推断**，实现时须在 UI 标注"估算"）

1. **单步剩余**：`thisStepLeft = max(0, avgStepMs - (lastEventAt - stepStartedAt))`
2. **剩余工作量**：优先 `todoTotal - todoDone - todoInProgress`（todo 是模型自己写的计划，语义最强）；
   无 todo 时 **无法估计总步数** ⇒ 只报"本步剩余"，不报整轮 ETA。
3. **ETA** = `thisStepLeft + pendingTodos × avgStepMs`（`avgStepMs` 取最近 N 步均值，N=40）。
   - 已知高估/低估场景：模型批量跑工具（一步多 tool）会低估；长思考步会高估。
4. **置信度**：有 todo 且 `stepMs` 样本 ≥ 5 → `medium`；否则 `low`（UI 用 "~" 与灰字）。
5. 若需要更"正规"的算法（指数平滑/Weibull/Cox），另见同事调研 `research/research-progress-eta.md`
   （外部算法与生态对比，本文件不重复）；**框架只保证提供 event.time 与计数，不提供总工作量**。

### 6.3 不要做的事

- ❌ 不要用 `assistant/message` 计数 step（会漏 cancelled/max-tokens 步）——用 `step/end`【实，官方注释】。
- ❌ 不要在 host `view()` 里读 `Date.now()`（投影不可重放、且 `Object.is` 比较失效）；时间一律来自 `event.time`。
- ❌ 不要把"整轮 ETA"当成承诺；DSH 的对话长度本质上不可预测。

---

## 7. 生命周期、多会话、热注入

### 7.1 "正在生成 / 空闲"判定

| 层 | 信号 | 备注 |
|---|---|---|
| client（权威 UI 层） | `props.useSession(s => s.running)` = `SessionSnapshot.running` | 【实】客户端自己维护，含 pre-step 阶段 |
| host 投影 | `turn/start` … `turn/end` 之间的 `running` 标志 | 与 client 互为校验；`turn/end` 的 `reason` 给出终止语义 |
| agent 层 | `agent/status`（idle/running）、`Agent.status` | 适合命令式逻辑；投影里不必要 |

### 7.2 多会话并发

- **投影按 session 分片**：每个 Session 独立 fold、独立缓存、独立推送；client 组件 slot 带 `sessionId`。
  ⇒ "多会话并发时只统计当前 session"是**架构自带**的，不需要额外逻辑【实，§3.3】。
- 若走 Remote/REST 方案，**必须**由 client 传 `sessionId`（job-progress 的做法）【实】。
- fork/子会话：投影从父会话继承了 prefix（`init(header, inheritedEventCount)`），子会话有自己的
  `convProgress` 值；`turn/end.reason === 'forked'` 表示源轮次被 fork 种子关闭【实】。
- 冷读/分页/压缩：投影基于持久化缓存 + 重放，`stateVersion` 不符自动重建 ⇒ UI 不会因分页回退【实注释】。

### 7.3 热注入 / 热重载 / 依赖解析（**实测结果，重要**）

本环境装有 `dsh-super-injector`（`dev_*` 工具）：`dev_build_plugin` → `dev_inject_plugin`（运行时注入 +
`loader.create`，免重启）→ `dev_reload_package`（确定性热重载）→ `dev_uninject_plugin`（卸载即净）。
要求包目录含 `package.json` + `lib/`【文：运行环境说明】。

**实测：外部插件的 bare specifier 解析取决于"从哪个路径加载"**（本次用 node `createRequire` 复现）：

```
从 $PROFILE/node_modules/dsh-job-progress/lib/index.js 解析：
  @deepseek-ai/dsh-typert-protocol → OK（$D/dsh-typert-protocol）
  @deepseek-ai/dsh-session        → OK
  zod                             → OK（$PROFILE/node_modules/zod）
从 $PLUGINS/dsh-job-progress/lib/index.js 解析：
  三者全部 MODULE_NOT_FOUND
```

原因：`$PROFILE/node_modules/<pkg>` 是**真实目录**（非 junction），向上可走到
`/home/user/.dsh/profiles/node_modules/@deepseek-ai/`（**link farm，含 dsh-* 全套**）+ `$PROFILE/node_modules`；
而 `$PLUGINS/<pkg>/lib` 向上没有任何 node_modules。
⇒ **结论**：
1. 宿主插件若 `import` 任何 `@deepseek-ai/*` 或 `zod`，**必须**确保从 profile 路径加载（安装到
   `$PROFILE/node_modules/<pkg>`，或 junction 指向一个能被 profile 路径解析的实目录）。
2. **最稳妥**：像 §5.1 那样**零 import**（鸭子类型 schema + 只用 Node 内建）。
3. client 侧只用 `require('react')`（loader 注入），无解析问题【实：job-progress 可运行】。

**热重载注意**：
- client bundle **每次页面刷新重载**（改 client.js 无需重启 dsh，刷新即可；但前端有缓存，需 `dev_reload_package`
  或刷新验证）【文：client-plugin-recipes】。
- 同 id 重复注册 slot 会抛错 ⇒ bundles 装配 + `loader.create` 双路径挂载必须去重【文】。
- `dev_inject_plugin` 对 **Service 类插件**（有 `hasActiveEntry` 命中外壳）可能无法热替换，需要
  `hotUnmount` 后 `ctx.loader.create`【文/推：kb 文档的已知坑】。
- patch 文件同 id 重复行会导致 "duplicate loader entry id" 启动崩溃 ⇒ 用 `dev_fix_patch` 自愈【文】。

---

## 8. Client bundle 手写契约的 4 个静默失败点（**最容易踩**）

| # | 坑 | 症状 | 规避 |
|---|---|---|---|
| 1 | 缺 `const module={exports:{}}` / `const exports=module.exports` | 加载抛 `ReferenceError: exports is not defined` ⇒ **整个渲染层插件图崩溃、界面起不来**；host 照常、无日志 | 固定模板（§4.1）；打包后自检 |
| 2 | 忘记 `return module.exports` | 同上/插件未注册 | 同上 |
| 3 | 用 `export function apply` / 顶层 `import`（ESM 语法） | loader 以脚本求值 ⇒ SyntaxError | 只写 `module.exports.apply = apply` |
| 4 | `exports.inject` 写了不存在的 client 服务 | fiber 永远 pending ⇒ `apply` 不执行、无报错、UI 无插件 | 只列确定存在的服务（`slots`/`locale`）；用 `ctx.inject([...], cb)` 兜底可选服务 |
| 5 | 没有 `module.exports` 上的 `apply` 但 `id` 重复 | 双路径挂载冲突 | id 全局唯一（`dsh-conv-progress`） |
| 6 | 样式未做 `data-plugin-css` 去重 | 热重载后样式重复堆积 | `document.querySelector('style[data-plugin-css="..."]')` |

（表里 6 条 = 4 个契约点 + 2 个常见附带坑。）

---

## 9. 风险清单（按严重度）

### 阻断级

1. **client bundle 契约破坏 ⇒ 整个 Web UI 起不来**（§8 #1-3）。
   缓解：用 §5.2 模板；先在 `dev_self_test`/独立 session 验证；host 半边先上、client 后上，便于二分定位。
2. **依赖解析路径**（§7.3）：host 插件从 `$PLUGINS` 源路径加载时 `import` 全部失败。
   缓解：**零 import**（推荐）；或确认注入路径在 profile 下。
3. **投影 `state` 非 JSON / `apply` 抛错**：会污染持久化缓存、拖垮所有 carrier。
   缓解：state 只用 string/number/boolean/array/plain object（不用 Set/Map/Date/undefined 字段）；
   `apply` 内 try/catch 包裹或严格防御性取值（本项目骨架已防御 `?.`）。

### 高

4. **`stateVersion` / 投影契约升级易碎**：0.2.1-rc.2 的 `ProjectionDefinition` 形状若在后续版本变化
   （例如 `stateSchema` 从 `.parse` 改 `.safeParse`、wire 改名），鸭子 schema 技巧即时失效。
   缓解：stateVersion=1 起步、schema 保持宽进；锁版本 `engines.dsh`；把「注册投影」隔离在单文件便于替换。
5. **`KNOWN_SESSION_EVENT_TYPES` 是 GENERATED 列表**：新版本新增/重命名事件；外部插件自定义事件
   **不在表内**（必须带 `ignorable: true` 才能被读取路径容忍）【实：该文件头注释】。
   缓解：只订阅稳定核心事件（turn/step/tool/message/request/todo/goal），未知事件默认忽略。
6. **slot 名/kind 属 client 契约**：`conversation.input.dock` 当前是 list/session；若上游改为 single 或改名，
   注册会抛错或被吞。缓解：`ctx.slots.inject` 判存后再 register（inject 回调只在 slot 存在时执行，已是保护）；
   组件全量兜底 `progress === undefined → null`。
7. **单例 slot 被核心占用**：`conversation.input.activity` / `conversation.composer.bar` 是 `single` ⇒ 不要碰。
8. **ETA 误报伤害信任**：DSH 无总工作量，ETA 只能估算。缓解：无 todo 时不显示整轮 ETA；显示 "~"、灰字、
   超时后改为"仍在进行"；不承诺精度。

### 中

9. **host/client 版本错配**：新 client + 旧 host（无 `convProgress` key）⇒ `useProjection` 返回 undefined；
   骨架已做 `return null` 降级。反向（旧 client + 新 host）无影响。
10. **重复挂载**（bundles + 热注入双路径）⇒ 同 id slot 冲突 / 投影重复注册（幂等但计数）。缓解：只走一条装配路径。
11. **性能**：每事件都推送新 view 对象。单会话事件频率 ≈ 每 token/工具一次，可接受；若担心，可在 view 内
    做"仅当关键字段变化才返回新对象"的引用复用（`Object.is` 抑制）。
12. **`useSession`/`useProjection` 在非 session 作用域 slot 不可用**：必须挂在 `scope:'session'` 的 slot
    （`conversation.input.dock` 符合）；若挂全局 slot 只能用 `useSessionStatus` + 自行按 sessionId 过滤。
13. **locale 包名/服务**：`ctx.locale` 服务存在（dsh-context / job-progress 都用），但 `dsh.client.inject`
    里写包名需按本 build 实际包名（未逐一核对）。可先不写字典、hardcode 中文。

### 低

14. 每事件帧的 JSON 体积：wire 值控制在小对象（< 1KB）。
15. `compaction/*` / `approval/*` / `llm/retry` 的 payload 未读（§10），先按"存在即提示"用法。

---

## 10. 明确未验证 / 不确定（实现前需确认的清单）

| # | 事项 | 现状 | 建议 |
|---|---|---|---|
| 1 | `goal/change` 的完整 operation 枚举与 payload 字段 | 只知 `GoalProjection`/`GoalSnapshot` 形状，event payload 未逐条读 | `grep -n "goal/change" -A 20 $D/dsh-goal/lib/types/types.d.ts` |
| 2 | `approval/asked`、`llm/retry`、`compaction/start|end` 的 payload 字段 | 未读 | 同上，按包 grep |
| 3 | `contextPressure` 的 `projectedTokens` 启发式 delta 具体算法（密度/压缩折算） | wire 语义已读（§2.7），算法未读 | 读 `dsh-token-meter/lib/types/usage-projection.d.ts` + `lib/index.js`；**实践上直接用 wire 值即可，不必自算** |
| 4 | `dsh.client.inject` 里本 build 的 client 包名（如 `@deepseek-ai/dsh-client-locale` 是否存在） | 只验证了 job-progress 的写法 | `ls $PROFILE/node_modules/@deepseek-ai/` 或看 dsh web 资源清单 |
| 5 | client 入口发现机制（loader 是否用 `exports['./client']`） | 【推】 | 读 dsh web bootstrap / loader 的 client 装配逻辑 |
| 6 | `slot` 注册 spec 的完整字段（`inject` 回调签名、`key` 字段语义） | 见过 `name/id/order/locale/inject/label/key` 用法，未读完整类型 | `registry.d.ts` 全文 + `@deepseek-ai/dsh-client-ui-slots` 类型 |
| 7 | 投影注册表对 schema 的调用是否只有 `.parse`（无 `safeParse`/`optional` 等） | 已 grep 到 `.parse` 4 处，未 100% 覆盖 | 升级时回归 |
| 8 | `session/flush`、`SessionStore` 其它方法（fork/create/read） | 只确认 get/list/flush | 需要时读 `dsh-session/lib/types/index.d.ts` 全文 |
| 9 | Remote 服务非装饰器注册方式（若走方案 B） | 未读 job-progress 的装饰器转译细节 | 通读 `$PROFILE/dsh-job-progress/lib/index.js` 全文 543 行 |

---

## 11. 源码索引（本文引用的精确位置）

| 结论 | 文件（相对 `$D` 或绝对） | 位置 |
|---|---|---|
| 事件词汇表 62 项 | `dsh-session/lib/types/known-event-types.js` | :24-88 |
| `ignorable` 兼容机制说明 | 同上 | :9-23 |
| `SessionEventMap` 全量 | `dsh-session/lib/types/types.d.ts` | :256-436 |
| `TurnEndReasonMap` | 同上 | :166-211 |
| `RequestContext` | 同上 | :231-240 |
| `SessionEvent` 信封 | 同上 | :246 附近 |
| Cordis `session/*` 事件 + `Context.sessions` | `dsh-session/lib/types/index.d.ts` | :26-71、SessionStore 段 |
| 投影定义/注册表 | `dsh-session-projection/lib/types/index.d.ts` | ProjectionDefinition ~:40-90；register/onChanged/stateOf/snapshot 声明段 |
| 投影 schema 运行时调用 | `dsh-session-projection/lib/index.js` | :254、:258、:296、:304、:421 |
| 投影变化推送（host） | `dsh-api-session-controller/lib/index.js` | :1202（帧）、:1238/:1243（baseline） |
| 客户端 projection store（push 模型） | `dsh-api-session-controller/lib/types/client/sessions/projection-store.d.ts` | 头注释 |
| `SessionSnapshot.running` | `dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts` | :58-80 |
| slot 标准 props | `dsh-client-ui-session/lib/types/client/index.d.ts` | :68-100 |
| `SlotRegistry` | `dsh-client-ui-renderer/lib/types/client/registry.d.ts` | :46 |
| `conversation.*` slot 契约 | `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` | :203-395 |
| Agent 状态 | `dsh-agent/lib/types/runtime-types.d.ts` | :84-89 |
| `TokenUsage` | `dsh-llm/lib/types/message.d.ts` | :112-128 |
| `TodoItem` + `todo/write` + `todos` 投影 | `dsh-tool-todo/lib/types/types.d.ts` | :16-45 |
| `GoalProjection`/`GoalSnapshot` + `goal` key | `dsh-goal/lib/types/types.d.ts` | :40-122 |
| `plan` key | `dsh-plan-mode/lib/types/types.d.ts` | :42-45 |
| `sessionStats` 投影（最佳模板） | `dsh-session-stats/lib/index.js` + `lib/types/types.d.ts` | 全文 198 / :37 |
| `tokenUsage`/`contextPressure`/`contextBreakdown`（**client 可见**） | `dsh-token-meter/lib/types/projection.d.ts` | :64-72（wire 形状）、:23-52（语义） |
| Remote RPC 轮询范例 | `$PROFILE/dsh-job-progress/lib/client.js` | :233-249 |
| client module-loader 契约 + 坑 | `$PROFILE/dsh-job-progress/lib/client.js` | :1-20、:482-513 |
| client 插件注册 slot（官方范例） | `$PROFILE/dsh-context/lib/client.js` | 尾部 `apply`（压缩） |
| package.json/patch 契约 | `$PROFILE/dsh-job-progress/package.json`、`cordis.patch.yml` | 全文 |
| 本 profile 装配/热更新/坑 | `~/.dsh/docs/kb/20-plugins.md`、`~/.dsh/docs/client-plugin-recipes.md` | 全文 |
