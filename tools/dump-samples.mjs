/**
 * dump-samples.mjs — build a feature-rich replay table for ETA research.
 *
 * Emits one CSV row per replay sample (same sampling rule as eval-eta.mjs:
 * stride = max(1 s, ceil(dur / 400 / 1 s) * 1 s), so the rows are the exact
 * samples used by the offline evaluator). Every feature is derived only from
 * information the live plugin has at that moment; `remaining_ms`, `dur_ms` and
 * `total_steps` are evaluation-only columns and must never become model inputs.
 *
 * Split (deterministic by session id hash, no turn-level leakage):
 *   bucket 0..6 → train, 7..8 → calib, 9 → test
 *
 * Usage: node tools/dump-samples.mjs [--data data/turns2.jsonl] [--out data/samples.csv]
 */
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModel, beginTurn, observeTurn, estimate } from '../lib/estimator.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const DATA = resolve(arg('--data', resolve(ROOT, 'data/turns2.jsonl')));
const OUT = resolve(arg('--out', resolve(ROOT, 'data/samples.csv')));
const SAMPLE_MS = 1000;
const MAX_SAMPLES = 400;
const GAP_LIMIT = 15 * 60_000;
const DUR_LIMIT = 2 * 3600_000;

const TOOL_CAT = (name) => {
  if (typeof name !== 'string') return 0;
  if (/bash|shell|job|exec|pty|terminal/i.test(name)) return 1;
  if (/edit|write|apply|patch|replace/i.test(name)) return 2;
  if (/read|grep|glob|list|search|find|ls|view/i.test(name)) return 3;
  if (/image|draw|photo|art/i.test(name)) return 4;
  if (/todo|plan/i.test(name)) return 5;
  if (/agent|subagent|workflow|team/i.test(name)) return 6;
  return 7;
};

const MODEL_CODES = new Map();
const modelCode = (model) => {
  if (typeof model !== 'string' || model === '') return 0;
  if (!MODEL_CODES.has(model)) MODEL_CODES.set(model, MODEL_CODES.size + 1);
  return MODEL_CODES.get(model);
};

const bucket = (sid) => {
  let h = 2166136261;
  for (let i = 0; i < sid.length; i++) { h ^= sid.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 10;
};

const badlyGapped = (turn) => {
  const times = [turn.start];
  for (const step of turn.steps ?? []) {
    times.push(step.start, step.end);
    for (const tool of step.tools ?? []) times.push(tool.start, tool.end);
  }
  times.push(turn.end);
  times.sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > GAP_LIMIT) return true;
  return false;
};

/** Load hygiene-filtered turns grouped by session. */
async function load() {
  const sessions = new Map();
  const rl = createInterface({ input: createReadStream(DATA), crlfDelay: Infinity });
  let raw = 0;
  for await (const line of rl) {
    if (line.length === 0) continue;
    const turn = JSON.parse(line);
    raw += 1;
    if (!(turn.end > turn.start)) continue;
    if (turn.end - turn.start > DUR_LIMIT) continue;
    if (badlyGapped(turn)) continue;
    if (!Array.isArray(turn.steps) || turn.steps.length === 0) continue;
    if (!sessions.has(turn.sid)) sessions.set(turn.sid, []);
    sessions.get(turn.sid).push(turn);
  }
  for (const list of sessions.values()) list.sort((a, b) => a.start - b.start || a.turn - b.turn);
  console.log(`raw=${raw} kept=${[...sessions.values()].reduce((n, l) => n + l.length, 0)} sessions=${sessions.size}`);
  return sessions;
}

const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const HEAD = [
  'split', 'sid', 'turn', 't_rel', 'k', 'elapsed_ms', 'step_elapsed_ms', 'step_open', 'step_has_tools',
  'tools_done_in_step', 'pending_tools', 'last_tool_cat', 'prev_step_mean_ms', 'prev_step_max_ms', 'step_ms_ema',
  'since_last_evt_ms', 'n_prev_turns', 'prev_turn_dur_med', 'prev_turn_steps_med', 'turn_index',
  'prompt_chars', 'prompt_lines', 'prompt_code_fences', 'prompt_commands', 'prompt_mentions',
  'prompt_questions', 'prompt_has_image', 'prompt_cjk_ratio',
  'plan_n', 'plan_done', 'plan_has', 'model_code',
  'turn_tools_bash', 'turn_tools_edit', 'turn_tools_read', 'turn_tools_image', 'turn_tools_agent',
  'v2_pred', 'v2_conf', 'v2_reliability', 'v2_cell_samples',
  'remaining_ms', 'dur_ms', 'total_steps', 'reason_ok',
];

const rows = [];
const sessions = await load();
let sessionCount = 0;
const startedAt = Date.now();

