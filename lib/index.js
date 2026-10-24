/**
 * dsh-conv-progress — host half.
 *
 * Job: turn the harness' committed SessionEvent stream into one small view-model
 * that the web GUI can poll:
 *
 *   session/event  ──►  per-session state  ──►  Remote `convProgress/snapshot`
 *   (turn/step/tool/todo)                      { percent, etaMs, phase, ... }
 *
 * Why host-side and not client-side:
 *   - `session/event` gives every event *after* it is committed, with its
 *     recorded timestamp and token usage — the client bundle has no such feed;
 *   - the host can bootstrap from `session.snapshotEvents()` when the GUI opens
 *     mid-turn (a client plugin would have to reconstruct from a partial window);
 *   - estimation is CPU-cheap but belongs next to the data; the client only polls
 *     one JSON blob through the standard `/api` Remote gateway.
 *
 * Nothing here mutates the session: the plugin is read-only telemetry.
 */
import os from 'node:os';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

import z from '@deepseek-ai/schemastery';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

import * as estimatorV2 from './estimator.js';
import {
  DEFAULT_PARAMS,
  createModel,
  beginTurn,
  observe as observeFeatures,
  observeStepMs,
  observeTurn,
  estimate,
} from './estimator-v3.js';
import { blendWithPrior, createPriorRequester } from './prior.js';
import {
  appendTurnRecord,
  confidenceAtEnd,
  describeReason,
  extractTaskTitle,
} from './history.js';

// ── decorator support (stage-3 decorators, transpiled — Node has none) ─────
var __esDecorate = function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
  function accept(f) {
    if (f !== void 0 && typeof f !== 'function') throw new TypeError('Function expected');
    return f;
  }
  var kind = contextIn.kind, key = kind === 'getter' ? 'get' : kind === 'setter' ? 'set' : 'value';
  var target = !descriptorIn && ctor ? (contextIn['static'] ? ctor : ctor.prototype) : null;
  var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
  var _, done = false;
  for (var i = decorators.length - 1; i >= 0; i--) {
    var context = {};
    for (var p in contextIn) context[p] = p === 'access' ? {} : contextIn[p];
    for (var p in contextIn.access) context.access[p] = contextIn[p];
    context.addInitializer = function (f) {
      if (done) throw new Error('Cannot add initializers after decoration has completed');
      extraInitializers.push(accept(f || null));
    };
    var result = (0, decorators[i])(kind === 'accessor' ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
    if (kind === 'accessor') {
      if (result === void 0) continue;
      if (result === null || typeof result !== 'object') throw new TypeError('Object expected');
      if ((_ = accept(result.get))) descriptor.get = _;
      if ((_ = accept(result.set))) descriptor.set = _;
      if ((_ = accept(result.init))) initializers.unshift(_);
    } else if ((_ = accept(result))) {
      if (kind === 'field') initializers.unshift(_);
      else descriptor[key] = _;
    }
  }
  if (target) Object.defineProperty(target, contextIn.name, descriptor);
  done = true;
};
var __runInitializers = function (thisArg, initializers, value) {
  var useValue = arguments.length > 2;
  for (var i = 0; i < initializers.length; i++) {
    value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
  }
  return useValue ? value : void 0;
};

/** Sessions kept in memory. Every GUI tab polls its own; the rest age out. */
const MAX_SESSIONS = 128;
/** Same guard for the event log we fold per session (only current turn matters). */
const MAX_TODO_ITEMS = 64;
/** Debug log budget: stop appending past this size (rotated once). */
const DEBUG_LOG_LIMIT = 256 * 1024;
const DEBUG_SAMPLE_LIMIT = 3;

const asEpochMs = (value) => (Number.isFinite(value) && value > 1_600_000_000_000 ? value : Date.now());
const userPromptText = (content) =>
  Array.isArray(content)
    ? content.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim()
    : '';

const countStatus = (todos, status) =>
  Array.isArray(todos) ? todos.filter((item) => item && item.status === status).length : 0;

/** Per-session estimation state. */
function createState(sessionId) {
  return {
    id: sessionId,
    model: createModel(),
    running: false,
    turn: 0,
    step: 0,
    stepsDone: 0,
    stepStartedAt: null,
    turnStartedAt: null,
    turnEndedAt: null,
    toolCalls: 0,
    toolResults: 0,
    lastTool: null,
    lastToolAt: null,
    todos: null,
    planCompletedAtTurnStart: 0,
    usage: null,
    modelName: null,
    contextWindow: null,
    idledAt: null,
    lastEventAt: 0,
    events: 0,
    bootstrapped: false,
    /** First user text of the turn currently open (task content for the log). */
    taskTitle: '',
    /** Full first user text of the turn (feeds the optional prior estimator). */
    promptText: '',
    /** Structured work-size estimate for the current turn, when enabled. */
    prior: null,
    /** Per-session memoised prior requester. */
    priorRequester: null,
    /** Finished turns, oldest first; bounded by `historyLimit`. */
    history: [],
  };
}

