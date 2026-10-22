/**
 * build-eta-model.mjs — fit the empirical survival tables and emit
 * plugins/dsh-conv-progress/lib/eta-model.js.
 *
 * Model target: ETA = *conditional median of remaining wall-clock time* given
 * only what the plugin can observe while a turn runs:
 *   k       = completed steps of the current turn
 *   elapsed = wall-clock since turn/start
 *
 * Why a table instead of a formula: turn length is genuinely heavy-tailed and
 * bimodal (quick Q&A vs. multi-hour agent loops), and the model itself decides
 * when to stop. A non-parametric conditional median fits that shape exactly and
 * was validated out-of-sample. Two grids are fitted and shrunk together:
 *   fine   k exact ≤ 40, elapsed in 30 s buckets ≤ 20 min
 *   coarse k in bands,     elapsed in bands
 * Small cells shrink toward the coarse estimate (empirical Bayes, pseudo count
 * 40) so the shipped number stays stable instead of fitting noise.
 *
 * Only TRAIN sessions (hash bucket < 7/10) are used, so tools/eval-eta.mjs
 * keeps producing honest out-of-sample numbers on the TEST split.
 *
 * Usage: node tools/build-eta-model.mjs [--data …] [--out …]
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
const OUT = arg('--out', resolve(ROOT, 'plugins/dsh-conv-progress/lib/eta-model.js'));
const PSEUDO_COUNT = 40;
/** Fitted quantile of the remaining-time distribution (0.5 = MAE-optimal in theory). */
const QUANTILE = Number(arg('--quantile', '0.5'));

