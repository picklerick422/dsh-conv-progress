/**
 * search-eta.mjs — search for a better ETA estimator on the real session corpus.
 *
 * Strategy: the completion time of a turn is genuinely uncertain (the model
 * decides when to stop), so the right target is the *conditional median* of the
 * remaining wall-clock time. We fit that median non-parametrically on the TRAIN
 * split over the observables the plugin actually has — steps done (k), elapsed
 * time in the turn, session-observed step speed, plan presence — and score on
 * the TEST split against the current (v1) estimator.
 *
 * Usage: node tools/search-eta.mjs [--data …] [--json out]
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
const JSON_OUT = arg('--json', '');
const SAMPLE_MS = 1000;
const MAX_SAMPLES = 400;

const v1 = await import(pathToFileURL(resolve(ROOT, 'plugins/dsh-conv-progress/lib/estimator.js')).href);

const bucketOf = (sid) => {
  let h = 2166136261;
  for (let i = 0; i < sid.length; i++) { h ^= sid.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 10;
};
const rawRows = readFileSync(DATA, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Drop turns whose wall clock is polluted by machine sleep / long human idle:
//   * total duration > 2h
//   * any gap between consecutive events > 15min
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
const rows = rawRows.filter((r) => r.end - r.start <= 2 * 3600_000 && !badlyGapped(r));
console.error(`turns: ${rawRows.length} raw → ${rows.length} after hygiene (dropped ${rawRows.length - rows.length})`);
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

// ── per-sample feature extraction, replaying turns per session ──────────────
/** @type {Array<any>} */
const samples = [];
for (const [, turns] of bySession) {
  const split = bucketOf(turns[0].sid) < 7 ? 'train' : 'test';
  const sessionStepDurs = [];
  const sessionTurnSteps = [];
  const v1model = v1.createModel();
  for (const turn of turns) {
    const steps = turn.steps ?? [];
    const dur = turn.end - turn.start;
    const stride = Math.max(SAMPLE_MS, Math.ceil(dur / MAX_SAMPLES / 1000) * 1000);
    const hasPlan = turn.todos !== null && turn.todos !== undefined;
    const totalSteps = steps.length;
    v1.beginTurn(v1model, turn.turn);
    for (let t = turn.start + stride; t < turn.end; t += stride) {
      let k = 0;
      let open = null;
      for (const step of steps) {
        if (step.end <= t) k += 1;
        else if (step.start <= t) open = step;
      }
      let heavy = false;
      let pendingHeavy = false;
      for (const step of steps) {
        for (const tool of step.tools ?? []) {
          if (/^(task|agent|subagent|workflow_|job_|mcp__|generate_image|analyze_media)/.test(tool.name)) heavy = true;
        }
      }
      if (open) {
        for (const tool of open.tools ?? []) {
          if (tool.start <= t && tool.end > t && /^(task|agent|subagent|workflow_|job_|mcp__|generate_image|analyze_media)/.test(tool.name)) pendingHeavy = true;
        }
      }
      let sum = 0; let n = 0;
      for (const step of steps) if (step.end <= t) { sum += step.end - step.start; n += 1; }
      samples.push({
        split, sid: turn.sid, model: turn.model,
        k, elapsed: t - turn.start, totalSteps, dur,
        inStep: open !== null, stepElapsed: open ? t - open.start : 0,
        turnStepMean: n > 0 ? sum / n : NaN,
        sessionStepMean: sessionStepDurs.length > 0 ? mean(sessionStepDurs) : NaN,
        sessionTurnSteps: sessionTurnSteps.length > 0 ? mean(sessionTurnSteps) : NaN,
        sessionTurns: sessionTurnSteps.length,
        hasPlan, heavy, pendingHeavy,
        actual: turn.end - t,
        v1pred: v1.estimate(v1model, {
          running: true, now: t, turn: turn.turn, stepsDone: k,
          stepStartedAt: open ? open.start : null, todos: null,
        }).etaMs,
      });
    }
    v1.observeTurn(v1model, { durationMs: dur, steps: steps.length, todoDelta: 0 });
    for (const step of steps) sessionStepDurs.push(step.end - step.start);
    sessionTurnSteps.push(steps.length);
  }
}
const train = samples.filter((s) => s.split === 'train');
const test = samples.filter((s) => s.split === 'test');
console.log(`samples train=${train.length} test=${test.length}`);