let ConvProgressService = (() => {
  let _classSuper = TypertRemoteService;
  let _instanceExtraInitializers = [];
  let _snapshot_decorators;
  let _history_decorators;
  return class ConvProgressService extends _classSuper {
    static {
      const _metadata = typeof Symbol === 'function' && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
      _snapshot_decorators = [Remote('snapshot')];
      __esDecorate(this, null, _snapshot_decorators, {
        kind: 'method',
        name: 'snapshot',
        static: false,
        private: false,
        access: { has: (obj) => 'snapshot' in obj, get: (obj) => obj.snapshot },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      _history_decorators = [Remote('history')];
      __esDecorate(this, null, _history_decorators, {
        kind: 'method',
        name: 'history',
        static: false,
        private: false,
        access: { has: (obj) => 'history' in obj, get: (obj) => obj.history },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      if (_metadata) Object.defineProperty(this, Symbol.metadata, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: _metadata
      });
    }

    /** `sessions` is the only hard dependency: it resolves a session by id and
     *  snapshots its committed events when a GUI attaches mid-turn. */
    static inject = ['sessions'];

    static Config = z.object({
      /** Append a JSONL trace of what the estimator saw (debugging only). */
      debug: z.boolean().default(false),
      /** Prior wall-clock ms for one step (~one model call + its tools). */
      priorStepMs: z.number().default(DEFAULT_PARAMS.priorStepMs),
      /** Prior number of steps in one turn. */
      priorStepsPerTurn: z.number().default(DEFAULT_PARAMS.priorStepsPerTurn),
      /** How many finished turns per session the history panel may show. */
      historyLimit: z.number().default(100),
      /** Experimental prompt-injection prior. Off by default: measured too noisy. */
      prior: z
        .object({
          enabled: z.boolean().default(false),
          provider: z.string().default(''),
          model: z.string().default(''),
          timeoutMs: z.number().default(2500),
          blendWeight: z.number().default(0),
        })
        .default({ enabled: false, provider: '', model: '', timeoutMs: 2500, blendWeight: 0 }),
    });

    states = new Map();
    order = [];
    config;
    debugDir;
    debugWrites = 0;

    constructor(ctx, config = {}) {
      super(ctx, 'convProgress');
      __runInitializers(this, _instanceExtraInitializers);
      this.config = config ?? {};
      this.debugDir = join(os.homedir(), '.dsh', 'conv-progress');
      ctx.on('session/event', (session, event) => {
        try {
          this.onSessionEvent(session, event);
        } catch (error) {
          ctx.logger?.warn?.('dsh-conv-progress: session event failed: ' + String(error));
        }
      });
      ctx.logger?.info?.('dsh-conv-progress: mounted (snapshot at convProgress/snapshot)');
    }

    // ── state plumbing ──────────────────────────────────────────────────────

    stateFor(sessionId) {
      let state = this.states.get(sessionId);
      if (state !== undefined) return state;
      state = createState(sessionId);
      state.model = createModel({
        priorStepMs: this.config.priorStepMs,
        priorStepsPerTurn: this.config.priorStepsPerTurn,
      });
      this.states.set(sessionId, state);
      this.order.push(sessionId);
      this.trim();
      return state;
    }

    /** Bound memory: drop the least recently active sessions. */
    trim() {
      while (this.order.length > MAX_SESSIONS) {
        const victim = this.order.find((id) => {
          const s = this.states.get(id);
          return s === undefined || s.running !== true;
        });
        if (victim === undefined) return;
        this.order = this.order.filter((id) => id !== victim);
        this.states.delete(victim);
      }
    }

    /** Fold committed events of one session into its state. */
    onSessionEvent(session, event) {
      const sessionId = session?.id;
      if (typeof sessionId !== 'string' || event === null || typeof event !== 'object') return;
      const state = this.stateFor(sessionId);
      try {
        this.applyEvent(state, event, session);
      } catch (error) {
        // One malformed event must never silence the whole event stream: the
        // listener is fire-and-forget, so a throw here would lose every later
        // event of the session (the capsule would freeze at a stale turn).
        this.logDebug({ kind: 'apply-failed', sessionId, type: event.type, error: String(error) });
      }
      if (state.bootstrapped) this.debugSample(state);
    }

    /**
     * Replay the session's committed event log the first time somebody asks for a
     * snapshot. This is what makes the bar correct when the GUI is opened in the
     * middle of a long turn: the whole current turn is already in the log.
     */
    bootstrap(state) {
      if (state.bootstrapped) return;
      state.bootstrapped = true;
      const session = this.ctx?.sessions?.get?.(state.id);
      if (session === undefined || session === null) return;
      let events = [];
      try {
        events = session.snapshotEvents?.() ?? [];
      } catch (error) {
        this.logDebug({ kind: 'bootstrap-failed', sessionId: state.id, error: String(error) });
        return;
      }
      for (const event of events) this.applyEvent(state, event, session);
      const context = (() => {
        try {
          return session.requestContext?.();
        } catch {
          return undefined;
        }
      })();
      if (context !== undefined && context !== null) {
        state.modelName = context.model ?? state.modelName;
        state.contextWindow = context.contextWindow ?? state.contextWindow;
      }
      this.logDebug({
        kind: 'bootstrap',
        sessionId: state.id,
        events: events.length,
        running: state.running,
        turn: state.turn,
        stepsDone: state.stepsDone,
      });
    }

    applyEvent(state, event, session) {
      const type = event?.type;
      const data = event?.data ?? {};
      const time = asEpochMs(event?.time);
      // v3 features are replayed from the same event stream the rest of the
      // state uses; doing it first keeps the vector consistent with the log.
      observeFeatures(state.model, event);
      state.lastEventAt = time;
      state.events += 1;
      state.modelName = data.model ?? state.modelName;

      switch (type) {
        case 'turn/start': {
          state.running = true;
          state.turn = Number.isFinite(data.turn) ? data.turn : state.turn + 1;
          state.stepsDone = 0;
          state.step = 0;
          state.stepStartedAt = null;
          state.turnStartedAt = time;
          state.turnEndedAt = null;
          state.taskTitle = '';
          state.promptText = '';
          state.prior = null;
          state.toolCalls = 0;
          state.toolResults = 0;
          state.lastTool = null;
          state.lastToolAt = null;
          state.planCompletedAtTurnStart = countStatus(state.todos, 'completed');
          beginTurn(state.model, state.turn);
          break;
        }
        case 'user/message': {
          // `user/message.data` is the UserMessage itself (no turn/step wrapper).
          // Harness-injected runtime context also arrives as `user/message`; only
          // the real submission may seed the task title / prior prompt.
          const sourceKind = data?.source?.kind;
          if (sourceKind !== undefined && sourceKind !== 'user') break;
          if (state.taskTitle.length === 0) {
            state.taskTitle = extractTaskTitle(data?.content);
          }
          if (state.promptText.length === 0) {
            state.promptText = userPromptText(data?.content);
            if (session !== undefined) this.startPrior(state, session);
          }
          break;
        }
        case 'step/start': {
          state.step = Number.isFinite(data.step) ? data.step : state.step + 1;
          state.stepStartedAt = time;
          break;
        }
        case 'step/end': {
          const stepStartedAt = state.stepStartedAt;
          state.stepsDone += 1;
          state.stepStartedAt = null;
          if (stepStartedAt !== null && time > stepStartedAt) {
            observeStepMs(state.model, time - stepStartedAt);
          }
          break;
        }
        case 'tool/call': {
          state.toolCalls += 1;
          state.lastTool = typeof data.name === 'string' ? data.name : state.lastTool;
          state.lastToolAt = time;
          break;
        }
        case 'tool/result': {
          state.toolResults += 1;
          break;
        }
        case 'assistant/message': {
          if (data.usage !== undefined && data.usage !== null) {
            state.usage = {
              input: data.usage.inputTokens ?? 0,
              output: data.usage.outputTokens ?? 0,
              total: data.usage.totalTokens ?? (data.usage.inputTokens ?? 0) + (data.usage.outputTokens ?? 0),
              cacheRead: data.usage.cacheReadTokens ?? 0,
            };
          }
          // The step that produced this message is over even if step/end was
          // dropped (aborted streams): keep the bar from freezing mid-step.
          break;
        }
        case 'todo/write': {
          if (Array.isArray(data.todos)) {
            state.todos = data.todos.slice(0, MAX_TODO_ITEMS).map((item) => ({
              content: typeof item?.content === 'string' ? item.content : '',
              status: item?.status === 'completed' ? 'completed' : item?.status === 'in_progress' ? 'in_progress' : 'pending',
            }));
          }
          break;
        }
        case 'turn/end': {
          state.running = false;
          state.turnEndedAt = time;
          state.idledAt = time;
          const durationMs = state.turnStartedAt === null ? 0 : Math.max(0, time - state.turnStartedAt);
          const todoDelta = Math.max(0, countStatus(state.todos, 'completed') - state.planCompletedAtTurnStart);
          observeTurn(state.model, { durationMs, steps: state.stepsDone, todoDelta });
          appendTurnRecord(state.history, {
            turn: state.turn,
            title: state.taskTitle,
            startedAt: state.turnStartedAt,
            endedAt: time,
            durationMs,
            steps: state.stepsDone,
            tools: state.toolCalls,
            todoDelta,
            reason: describeReason(data.reason),
            // Estimator knowledge *before* this turn is folded in.
            confidence: confidenceAtEnd({ steps: state.model.v2.stepSamples }),
            avgStepMs: state.stepsDone > 0 ? Math.round(durationMs / state.stepsDone) : null,
          }, this.config.historyLimit);
          break;
        }
        default:
          break;
      }
    }

    // ── view model ──────────────────────────────────────────────────────────

    /**
     * Optional per-turn prior: one side call to the estimating model at turn
     * start. Fire-and-forget by design — the capsule must never wait on it.
     */
    startPrior(state, session) {
      const cfg = this.config.prior;
      if (cfg?.enabled !== true || state.promptText.length === 0) return;
      const requester = this.priorRequesterFor(state);
      if (requester === null) return;
      requester
        .request({
          turn: state.turn,
          prompt: state.promptText,
          cwd: session?.header?.cwd,
          model: state.modelName,
        })
        .then((prior) => {
          if (prior === null) return;
          state.prior = prior;
          this.logDebug({ kind: 'prior', sessionId: state.id, turn: state.turn, prior });
        })
        .catch((error) => this.logDebug({ kind: 'prior-failed', sessionId: state.id, error: String(error) }));
    }

    priorRequesterFor(state) {
      if (state.priorRequester !== null) return state.priorRequester;
      const llm = this.ctx?.get?.('llm');
      if (llm === undefined || typeof llm.stream !== 'function') {
        this.logDebug({ kind: 'prior-unavailable', sessionId: state.id, reason: 'no llm service' });
        return null;
      }
      const cfg = this.config.prior ?? {};
      const selection = this.ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
      state.priorRequester = createPriorRequester({
        stream: (request) => llm.stream(request),
        resolveTarget: () => ({
          provider: cfg.provider || selection.provider,
          model: cfg.model || selection.model,
        }),
        timeoutMs: Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 2500,
      });
      return state.priorRequester;
    }

    phaseOf(state) {
      if (!state.running) return state.turnEndedAt === null ? 'idle' : 'done';
      if (state.stepStartedAt === null) return 'preparing';
      return state.toolCalls > state.toolResults ? 'tool' : 'thinking';
    }

    buildSnapshot(state, now) {
      const phase = this.phaseOf(state);
      const pendingTools = Math.max(0, state.toolCalls - state.toolResults);
      const todos = state.todos;
      const facts = {
        running: state.running,
        turn: state.turn,
        stepsDone: state.stepsDone,
        stepStartedAt: state.stepStartedAt,
        // Wall-clock turn origin: both the v3 features and the v2 fallback
        // need it, and it is the only clock shared with the GUI.
        turnStartedAt: state.turnStartedAt,
        model: state.modelName,
        now,
        todos,
      };
      let estimateResult;
      try {
        estimateResult = estimate(state.model, facts);
      } catch (error) {
        // A model/feature mismatch must never take the progress bar down: fall
        // back to the previous (table-based) estimator for this poll.
        this.logDebug({ kind: 'estimate-failed', sessionId: state.id, error: String(error) });
        estimateResult = estimatorV2.estimate(state.model.v2, facts);
      }
      // Optional prompt-injection prior: blend its minutes into the displayed
      // ETA. Default weight is 0 (no effect) — see docs §14 for the measurement.
      const priorCfg = this.config.prior;
      if (priorCfg?.enabled === true && state.prior !== null) {
        const blended = blendWithPrior(estimateResult.etaMs, state.prior.minutes, priorCfg.blendWeight ?? 0);
        if (Number.isFinite(blended)) estimateResult = { ...estimateResult, etaMs: blended };
      }
      const todoView = Array.isArray(todos)
        ? {
            total: todos.length,
            completed: countStatus(todos, 'completed'),
            inProgress: countStatus(todos, 'in_progress'),
            items: todos,
          }
        : null;
      return {
        sessionId: state.id,
        now,
        available: true,
        running: state.running,
        phase,
        turn: state.turn,
        step: state.step,
        stepsDone: state.stepsDone,
        stepsInHistory: state.history.length,
        /** Finished turns available in the history panel. */
        turns: state.history.length,
        elapsedMs: state.turnStartedAt === null ? 0 : Math.max(0, now - state.turnStartedAt),
        toolCalls: state.toolCalls,
        pendingTools,
        lastTool: state.lastTool,
        lastToolAt: state.lastToolAt,
        model: state.modelName,
        contextWindow: state.contextWindow,
        usage: state.usage,
        todos: todoView,
        percent: estimateResult.percent,
        etaMs: estimateResult.etaMs,
        /** Conformal interval around `etaMs` (v3 only; null on the fallback). */
        etaLoMs: Number.isFinite(estimateResult.loMs) ? estimateResult.loMs : null,
        etaHiMs: Number.isFinite(estimateResult.hiMs) ? estimateResult.hiMs : null,
        remainingSteps: estimateResult.remainingSteps,
        expectedSteps: estimateResult.expectedSteps,
        confidence: estimateResult.confidence,
        basis: estimateResult.basis,
        /** Prompt-injection prior for this turn (null until/unless enabled). */
        prior: state.prior === null ? null : { steps: state.prior.steps, minutes: state.prior.minutes, confidence: state.prior.confidence },
        priorEnabled: this.config.prior?.enabled === true,
        breakdown: estimateResult.breakdown,
        calibration: {
          stepMs: Math.round(state.model.v2.stepMs),
          stepsPerTurn: Number(state.model.v2.stepsPerTurn.toFixed(2)),
          stepsPerTodo: Number(state.model.v2.stepsPerTodo.toFixed(2)),
          samples: {
            steps: state.model.v2.stepSamples,
            turns: state.model.v2.turnSamples,
            todos: state.model.v2.todoSamples,
          },
        },
      };
    }

    // ── Remote method ───────────────────────────────────────────────────────

    /**
     * `convProgress/snapshot` — one poll from the GUI.
     * @param {{sessionId?: string}|undefined} request
     */
    async snapshot(request) {
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : '';
      if (sessionId.length === 0) {
        const running = this.order
          .map((id) => this.states.get(id))
          .filter((state) => state !== undefined && state.running);
        return { available: false, sessionId: '', now: Date.now(), running: running.length, sessions: running.length };
      }
      const state = this.stateFor(sessionId);
      this.bootstrap(state);
      const now = Date.now();
      this.debugSample(state);
      return this.buildSnapshot(state, now);
    }

    /**
     * `convProgress/history` — one bounded page of finished turns, newest first.
     * The client calls this when the popover opens and refreshes it while open;
     * the snapshot poll stays untouched.
     * @param {{sessionId?: string}|undefined} request
     */
    async history(request) {
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : '';
      const now = Date.now();
      if (sessionId.length === 0) return { sessionId: '', now, total: 0, records: [] };
      const state = this.stateFor(sessionId);
      this.bootstrap(state);
      const records = state.history.slice().reverse();
      return { sessionId, now, total: records.length, records };
    }

    /** Local diagnostics for the README / future tooling (not a Remote method). */
    diagnostics() {
      return {
        sessions: [...this.states.values()].map((state) => ({
          sessionId: state.id,
          running: state.running,
          turn: state.turn,
          stepsDone: state.stepsDone,
          events: state.events,
          phase: this.phaseOf(state),
        })),
      };
    }

    // ── debug trace (only with config.debug) ────────────────────────────────

    /** Cheap watermarked trace: a handful of lines per session, never per poll. */
    debugSample(state) {
      if (this.config.debug !== true) return;
      if ((state.debugSamples ?? 0) >= DEBUG_SAMPLE_LIMIT) return;
      state.debugSamples = (state.debugSamples ?? 0) + 1;
      try {
        this.logDebug({
          kind: 'snapshot',
          sessionId: state.id,
          running: state.running,
          turn: state.turn,
          stepsDone: state.stepsDone,
          percent: Number(this.buildSnapshot(state, Date.now()).percent.toFixed(3)),
        });
      } catch {
        // tracing must never break the snapshot
      }
    }

    logDebug(record) {
      try {
        mkdirSync(this.debugDir, { recursive: true });
        const file = join(this.debugDir, 'debug.jsonl');
        try {
          if (statSync(file).size > DEBUG_LOG_LIMIT) renameSync(file, join(this.debugDir, 'debug.old.jsonl'));
        } catch {
          // file does not exist yet
        }
        appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
        this.debugWrites += 1;
      } catch {
        // tracing is best-effort
      }
    }
  };
})();

export { ConvProgressService, ConvProgressService as default };