const bucketOf = (sid) => {
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
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > 15 * 60_000) return true;
  return false;
};
const raw = readFileSync(DATA, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rows = raw.filter((r) => r.end - r.start <= 2 * 3600_000 && !badlyGapped(r));
const train = rows.filter((r) => bucketOf(r.sid) < 7);

const quantile = (xs, q) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// ── bucket definitions (must stay in sync with the emitted lookup code) ─────
const K_FINE = (k) => (k <= 40 ? `k${k}` : k <= 60 ? 'k41-60' : k <= 90 ? 'k61-90' : k <= 130 ? 'k91-130' : 'k130+');
const E_SEGMENTS = [
  [0, 900_000, 30_000], // 0–15 min at 30 s
  [900_000, 2_700_000, 300_000], // 15–45 min at 5 min
  [2_700_000, 7_200_000, 900_000], // 45–120 min at 15 min
  [7_200_000, 21_600_000, 3_600_000], // 2–6 h at 1 h
];
const E_TAIL_INDEX = 45; // index of the "≥ 6 h" cell
const eFineIndex = (ms) => {
  const e = Math.max(0, ms);
  let base = 0;
  for (const [start, end, step] of E_SEGMENTS) {
    if (e < end) return base + Math.floor((e - start) / step);
    base += (end - start) / step;
  }
  return E_TAIL_INDEX;
};
const E_FINE = (e) => `e${eFineIndex(e)}`;
const K_COARSE = (k) => (k === 0 ? '0' : k <= 2 ? String(k) : k <= 4 ? `b${k}` : k <= 8 ? 'b6-8' : k <= 12 ? 'b9-12' : k <= 17 ? 'b13-17' : k <= 25 ? 'b18-25' : k <= 35 ? 'b26-35' : k <= 50 ? 'b36-50' : k <= 70 ? 'b51-70' : k <= 100 ? 'b71-100' : 'b100+');
const E_COARSE_BOUNDS = [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000];
const E_COARSE = (e) => {
  let i = 0;
  while (i < E_COARSE_BOUNDS.length && Math.max(0, e) >= E_COARSE_BOUNDS[i]) i += 1;
  return 'e' + i;
};

// ── sample the turn grid (1 s stride, capped per turn) ─────────────────────
const fineCell = new Map();
const coarseCell = new Map();
const remStepsCell = new Map();
const kMedianCell = new Map();
for (const turn of train) {
  const steps = turn.steps ?? [];
  const dur = turn.end - turn.start;
  const total = steps.length;
  const stride = Math.max(1000, Math.ceil(dur / 400 / 1000) * 1000);
  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (let t = turn.start + stride; t < turn.end; t += stride) {
    let k = 0;
    for (const step of steps) if (step.end <= t) k += 1;
    const actual = turn.end - t;
    const elapsed = t - turn.start;
    push(fineCell, `${K_FINE(k)}|${E_FINE(elapsed)}`, actual);
    push(coarseCell, `${K_COARSE(k)}|${E_COARSE(elapsed)}`, actual);
  }
  for (let k = 0; k <= Math.min(total, 130); k++) {
    push(remStepsCell, K_FINE(k), Math.max(0, total - k));
  }
  for (const step of steps) push(kMedianCell, 'all', step.end - step.start);
}

const medianTable = (cell, minCount) => {
  const out = new Map();
  for (const [key, xs] of cell) if (xs.length >= minCount) out.set(key, Math.round(quantile(xs, QUANTILE)));
  return out;
};
const coarse = medianTable(coarseCell, 12);
const fine = medianTable(fineCell, 25);
const fineN = new Map([...fineCell].map(([key, xs]) => [key, xs.length]));
const remSteps = new Map();
for (const [key, xs] of remStepsCell) remSteps.set(key, Math.round(quantile(xs, 0.5) * 100) / 100);
const stepDurs = kMedianCell.get('all') ?? [];
const stepP50 = Math.round(quantile(stepDurs, 0.5));
const stepMeanMs = Math.round(mean(stepDurs));
const turnDurP50 = Math.round(quantile(train.map((r) => r.end - r.start), 0.5));
const turnDurP90 = Math.round(quantile(train.map((r) => r.end - r.start), 0.9));
const stepsPerTurnP50 = quantile(train.map((r) => r.steps.length), 0.5);

const obj = (map) => JSON.stringify(Object.fromEntries([...map].sort((a, b) => (a[0] < b[0] ? -1 : 1))));

const meta = {
  source: 'data/turns-all.jsonl',
  rawTurns: raw.length,
  trainTurns: train.length,
  stepP50Ms: stepP50,
  stepMeanMs,
  turnDurP50Ms: turnDurP50,
  turnDurP90Ms: turnDurP90,
  stepsPerTurnP50,
  pseudoCount: PSEUDO_COUNT,
  fittedAt: new Date().toISOString(),
};

const file = `/**
 * dsh-conv-progress — fitted ETA model (GENERATED, do not edit by hand).
 *
 * Generated by tools/build-eta-model.mjs from ${raw.length} real turns
 * (${train.length} training turns after hygiene filtering, 70 % split).
 *
 * The tables hold the *conditional median remaining wall-clock time* in ms,
 * keyed by:
 *   fine   \`<kKey>|<elapsedKey>\`   k exact ≤40, elapsed in 30 s buckets ≤20 min
 *   coarse \`<kKey>|<elapsedKey>\`   k bands,          elapsed bands
 *
 * \`fineN\` is the sample count per fine cell; small cells are shrunk toward the
 * coarse estimate at lookup time so the shipped ETA does not chase noise.
 */

/** Dataset / fitting metadata (also surfaced in the service snapshot for debugging). */
export const ETA_MODEL_META = Object.freeze(${JSON.stringify(meta)});

const FINE = ${obj(fine)};

const COARSE = ${obj(coarse)};

const FINE_N = ${obj(fineN)};

const REM_STEPS = ${obj(remSteps)};

const E_SEGMENTS = [
  [0, 900_000, 30_000],
  [900_000, 2_700_000, 300_000],
  [2_700_000, 7_200_000, 900_000],
  [7_200_000, 21_600_000, 3_600_000],
];
const E_TAIL_INDEX = 45;
const E_COARSE_BOUNDS = [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000];
const K_THRESHOLDS = [2, 4, 8, 12, 17, 25, 35, 50, 70, 100];

/** Same bucket functions as the fitting script — keep them in sync. */
export function kFineKey(k) {
  const n = Math.max(0, Math.floor(k));
  return n <= 40 ? 'k' + n : n <= 60 ? 'k41-60' : n <= 90 ? 'k61-90' : n <= 130 ? 'k91-130' : 'k130+';
}
export function eFineKey(elapsedMs) {
  const e = Math.max(0, elapsedMs);
  let base = 0;
  for (const [start, end, step] of E_SEGMENTS) {
    if (e < end) return 'e' + (base + Math.floor((e - start) / step));
    base += (end - start) / step;
  }
  return 'e' + E_TAIL_INDEX;
}
export function kCoarseKey(k) {
  const n = Math.max(0, Math.floor(k));
  if (n === 0) return '0';
  const t = K_THRESHOLDS;
  if (n <= 2) return String(n);
  if (n <= 4) return 'b' + n;
  if (n <= t[2]) return 'b6-8';
  if (n <= t[3]) return 'b9-12';
  if (n <= t[4]) return 'b13-17';
  if (n <= t[5]) return 'b18-25';
  if (n <= t[6]) return 'b26-35';
  if (n <= t[7]) return 'b36-50';
  if (n <= t[8]) return 'b51-70';
  if (n <= t[9]) return 'b71-100';
  return 'b100+';
}
export function eCoarseKey(elapsedMs) {
  const e = Math.max(0, elapsedMs);
  let i = 0;
  while (i < E_COARSE_BOUNDS.length && e >= E_COARSE_BOUNDS[i]) i += 1;
  return 'e' + i;
}

/**
 * Median remaining time for a turn that has completed \`k\` steps and has been
 * running for \`elapsedMs\`.
 *
 * @returns {{etaMs:number, reliability:number, cell:string, samples:number, source:'fine'|'coarse'|'fallback'}}
 */
export function lookupEtaMs(k, elapsedMs) {
  const fineKey = kFineKey(k) + '|' + eFineKey(elapsedMs);
  const coarseKey = kCoarseKey(k) + '|' + eCoarseKey(elapsedMs);
  const fineValue = FINE[fineKey];
  const coarseValue = COARSE[coarseKey];
  if (fineValue !== undefined && coarseValue !== undefined) {
    const n = FINE_N[fineKey] ?? 0;
    const w = n / (n + ${PSEUDO_COUNT});
    return {
      etaMs: Math.exp(w * Math.log(fineValue) + (1 - w) * Math.log(coarseValue)),
      reliability: Math.min(1, w * 1.1),
      cell: fineKey,
      samples: n,
      source: 'fine',
    };
  }
  if (fineValue !== undefined) {
    const n = FINE_N[fineKey] ?? 0;
    return { etaMs: fineValue, reliability: Math.min(1, n / (n + ${PSEUDO_COUNT})), cell: fineKey, samples: n, source: 'fine' };
  }
  if (coarseValue !== undefined) {
    return { etaMs: coarseValue, reliability: 0.55, cell: coarseKey, samples: 0, source: 'coarse' };
  }
  // last resort: 1.5 min for the first steps, growing with the step count
  const fallback = Math.max(90_000, (1 + Math.max(0, k)) * ${stepP50});
  return { etaMs: fallback, reliability: 0.3, cell: coarseKey, samples: 0, source: 'fallback' };
}

/** Median number of steps still to come, given \`k\` completed steps. */
export function medianRemainingSteps(k) {
  const key = kFineKey(k);
  const value = REM_STEPS[key];
  if (value !== undefined) return value;
  const last = REM_STEPS['k130+'] ?? 12;
  return Math.max(1, last);
}

/** Global step-duration priors, used for the step-count display and fallbacks. */
export const STEP_P50_MS = ${stepP50};
export const STEP_MEAN_MS = ${stepMeanMs};
`;

writeFileSync(OUT, file);
console.log(`fitted: ${train.length} train turns → ${OUT}`);
console.log(`fine cells=${fine.size} coarse cells=${coarse.size} remSteps=${remSteps.size} stepP50=${stepP50}ms`);