// global priors from train
const allStepDurs = [];
const turnStepsTrain = [];
const turnDurTrain = [];
for (const [, turns] of bySession) {
  if (bucketOf(turns[0].sid) >= 7) continue;
  for (const turn of turns) {
    turnStepsTrain.push(turn.steps.length);
    turnDurTrain.push(turn.end - turn.start);
    for (const step of turn.steps) allStepDurs.push(step.end - step.start);
  }
}
const globalStepPrior = mean(allStepDurs);
const globalStepMedian = quantile(allStepDurs, 0.5);
console.log(`global step prior: mean=${(globalStepPrior / 1000).toFixed(1)}s median=${(globalStepMedian / 1000).toFixed(1)}s | turn dur median=${(quantile(turnDurTrain, 0.5) / 1000).toFixed(0)}s p90=${(quantile(turnDurTrain, 0.9) / 60000).toFixed(1)}m | steps/turn median=${quantile(turnStepsTrain, 0.5)} p90=${quantile(turnStepsTrain, 0.9)}`);

// per-model step prior (median) from train
const modelStepDurs = new Map();
for (const s of train) if (Number.isFinite(s.turnStepMean)) void 0;
for (const [, turns] of bySession) {
  if (bucketOf(turns[0].sid) >= 7) continue;
  for (const turn of turns) {
    const key = turn.model || '?';
    if (!modelStepDurs.has(key)) modelStepDurs.set(key, []);
    for (const step of turn.steps) modelStepDurs.get(key).push(step.end - step.start);
  }
}
const modelStepPrior = new Map([...modelStepDurs].map(([m, ds]) => [m, quantile(ds, 0.5)]));

// ── candidate tables ────────────────────────────────────────────────────────
const kBucket = (k) => (k === 0 ? 0 : k <= 2 ? k : k <= 4 ? 3 + (k - 3) : k <= 8 ? '6-8' : k <= 12 ? '9-12' : k <= 17 ? '13-17' : k <= 25 ? '18-25' : k <= 35 ? '26-35' : k <= 50 ? '36-50' : k <= 70 ? '51-70' : k <= 100 ? '71-100' : '100+');
const eBucket = (e) => (e < 15_000 ? 'e0' : e < 30_000 ? 'e1' : e < 60_000 ? 'e2' : e < 120_000 ? 'e3' : e < 240_000 ? 'e4' : e < 480_000 ? 'e5' : e < 900_000 ? 'e6' : e < 1_800_000 ? 'e7' : 'e8');

// target: median remaining time conditioned on (k bucket, elapsed bucket)
const cell = new Map();
for (const s of train) {
  const key = `${kBucket(s.k)}|${eBucket(s.elapsed)}`;
  if (!cell.has(key)) cell.set(key, []);
  cell.get(key).push(s.actual);
}
const medianTable = new Map([...cell].map(([k, xs]) => [k, quantile(xs, 0.5)]));
// fallback chain: drop elapsed bucket → drop k bucket
const medKBucket = new Map();
for (const s of train) {
  const key = String(kBucket(s.k));
  if (!medKBucket.has(key)) medKBucket.set(key, []);
  medKBucket.get(key).push(s.actual);
}
const medianByK = new Map([...medKBucket].map(([k, xs]) => [k, quantile(xs, 0.5)]));

// same but per plan/heavy partition
const medPart = new Map();
for (const s of train) {
  const part = s.hasPlan ? 'plan' : s.heavy ? 'heavy' : 'plain';
  const key = `${part}|${kBucket(s.k)}`;
  if (!medPart.has(key)) medPart.set(key, []);
  medPart.get(key).push(s.actual);
}
const medianPart = new Map([...medPart].map(([k, xs]) => [k, quantile(xs, 0.5)]));