for (const [sid, turns] of sessions) {
  const b = bucket(sid);
  const split = b <= 6 ? 'train' : b <= 8 ? 'calib' : 'test';
  const model = createModel();
  const prevDurs = [];
  const prevSteps = [];
  let turnIndex = 0;
  for (const turn of turns) {
    turnIndex += 1;
    const turnNo = Number.isFinite(turn.turn) ? turn.turn : turnIndex;
    beginTurn(model, turnNo);
    const steps = turn.steps;
    const dur = turn.end - turn.start;
    const prompt = turn.prompt ?? {};
    const stride = Math.max(SAMPLE_MS, Math.ceil(dur / MAX_SAMPLES / 1000) * 1000);
    const todoTimeline = (turn.todoTimeline ?? []).filter((x) => Number.isFinite(x.t));

    for (let t = turn.start + stride; t < turn.end; t += stride) {
      // ── step/tool observables at t ────────────────────────────────────────
      let k = 0;
      let openStep = null;
      const completedDurs = [];
      let lastEventTs = turn.start;
      let toolsDoneInStep = 0;
      let pendingTools = 0;
      let lastToolCat = 0;
      let lastToolAt = null;
      let turnToolCats = [0, 0, 0, 0, 0, 0, 0, 0];
      for (const step of steps) {
        if (step.end <= t) {
          k += 1;
          completedDurs.push(step.end - step.start);
          lastEventTs = Math.max(lastEventTs, step.end);
        } else if (step.start <= t) {
          openStep = step;
          lastEventTs = Math.max(lastEventTs, step.start);
        }
        for (const tool of step.tools ?? []) {
          if (tool.end <= t) {
            lastEventTs = Math.max(lastEventTs, tool.end);
            turnToolCats[TOOL_CAT(tool.name)] += 1;
          } else if (tool.start <= t) {
            lastEventTs = Math.max(lastEventTs, tool.start);
          }
          if (step === openStep && tool.start <= t) {
            lastToolAt = tool.start;
            lastToolCat = TOOL_CAT(tool.name);
            if (tool.end <= t) toolsDoneInStep += 1; else pendingTools += 1;
          }
        }
      }
      // ── plan state at t ───────────────────────────────────────────────────
      let planN = 0;
      let planDone = 0;
      for (const entry of todoTimeline) {
        if (entry.t <= t - turn.start) { planN = entry.n; planDone = entry.completed; }
      }
      // ── facts fed to the current (v2) estimator ───────────────────────────
      const openTools = (openStep?.tools ?? []).filter((tool) => tool.start <= t);
      const facts = {
        running: true,
        now: t,
        turn: turnNo,
        stepsDone: k,
        stepStartedAt: openStep ? openStep.start : null,
        phasePendingTools: pendingTools,
        phaseLastTool: lastToolCat === 0 ? null : String(lastToolCat),
        phaseLastToolAt: lastToolAt,
        phaseToolsDone: toolsDoneInStep,
        turnStartedAt: turn.start,
        model: turn.model,
      };
      // Build a faithful todos array so planPercent matches the live path.
      if (planN > 0) {
        facts.todos = [
          ...Array(Math.min(planDone, planN)).fill({ status: 'completed' }),
          ...Array(Math.max(0, planN - planDone)).fill({ status: 'pending' }),
        ];
      } else {
        facts.todos = null;
      }
      const out = estimate(model, facts);
      const prevCompleted = completedDurs.slice(-3);
      rows.push([
        split, sid, turnNo, t - turn.start, k, t - turn.start,
        openStep ? t - openStep.start : 0, openStep ? 1 : 0,
        // NB: "has this step called a tool *so far*" — never the step's final tool
        // list, which the live plugin cannot know (training/serving parity, checked
        // by tools/check-features.mjs).
        openTools.length > 0 ? 1 : 0,
        toolsDoneInStep, pendingTools, lastToolCat,
        Math.round(prevCompleted.length ? mean(prevCompleted) : 0),
        prevCompleted.length ? Math.max(...prevCompleted) : 0,
        Math.round(model.stepMs),
        t - lastEventTs,
        prevDurs.length, Math.round(prevDurs.length ? median(prevDurs) : 0), Math.round(prevSteps.length ? median(prevSteps) : 0),
        turnIndex,
        prompt.chars ?? 0, prompt.lines ?? 0, prompt.codeFences ?? 0, prompt.commands ?? 0, prompt.mentions ?? 0,
        prompt.questionMarks ?? 0, prompt.hasImage ? 1 : 0, Math.round((prompt.cjkRatio ?? 0) * 100),
        planN, planDone, planN > 0 ? 1 : 0, modelCode(turn.model),
        turnToolCats[1], turnToolCats[2], turnToolCats[3], turnToolCats[4], turnToolCats[6],
        Math.round(out.etaMs), out.confidence === 'high' ? 2 : out.confidence === 'medium' ? 1 : 0,
        Math.round(out.breakdown?.reliability ?? 0) / 1000, out.breakdown?.cellSamples ?? 0,
        turn.end - t, dur, steps.length, 1,
      ]);
    }

    prevDurs.push(dur);
    prevSteps.push(steps.length);
    observeTurn(model, { durationMs: dur, steps: steps.length, todoDelta: turn.todos ?? 0 });
    sessionCount += 1;
  }
  if (sessionCount % 100 === 0) console.log(`… sessions=${sessionCount} rows=${rows.length} ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

const csv = `${HEAD.join(',')}\n${rows.map((row) => row.join(',')).join('\n')}\n`;
writeFileSync(OUT, csv);
console.log(`rows=${rows.length} → ${OUT} (${(csv.length / 1e6).toFixed(1)} MB) in ${Math.round((Date.now() - startedAt) / 1000)}s`);

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
