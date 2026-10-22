/**
 * fit-eta.mjs — empirical calibration harness for the conv-progress ETA model.
 *
 * Loads data/turns-all.jsonl, replays every turn on a 1 s grid (the same
 * observables the live plugin sees), and compares candidate predictors against
 * wall-clock truth. Candidate constants are fit on the TRAIN split and reported
 * on the TEST split only, so nothing leaks.
 *
 * Usage: node tools/fit-eta.mjs [--data …] [--json out]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this script's location (tools/..), so defaults work from any cwd. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const DATA = arg('--data', resolve(ROOT, 'data/turns-all.jsonl'));
const JSON_OUT = arg('--json', '');
const SAMPLE_MS = 1000;
const MAX_SAMPLES = 400;
const HEAVY_TOOL = /^(task|agent|subagent|workflow_|job_|mcp__|generate_image|analyze_media)/;

// ── load + split (same hash as eval-eta.mjs, train = 70%) ────────────────────
const bucket = (sid) => {
  let h = 2166136261;
  for (let i = 0; i < sid.length; i++) { h ^= sid.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 10;
};
const rows = readFileSync(DATA, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const bySession = new Map();
for (const r of rows) {
  if (!bySession.has(r.sid)) bySession.set(r.sid, []);
  bySession.get(r.sid).push(r);
}
for (const list of bySession.values()) list.sort((a, b) => a.start - b.start || a.turn - b.turn);

const quantile = (xs, q) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// ── feature extraction (train/test identical) ───────────────────────────────
function samplesFor(turns, split, out) {
  const model = { stepDurs: [], turnSteps: [] }; // per-session running stats, turn-order
  for (const turn of turns) {
    const steps = turn.steps ?? [];
    const dur = turn.end - turn.start;
    const stride = Math.max(SAMPLE_MS, Math.ceil(dur / MAX_SAMPLES / 1000) * 1000);
    const hasPlan = turn.todos !== null && turn.todos !== undefined;
    let heavySeen = false;
    for (const step of steps) {
      for (const tool of step.tools ?? []) {
        if (HEAVY_TOOL.test(tool.name)) heavySeen = true;
      }
    }
    for (let t = turn.start + stride; t < turn.end; t += stride) {
      let k = 0;              // completed steps
      let open = null;        // current open step
      for (const step of steps) {
        if (step.end <= t) k += 1;
        else if (step.start <= t) open = step;
      }
      const stepElapsed = open ? t - open.start : 0;
      // pending tool inside the open step
      let pendingTool = null;
      if (open) {
        for (const tool of open.tools ?? []) {
          if (tool.start <= t && tool.end > t) pendingTool = tool.name;
        }
      }
      // session step-time statistics from steps that already finished before t
      let sum = 0; let n = 0; let lastDurs = [];
      for (const step of steps) {
        if (step.end <= t) { sum += step.end - step.start; n += 1; }
      }
      // previous turns' step means
      const sStepMean = model.stepDurs.length > 0 ? mean(model.stepDurs) : NaN;
      out.push({
        split, sid: turn.sid, model: turn.model, k,
        elapsed: t - turn.start,
        stepElapsed: open ? stepElapsed : 0,
        inStep: open !== null,
        hasPlan, heavySeen,
        pendingHeavy: pendingTool !== null && HEAVY_TOOL.test(pendingTool),
        pendingTool,
        turnStepMeanSoFar: n > 0 ? sum / n : NaN,
        sessionStepMean: sStepMean,
        sessionTurnSteps: model.turnSteps.length > 0 ? mean(model.turnSteps) : NaN,
        actual: turn.end - t,
        durMs: dur,
      });
    }
    for (const step of steps) model.stepDurs.push(step.end - step.start);
    model.turnSteps.push(steps.length);
  }
}

const trainSamples = [];
const testSamples = [];
for (const [, turns] of bySession) {
  const split = bucket(turns[0].sid) < 7 ? 'train' : 'test';
  samplesFor(turns, split, split === 'train' ? trainSamples : testSamples);
}
console.log(`samples: train=${trainSamples.length} test=${testSamples.length}`);

// ── fit tables on TRAIN ─────────────────────────────────────────────────────
const trains = trainSamples;
const tests = testSamples;
const globalStepMean = mean(trains.filter((s) => s.turnStepMeanSoFar > 0).map((s) => s.turnStepMeanSoFar));
const allStepDurs = [];
// step duration distribution (from raw turns)
for (const [, turns] of bySession) {
  if (bucket(turns[0].sid) >= 7) continue;
  for (const turn of turns) for (const step of turn.steps ?? []) allStepDurs.push(step.end - step.start);
}
const globalStepPrior = mean(allStepDurs);
console.log(`global step prior: mean=${(globalStepPrior / 1000).toFixed(1)}s median=${(quantile(allStepDurs, 0.5) / 1000).toFixed(1)}s p90=${(quantile(allStepDurs, 0.9) / 1000).toFixed(1)}s`);

// E[remaining steps | k] table (cap at k=120; tail = geometric with terminal hazard)
const remainingByK = (samples) => {
  const byK = new Map();
  for (const s of samples) {
    const r = s.remainingStepsTruth ?? (s.remainingStepsTruth = NaN);
    void r;
  }
  return byK;
};
void remainingByK;

// remaining *steps* truth needs the turn's total step count; recompute directly
const remStepsTable = new Map();   // k -> array of (totalSteps - k)
const remStepsTablePlan = new Map();
const remStepsTableNoPlan = new Map();
const pushRem = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};
for (const [, turns] of bySession) {
  const split = bucket(turns[0].sid) < 7 ? 'train' : 'test';
  if (split !== 'train') continue;
  for (const turn of turns) {
    const total = (turn.steps ?? []).length;
    const hasPlan = turn.todos !== null && turn.todos !== undefined;
    for (let k = 0; k <= Math.min(total, 120); k++) {
      pushRem(remStepsTable, Math.min(k, 120), Math.max(0, total - k));
      pushRem(hasPlan ? remStepsTablePlan : remStepsTableNoPlan, Math.min(k, 120), Math.max(0, total - k));
    }
  }
}
const tableRem = new Map();
for (const [k, xs] of remStepsTable) tableRem.set(k, quantile(xs, 0.5));
const tableRemPlan = new Map();
for (const [k, xs] of remStepsTablePlan) tableRemPlan.set(k, quantile(xs, 0.5));
const tableRemNoPlan = new Map();
for (const [k, xs] of remStepsTableNoPlan) tableRemNoPlan.set(k, quantile(xs, 0.5));
const lookup = (map, k) => {
  if (map.has(k)) return map.get(k);
  // geometric tail from the last known point, hazard 0.04/step
  let last = 0; let lastV = 0;
  for (const [key, value] of map) if (key <= k && key > last) { last = key; lastV = value; }
  return Math.max(0.5, lastV * Math.pow(0.96, k - last));
};

// current-step residual table: E[(step.end - t)/stepMs | elapsed/stepMs bucket]
const residualBuckets = new Map(); // bucket -> array of residualMs
const stepMeanForResidual = (s) => (Number.isFinite(s.turnStepMeanSoFar) && s.turnStepMeanSoFar > 0 ? s.turnStepMeanSoFar : globalStepPrior);
for (const [, turns] of bySession) {
  const split = bucket(turns[0].sid) < 7 ? 'train' : 'test';
  if (split !== 'train') continue;
  for (const turn of turns) {
    const stepMs = globalStepPrior;
    for (const step of turn.steps ?? []) {
      const dur = step.end - step.start;
      const stride = Math.max(1000, Math.ceil(dur / 20 / 1000) * 1000);
      for (let t = step.start; t < step.end; t += stride) {
        const ratio = (t - step.start) / stepMs;
        const b = ratio < 0.25 ? 'a' : ratio < 0.5 ? 'b' : ratio < 1 ? 'c' : ratio < 2 ? 'd' : ratio < 4 ? 'e' : 'f';
        pushRem(residualBuckets, b, step.end - t);
      }
    }
  }
}
const tableResidual = new Map();
for (const [b, xs] of residualBuckets) tableResidual.set(b, quantile(xs, 0.5));
const residualBucketOf = (ratio) => (ratio < 0.25 ? 'a' : ratio < 0.5 ? 'b' : ratio < 1 ? 'c' : ratio < 2 ? 'd' : ratio < 4 ? 'e' : 'f');
console.log('residual table (median ms):', Object.fromEntries([...tableResidual].map(([k, v]) => [k, Math.round(v / 100) / 10 + 's'])));

// ── candidate predictors ────────────────────────────────────────────────────
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function stepMsFor(s, mode) {
  const p = globalStepPrior;
  if (mode === 'global') return p;
  if (mode === 'session-turn') {
    const local = s.turnStepMeanSoFar;
    if (!Number.isFinite(local) || local <= 0) return p;
    const n = 1; // weight local vs prior
    return clamp((local * n + p * 4) / (n + 4), p * 0.25, p * 8);
  }
  if (mode === 'session-all') {
    const local = Number.isFinite(s.sessionStepMean) && s.sessionStepMean > 0 ? s.sessionStepMean : p;
    const localTurn = s.turnStepMeanSoFar;
    const l = Number.isFinite(localTurn) && localTurn > 0 ? (localTurn * 0.6 + local * 0.4) : local;
    return clamp((l * 3 + p * 4) / 7, p * 0.25, p * 8);
  }
  return p;
}

function predict(s, variant) {
  const stepMs = stepMsFor(s, variant.stepMode ?? 'session-all');
  const remSteps = lookup(tableRem, s.k);
  const totalSteps = s.k + (s.inStep ? 1 : 0) + remSteps;
  // current step residual: use table when inStep
  let currentRemaining;
  if (s.inStep) {
    const ratio = s.stepElapsed / stepMs;
    currentRemaining = tableResidual.get(residualBucketOf(ratio)) ?? stepMs;
    if (s.pendingHeavy) currentRemaining *= 1.5;
  } else {
    currentRemaining = 0;
  }
  const futureSteps = Math.max(0, remSteps);
  let eta = currentRemaining + futureSteps * stepMs;
  if (variant.timeRatio) {
    // time-ratio estimate: elapsed * remaining/total
    const p = s.k / Math.max(1, s.k + remSteps);
    if (s.elapsed > 20_000 && p > 0.02) {
      const ratioEta = s.elapsed * (1 / p - 1);
      eta = variant.timeRatio === 'blend' ? 0.5 * eta + 0.5 * ratioEta : ratioEta;
    }
  }
  return { eta, stepMs, remSteps, totalSteps, currentRemaining };
}

function score(samples, fn) {
  const signed = [];
  const abs = [];
  for (const s of samples) {
    const raw = fn(s);
    if (!Number.isFinite(raw)) continue;
    const pred = clamp(raw, 3000, 3 * 3600_000);
    const err = pred - s.actual;
    signed.push(err);
    abs.push(Math.abs(err));
  }
  return {
    n: abs.length,
    mae: Math.round(mean(abs)),
    medAE: Math.round(quantile(abs, 0.5)),
    bias: Math.round(mean(signed)),
    p50: Math.round(quantile(signed, 0.5)),
    mape: Math.round(100 * mean(abs.map((a, i) => Math.min(5, a / Math.max(3000, samples[i]?.actual ?? 3000))))) / 100,
  };
}
const fmt = (n) => (Math.abs(n) >= 60_000 ? `${(n / 60_000).toFixed(1)}m` : `${(n / 1000).toFixed(1)}s`);

const variants = [
  { name: 'v1-like (const prior 25s, stepsPerTurn=9)', fn: (s) => 8 * 25_000 + (s.k) * 0 },
  { name: 'global step prior + rem table', fn: (s) => predict(s, { stepMode: 'global' }).eta },
  { name: 'session-adjusted step time', fn: (s) => predict(s, { stepMode: 'session-all' }).eta },
  { name: 'session step + time-ratio blend', fn: (s) => predict(s, { stepMode: 'session-all', timeRatio: 'blend' }).eta },
  { name: 'session step + pure time-ratio', fn: (s) => predict(s, { stepMode: 'session-all', timeRatio: 'pure' }).eta },
  { name: 'plan-aware rem table', fn: (s) => {
    const rem = lookup(s.hasPlan ? tableRemPlan : tableRemNoPlan, s.k);
    const stepMs = stepMsFor(s, 'session-all');
    const cur = s.inStep ? (tableResidual.get(residualBucketOf(s.stepElapsed / stepMs)) ?? stepMs) : 0;
    return cur + Math.max(0, rem) * stepMs;
  } },
];

console.log('\n== candidate predictors (train / test MAE) ==');
for (const v of variants) {
  const tr = score(trains, v.fn);
  const te = score(tests, v.fn);
  console.log(`${v.name.padEnd(46)} train MAE=${fmt(tr.mae).padStart(7)} bias=${fmt(tr.bias).padStart(7)} | test MAE=${fmt(te.mae).padStart(7)} med=${fmt(te.medAE).padStart(7)} bias=${fmt(te.bias).padStart(7)} p50=${fmt(te.p50).padStart(7)}`);
}

// ── emit the fitted tables for the plugin ───────────────────────────────────
const round2 = (v) => Math.round(v * 100) / 100;
const tableOut = {
  meta: {
    source: 'data/turns-all.jsonl',
    sessions: bySession.size,
    samples: { train: trains.length, test: tests.length },
    globalStepPriorMs: Math.round(globalStepPrior),
  },
  remSteps: Object.fromEntries([...tableRem.entries()].map(([k, v]) => [k, round2(v)])),
  remStepsPlan: Object.fromEntries([...tableRemPlan.entries()].map(([k, v]) => [k, round2(v)])),
  remStepsNoPlan: Object.fromEntries([...tableRemNoPlan.entries()].map(([k, v]) => [k, round2(v)])),
  residualMs: Object.fromEntries([...tableResidual.entries()].map(([k, v]) => [k, Math.round(v)])),
};
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(tableOut, null, 2));
  console.log(`\ntables → ${JSON_OUT}`);
}
console.log('\nremSteps table head:', Object.fromEntries([...tableRem.entries()].slice(0, 20).map(([k, v]) => [k + '→' + round2(v)])));