// remaining-steps median table by k bucket (to sanity check the step story)
const remStepsCell = new Map();
for (const s of train) {
  const key = String(kBucket(s.k));
  if (!remStepsCell.has(key)) remStepsCell.set(key, []);
  remStepsCell.get(key).push(Math.max(0, s.totalSteps - s.k));
}
const remStepsByK = new Map([...remStepsCell].map(([k, xs]) => [k, quantile(xs, 0.5)]));


// ── finer-grained table (k exact ≤40, elapsed 30s buckets ≤20m) ─────────────
const kFine = (k) => (k <= 40 ? `k${k}` : k <= 60 ? 'k41-60' : k <= 90 ? 'k61-90' : k <= 130 ? 'k91-130' : 'k130+');
const eFine = (e) => `e${Math.min(40, Math.floor(e / 30_000))}`;
const fineCell = new Map();
for (const s of train) {
  const key = `${kFine(s.k)}|${eFine(s.elapsed)}`;
  if (!fineCell.has(key)) fineCell.set(key, []);
  fineCell.get(key).push(s.actual);
}
const fineCount = new Map([...fineCell].map(([k, xs]) => [k, xs.length]));
const fineTable = new Map([...fineCell].filter(([, xs]) => xs.length >= 25).map(([k, xs]) => [k, quantile(xs, 0.5)]));
const coarseCount = new Map([...cell].map(([k, xs]) => [k, xs.length]));
const fineByK = new Map();
for (const s of train) {
  if (!fineByK.has(kFine(s.k))) fineByK.set(kFine(s.k), []);
  fineByK.get(kFine(s.k)).push(s.actual);
}
const fineKMedian = new Map([...fineByK].map(([k, xs]) => [k, quantile(xs, 0.5)]));
const lookupFine = (s) => fineTable.get(`${kFine(s.k)}|${eFine(s.elapsed)}`) ?? fineKMedian.get(kFine(s.k)) ?? lookupCell(s);

const lookupCell = (s) => {
  const key = `${kBucket(s.k)}|${eBucket(s.elapsed)}`;
  if (medianTable.has(key)) return medianTable.get(key);
  const k = String(kBucket(s.k));
  if (medianByK.has(k)) return medianByK.get(k);
  return undefined;
};
const lookupPart = (s) => {
  const part = s.hasPlan ? 'plan' : s.heavy ? 'heavy' : 'plain';
  const key = `${part}|${kBucket(s.k)}`;
  return medianPart.get(key) ?? lookupCell(s);
};

// session/step speed factor used to rescale a table fitted on the global mix
function speedFactor(s, mode) {
  const g = globalStepPrior;
  if (mode === 'none') return 1;
  const pick = mode === 'turn' ? s.turnStepMean : mode === 'session' ? s.sessionStepMean : NaN;
  if (Number.isFinite(pick) && pick > 0) return Math.min(2.5, Math.max(0.4, pick / g));
  if (mode === 'turn-model' && modelStepPrior.has(s.model)) {
    return Math.min(2.5, Math.max(0.4, modelStepPrior.get(s.model) / g));
  }
  return 1;
}

function v1pred(s) {
  // reuse the v1 estimator with a per-session model reconstructed by the caller
  return s.v1pred;
}

