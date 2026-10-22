/**
 * diag-wrapper.mjs — attribute the estimator *wrapper* error (EMA, percent,
 * plan blend) vs. the raw table value. For the same samples it reports both
 * `breakdown.etaRawMs` (table output before smoothing) and `etaMs` (smoothed,
 * what the UI shows), bucketed by elapsed and by displayed progress.
 *
 * Usage: node tools/diag-wrapper.mjs [--data …] [--split test]
 */
import { readFileSync } from 'node:fs';
import { createModel, beginTurn, observeTurn, estimate } from '../plugins/dsh-conv-progress/lib/estimator.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const DATA = arg('--data', new URL('../data/turns-all.jsonl', import.meta.url).pathname);
const SPLIT = arg('--split', 'test');

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
const inSplit = (sid) => (SPLIT === 'test' ? bucketOf(sid) >= 7 : SPLIT === 'train' ? bucketOf(sid) < 7 : true);

const rows = readFileSync(DATA, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const bySession = new Map();
for (const row of rows) {
  if (!inSplit(row.sid) || row.reason !== 'completed') continue;
  if (row.end - row.start > 2 * 3600_000 || badlyGapped(row)) continue;
  if (!bySession.has(row.sid)) bySession.set(row.sid, []);
  bySession.get(row.sid).push(row);
}

const groups = new Map();
const push = (key, sample) => {
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(sample);
};
for (const [sid, turns] of bySession) {
  turns.sort((a, b) => a.start - b.start);
  const model = createModel();
  for (const turn of turns) {
    beginTurn(model, turn.turn ?? 0);
    const steps = turn.steps ?? [];
    for (let t = turn.start + 1000; t < turn.end; t += 1000) {
      let stepsDone = 0;
      let stepStartedAt = null;
      for (const step of steps) {
        if (step.end <= t) stepsDone += 1;
        else if (stepStartedAt === null) stepStartedAt = step.start;
      }
      const out = estimate(model, {
        running: true,
        now: t,
        turn: turn.turn ?? 0,
        stepsDone,
        stepStartedAt,
        todos: null,
        turnStartedAt: turn.start,
      });
      const sample = {
        raw: out.breakdown.etaRawMs,
        smooth: out.etaMs,
        actual: turn.end - t,
        progress: (t - turn.start) / (turn.end - turn.start),
        elapsed: t - turn.start,
      };
      push('overall', sample);
      push(`elapsed ${sample.elapsed < 30_000 ? '<30s' : sample.elapsed < 120_000 ? '30s-2m' : sample.elapsed < 600_000 ? '2-10m' : sample.elapsed < 1_800_000 ? '10-30m' : '>30m'}`, sample);
      push(`progress ${sample.progress < 0.5 ? '<50%' : sample.progress < 0.75 ? '50-75%' : sample.progress < 0.9 ? '75-90%' : '90-100%'}`, sample);
    }
    observeTurn(model, { durationMs: turn.end - turn.start, steps: steps.length, todoDelta: 0 });
  }
}

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;
for (const family of ['overall', 'elapsed', 'progress']) {
  const entries = [...groups].filter(([key]) => key.split(' ')[0] === family);
  for (const [key, samples] of entries) {
    const stat = (field) => {
      const preds = samples.map((s) => s[field]);
      const errs = samples.map((s) => s[field] - s.actual);
      return {
        bias: mean(errs),
        mae: mean(errs.map(Math.abs)),
        med: q(errs.map(Math.abs), 0.5),
      };
    };
    const raw = stat('raw');
    const smooth = stat('smooth');
    console.log(
      `${key.padEnd(30)} n=${String(samples.length).padStart(7)} raw: bias=${(raw.bias >= 0 ? '+' : '') + fmt(raw.bias)} MAE=${fmt(raw.mae)}` +
        ` | smooth: bias=${(smooth.bias >= 0 ? '+' : '') + fmt(smooth.bias)} MAE=${fmt(smooth.mae)}`,
    );
  }
}
