/**
 * eval-eta.mjs — offline replay evaluation of the conv-progress ETA estimator.
 *
 * For every recorded turn we replay the same observables the live plugin sees
 * (turn/start, step/start, step/end, tool/call, tool/result, turn/end) on a 1 s
 * grid, feed them to an estimator implementation, and score the predicted ETA
 * against the wall-clock truth (turn end - now).
 *
 * The model state is rebuilt per session in turn order: turn N only ever sees
 * turns < N, exactly like the host's bootstrap()+live bookkeeping.
 *
 * Usage:
 *   node tools/eval-eta.mjs [--data data/turns-all.jsonl] [--impl <path>]
 *                           [--sessions N] [--split all|train|test] [--json out]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Repo root, resolved from this script's location (tools/..), so defaults work from any cwd. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

const DATA = arg('--data', resolve(ROOT, 'data/turns-all.jsonl'));
const IMPL = resolve(arg('--impl', resolve(ROOT, 'lib/estimator.js')));
const SESSIONS = Number(arg('--sessions', '0')) || Infinity;
const SPLIT = arg('--split', 'all');       // train | test | all
const REASONS = (arg('--reasons', 'all') ?? 'all').split(','); // all | completed | completed,error…
const JSON_OUT = arg('--json', '');
const SAMPLE_MS = 1000;                     // live poll is ~900 ms
const MAX_SAMPLES = 400;                    // per turn

const impl = await import(pathToFileURL(IMPL).href);
const { createModel, beginTurn, observeTurn, estimate } = impl;

// ── dataset ──────────────────────────────────────────────────────────────────
const badlyGapped = (turn) => {
  const times = [turn.start];
  for (const step of turn.steps ?? []) {
    times.push(step.start, step.end);
    for (const tool of step.tools ?? []) times.push(tool.start, tool.end);
  }
  times.push(turn.end);
  times.sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > 15 * 60_000) return true;
  return false;
};
const rawRecords = readFileSync(DATA, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => REASONS.includes('all') || REASONS.includes(String(r.reason)));
const records = rawRecords.filter((r) => r.end - r.start <= 2 * 3600_000 && !badlyGapped(r));
console.log(`turns: ${rawRecords.length} raw → ${records.length} after hygiene`);
const sessions = new Map();
for (const r of records) {
  if (!sessions.has(r.sid)) sessions.set(r.sid, []);
  sessions.get(r.sid).push(r);
}
for (const list of sessions.values()) list.sort((a, b) => a.start - b.start || a.turn - b.turn);

// deterministic train/test split by session id hash (no turn-level leakage)
const bucket = (sid) => {
  let h = 2166136261;
  for (let i = 0; i < sid.length; i++) { h ^= sid.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 10;                    // 0..9
};
const wanted = (sid) => {
  if (SPLIT === 'all') return true;
  const b = bucket(sid);
  return SPLIT === 'train' ? b < 7 : b >= 7; // 70/30
};

// ── replay ───────────────────────────────────────────────────────────────────
const samples = [];   // {pred, actual, progress, durMs, stepsDone, turnSteps, turn, sid}
let turnCount = 0;
let sessionCount = 0;

for (const [sid, turns] of sessions) {
  if (!wanted(sid)) continue;
  if (sessionCount >= SESSIONS) break;
  sessionCount += 1;
  const model = createModel();
  let turnIndex = 0;
  for (const turn of turns) {
    turnIndex += 1;
    beginTurn(model, turn.turn ?? turnIndex);
    const steps = turn.steps ?? [];
    const dur = turn.end - turn.start;
    const stride = Math.max(SAMPLE_MS, Math.ceil(dur / MAX_SAMPLES / 1000) * 1000);
    for (let t = turn.start + stride; t < turn.end; t += stride) {
      // facts exactly as the host derives them
      let stepsDone = 0;
      let stepStartedAt = null;
      let openStep = null;
      for (const step of steps) {
        if (step.end <= t) { stepsDone += 1; }
        else if (step.start <= t) { stepStartedAt = step.start; openStep = step; }
      }
      // tool observables (for the v2 estimator; ignored by v1)
      let pendingTools = 0;
      let lastTool = null;
      let lastToolAt = null;
      let toolsDone = 0;
      if (openStep) {
        for (const tool of openStep.tools ?? []) {
          if (tool.start <= t) {
            lastTool = tool.name;
            lastToolAt = tool.start;
            if (tool.end <= t) toolsDone += 1; else pendingTools += 1;
          }
        }
      }
      const facts = {
        running: true,
        now: t,
        turn: turn.turn ?? turnIndex,
        stepsDone,
        stepStartedAt,
        todos: null,
        phasePendingTools: pendingTools,
        phaseLastTool: lastTool,
        phaseLastToolAt: lastToolAt,
        phaseToolsDone: toolsDone,
        turnStartedAt: turn.start,
        model: turn.model,
      };
      const out = estimate(model, facts);
      if (Number.isFinite(out?.etaMs)) {
        samples.push({
          pred: out.etaMs,
          actual: turn.end - t,
          progress: (t - turn.start) / dur,
          durMs: dur,
          stepsDone,
          turnSteps: steps.length,
          turn: turn.turn ?? turnIndex,
          sid,
          trel: t - turn.start,
        });
      }
    }
    turnCount += 1;
    observeTurn(model, { durationMs: dur, steps: steps.length, todoDelta: 0 });
  }
}

// ── metrics ──────────────────────────────────────────────────────────────────
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
};
const groups = (fn) => {
  const map = new Map();
  for (const s of samples) {
    const key = fn(s);
    if (key === null) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return map;
};
const score = (xs) => {
  const signed = xs.map((s) => s.pred - s.actual);
  const abs = signed.map(Math.abs);
  const rel = xs.map((s) => Math.abs(s.pred - s.actual) / Math.max(3_000, s.actual));
  return {
    n: xs.length,
    mae: Math.round(mean(abs)),
    medianAE: Math.round(median(abs)),
    rmse: Math.round(Math.sqrt(mean(signed.map((x) => x * x)))),
    bias: Math.round(mean(signed)),
    mape: Math.round(100 * mean(rel.map((x) => Math.min(5, x)))) / 100,
    p10: Math.round(quantile(signed, 0.1)),
    p50: Math.round(quantile(signed, 0.5)),
    p90: Math.round(quantile(signed, 0.9)),
  };
};
const fmt = (n) => (n >= 60_000 ? `${(n / 60_000).toFixed(1)}m` : n >= 1_000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
const row = (label, s) =>
  `${label.padEnd(26)} n=${String(s.n).padStart(6)}  MAE=${fmt(s.mae).padStart(8)}  med=${fmt(s.medianAE).padStart(8)}  bias=${(s.bias >= 0 ? '+' : '') + fmt(Math.abs(s.bias)).padStart(7)}  p50=${fmt(s.p50).padStart(8)}  p10-p90=${fmt(s.p10)}..${fmt(s.p90).padStart(8)}  mape=${s.mape}`;

const out = { impl: IMPL, data: DATA, split: SPLIT, sessions: sessionCount, turns: turnCount, samples: samples.length };
console.log(`impl=${IMPL.split('/').slice(-2).join('/')} split=${SPLIT} sessions=${sessionCount} turns=${turnCount} samples=${samples.length}\n`);
console.log('== overall ==');
out.overall = score(samples);
console.log(row('all', out.overall));

console.log('\n== by progress bucket ==');
out.byProgress = {};
for (const [label, lo, hi] of [['0-10%', 0, 0.1], ['10-25%', 0.1, 0.25], ['25-50%', 0.25, 0.5], ['50-75%', 0.5, 0.75], ['75-90%', 0.75, 0.9], ['90-100%', 0.9, 1.01]]) {
  const xs = samples.filter((s) => s.progress >= lo && s.progress < hi);
  if (xs.length === 0) continue;
  out.byProgress[label] = score(xs);
  console.log(row(label, out.byProgress[label]));
}

console.log('\n== by turn duration ==');
out.byDuration = {};
for (const [label, lo, hi] of [['<30s', 0, 30_000], ['30-120s', 30_000, 120_000], ['2-5m', 120_000, 300_000], ['5-15m', 300_000, 900_000], ['>15m', 900_000, Infinity]]) {
  const xs = samples.filter((s) => s.durMs >= lo && s.durMs < hi);
  if (xs.length === 0) continue;
  out.byDuration[label] = score(xs);
  console.log(row(label, out.byDuration[label]));
}

console.log('\n== by executed steps ==');
out.byStepsDone = {};
for (const [label, lo, hi] of [['0', 0, 1], ['1-2', 1, 3], ['3-7', 3, 8], ['8-19', 8, 20], ['20-49', 20, 50], ['50+', 50, Infinity]]) {
  const xs = samples.filter((s) => s.stepsDone >= lo && s.stepsDone < hi);
  if (xs.length === 0) continue;
  out.byStepsDone[label] = score(xs);
  console.log(row(label, out.byStepsDone[label]));
}

console.log('\n== by elapsed-in-turn ==');
out.byElapsed = {};
for (const [label, lo, hi] of [['<15s', 0, 15_000], ['15-60s', 15_000, 60_000], ['1-3m', 60_000, 180_000], ['3-10m', 180_000, 600_000], ['>10m', 600_000, Infinity]]) {
  const xs = samples.filter((s) => s.trel >= lo && s.trel < hi);
  if (xs.length === 0) continue;
  out.byElapsed[label] = score(xs);
  console.log(row(label, out.byElapsed[label]));
}

// calibration: what does the model think the remaining *fraction* is vs truth
console.log('\n== ratio pred/actual quantiles ==');
const ratios = samples.filter((s) => s.actual > 5_000).map((s) => Math.log2(s.pred / s.actual));
console.log(`  log2(pred/actual): p10=${quantile(ratios, 0.1).toFixed(2)} p25=${quantile(ratios, 0.25).toFixed(2)} p50=${quantile(ratios, 0.5).toFixed(2)} p75=${quantile(ratios, 0.75).toFixed(2)} p90=${quantile(ratios, 0.9).toFixed(2)}  (>0 = over-estimate)`);

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`\njson → ${JSON_OUT}`);
}