// ── scoring (time-weighted, but also per-turn and by turn length) ───────────
const fmt = (n) => (Math.abs(n) >= 60_000 ? `${(n / 60_000).toFixed(1)}m` : `${(n / 1000).toFixed(1)}s`);
function turnWeighted(samplesIn, predict) {
  const perTurn = new Map();
  for (const s of samplesIn) {
    let eta = predict(s);
    if (!Number.isFinite(eta)) continue;
    eta = Math.min(3 * 3600_000, Math.max(3000, eta));
    const key = `${s.sid}|${s.dur}`;
    if (!perTurn.has(key)) perTurn.set(key, []);
    perTurn.get(key).push(Math.abs(eta - s.actual));
  }
  const means = [...perTurn.values()].map((xs) => mean(xs));
  return { nTurns: means.length, mae: Math.round(mean(means)), medAE: Math.round(quantile(means, 0.5)) };
}
function score(samplesIn, predict, { unclamped = false } = {}) {
  const signed = []; const abs = []; const rel = [];
  for (const s of samplesIn) {
    let eta = predict(s);
    if (!Number.isFinite(eta)) continue;
    if (!unclamped) eta = Math.min(3 * 3600_000, Math.max(3000, eta));
    const err = eta - s.actual;
    signed.push(err); abs.push(Math.abs(err));
    rel.push(Math.min(5, Math.abs(err) / Math.max(5000, s.actual)));
  }
  return {
    n: abs.length,
    mae: Math.round(mean(abs)),
    medAE: Math.round(quantile(abs, 0.5)),
    bias: Math.round(mean(signed)),
    p50: Math.round(quantile(signed, 0.5)),
    p10: Math.round(quantile(signed, 0.1)),
    p90: Math.round(quantile(signed, 0.9)),
    mape: Math.round(100 * mean(rel)) / 100,
  };
}

const candidates = [
  { name: 'v1 (current)', fn: (s) => s.v1pred },
  { name: 'median table (k×elapsed)', fn: (s) => lookupCell(s) },
  { name: 'median table × speed(session)', fn: (s) => { const m = lookupCell(s); return m === undefined ? NaN : m * speedFactor(s, 'session'); } },
  { name: 'median table × speed(turn)', fn: (s) => { const m = lookupCell(s); return m === undefined ? NaN : m * speedFactor(s, 'turn'); } },
  { name: 'median table × speed(model)', fn: (s) => { const m = lookupCell(s); return m === undefined ? NaN : m * speedFactor(s, 'turn-model'); } },
  { name: 'part table (plan/heavy) × speed(session)', fn: (s) => { const m = lookupPart(s); return m === undefined ? NaN : m * speedFactor(s, 'session'); } },
  { name: 'fine table (k×30s)', fn: (s) => lookupFine(s) },
  { name: 'fine if n>=60 else coarse', fn: (s) => {
    const key = `${kFine(s.k)}|${eFine(s.elapsed)}`;
    if ((fineCount.get(key) ?? 0) >= 60 && fineTable.has(key)) return fineTable.get(key);
    return lookupCell(s);
  } },
  { name: 'shrunk fine→coarse (pseudo 40)', fn: (s) => {
    const fk = `${kFine(s.k)}|${eFine(s.elapsed)}`;
    const f = fineTable.get(fk);
    const c = lookupCell(s);
    if (f === undefined) return c;
    const n = fineCount.get(fk) ?? 0;
    if (c === undefined) return f;
    const w = n / (n + 40);
    return Math.exp(w * Math.log(f) + (1 - w) * Math.log(c));
  } },
  { name: 'shrunk fine→coarse (pseudo 100)', fn: (s) => {
    const fk = `${kFine(s.k)}|${eFine(s.elapsed)}`;
    const f = fineTable.get(fk);
    const c = lookupCell(s);
    if (f === undefined) return c;
    const n = fineCount.get(fk) ?? 0;
    if (c === undefined) return f;
    const w = n / (n + 100);
    return Math.exp(w * Math.log(f) + (1 - w) * Math.log(c));
  } },
  { name: 'fine table × speed(session)^.5', fn: (s) => {
    const m = lookupFine(s); if (m === undefined) return NaN;
    const sf = speedFactor(s, 'session');
    return m * Math.min(1.4, Math.max(0.72, Math.sqrt(sf)));
  } },
  { name: '0.8*table + 0.2*v1', fn: (s) => { const m = lookupCell(s); return m === undefined ? NaN : 0.8 * m + 0.2 * s.v1pred; } },
  { name: '0.7*table + 0.3*v1', fn: (s) => { const m = lookupCell(s); return m === undefined ? NaN : 0.7 * m + 0.3 * s.v1pred; } },
  { name: 'fine 0.8 + 0.2*v1', fn: (s) => { const m = lookupFine(s); return m === undefined ? NaN : 0.8 * m + 0.2 * s.v1pred; } },
  {
    name: 'remSteps table × stepMs(blend)',
    fn: (s) => {
      const g = globalStepPrior;
      const stepMs = Number.isFinite(s.turnStepMean) && s.turnStepMean > 0
        ? Math.min(g * 2.5, Math.max(g * 0.4, (s.turnStepMean * 2 + g) / 3))
        : Number.isFinite(s.sessionStepMean) && s.sessionStepMean > 0 ? s.sessionStepMean : g;
      const rem = remStepsByK.get(String(kBucket(s.k))) ?? 0;
      const cur = s.inStep ? Math.max(1000, stepMs - s.stepElapsed) : 0;
      return cur + Math.max(0, rem) * stepMs;
    },
  },
];

console.log('\n== candidates: test ==');
const results = {};
for (const c of candidates) {
  const te = score(test, c.fn);
  const tw = turnWeighted(test, c.fn);
  const short = score(test.filter((s) => s.dur <= 120_000), c.fn);
  const long = score(test.filter((s) => s.dur > 600_000), c.fn);
  results[c.name] = { test: te, turnWeighted: tw, short, long };
  console.log(`${c.name.padEnd(40)} MAE=${fmt(te.mae).padStart(7)} medAE=${fmt(te.medAE).padStart(7)} bias=${fmt(te.bias).padStart(7)} p50=${fmt(te.p50).padStart(7)} | turnMAE=${fmt(tw.mae).padStart(7)} | ≤2m=${fmt(short.mae).padStart(6)} | >10m=${fmt(long.mae).padStart(7)}`);
}

// oracle: median within the test cell itself (upper bound for this feature set)
const testCell = new Map();
for (const s of test) {
  const key = `${kBucket(s.k)}|${eBucket(s.elapsed)}`;
  if (!testCell.has(key)) testCell.set(key, []);
  testCell.get(key).push(s.actual);
}
const oracle = new Map([...testCell].map(([k, xs]) => [k, quantile(xs, 0.5)]));
console.log(`\noracle(table refit on test, same features): MAE=${fmt(score(test, (s) => oracle.get(`${kBucket(s.k)}|${eBucket(s.elapsed)}`)).mae)}`);

if (JSON_OUT) {
  const dump = {
    meta: {
      samples: { train: train.length, test: test.length },
      globalStepPriorMs: Math.round(globalStepPrior),
      globalStepMedianMs: Math.round(globalStepMedian),
      turnDurMedianMs: Math.round(quantile(turnDurTrain, 0.5)),
      turnDurP90Ms: Math.round(quantile(turnDurTrain, 0.9)),
      stepsPerTurnMedian: quantile(turnStepsTrain, 0.5),
      stepsPerTurnP90: quantile(turnStepsTrain, 0.9),
    },
    medianTable: Object.fromEntries([...medianTable].map(([k, v]) => [k, Math.round(v)])),
    fineTable: Object.fromEntries([...fineTable].map(([k, v]) => [k, Math.round(v)])),
    fineKMedian: Object.fromEntries([...fineKMedian].map(([k, v]) => [k, Math.round(v)])),
    medianByK: Object.fromEntries([...medianByK].map(([k, v]) => [k, Math.round(v)])),
    medianPart: Object.fromEntries([...medianPart].map(([k, v]) => [k, Math.round(v)])),
    remStepsByK: Object.fromEntries([...remStepsByK].map(([k, v]) => [k, Math.round(v * 100) / 100])),
    modelStepPrior: Object.fromEntries([...modelStepPrior].map(([k, v]) => [k, Math.round(v)])),
  };
  writeFileSync(JSON_OUT, JSON.stringify(dump, null, 2));
  console.log(`tables → ${JSON_OUT}`);
}
