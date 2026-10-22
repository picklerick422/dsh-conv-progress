/**
 * diag-eta.mjs — measure the *fitted table* itself, independent of the
 * estimator wrapper (no EMA, no percent, no plan blend).
 *
 * For every sampled instant of every TEST-split turn it compares
 * `lookupEtaMs(k, elapsed)` with the truth and prints signed bias / MAE per
 * bucket, so we can tell whether a problem sits in the table or in the
 * percent/smoothing layer on top of it.
 *
 * Usage: node tools/diag-eta.mjs [--data …] [--split test]
 */
import { readFileSync } from 'node:fs';
import { lookupEtaMs } from '../plugins/dsh-conv-progress/lib/eta-model.js';

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
const turns = rows.filter((r) => r.reason === 'completed' && r.end - r.start <= 2 * 3600_000 && !badlyGapped(r) && inSplit(r.sid));

const buckets = new Map();
const add = (key, pred, actual) => {
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push([pred, actual]);
};
for (const turn of turns) {
  const steps = turn.steps ?? [];
  const dur = turn.end - turn.start;
  const stride = Math.max(1000, Math.ceil(dur / 400 / 1000) * 1000);
  for (let t = turn.start + stride; t < turn.end; t += stride) {
    let k = 0;
    for (const step of steps) if (step.end <= t) k += 1;
    const elapsed = t - turn.start;
    const actual = turn.end - t;
    const { etaMs } = lookupEtaMs(k, elapsed);
    add('overall', etaMs, actual);
    add(`elapsed ${elapsed < 30_000 ? '<30s' : elapsed < 120_000 ? '30s-2m' : elapsed < 600_000 ? '2-10m' : elapsed < 1_800_000 ? '10-30m' : '>30m'}`, etaMs, actual);
    add(`steps ${k === 0 ? '0' : k <= 2 ? '1-2' : k <= 7 ? '3-7' : k <= 19 ? '8-19' : '20+'}`, etaMs, actual);
    add(`remaining ${actual < 30_000 ? '<30s' : actual < 120_000 ? '30s-2m' : actual < 600_000 ? '2-10m' : '>10m'}`, etaMs, actual);
  }
}
const groups = new Map();
for (const [key, xs] of buckets) {
  const family = key.split(' ')[0];
  if (!groups.has(family)) groups.set(family, []);
  groups.get(family).push([key, xs]);
}
const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};
const min = (ms) => `${(ms / 60_000).toFixed(1)}m`;
for (const family of ['overall', 'elapsed', 'steps', 'remaining']) {
  const rows2 = groups.get(family) ?? [];
  if (family !== 'overall') rows2.sort((a, b) => b[1].length - a[1].length);
  for (const [key, xs] of rows2) {
    const preds = xs.map(([p]) => p);
    const actuals = xs.map(([, a]) => a);
    const errs = xs.map(([p, a]) => p - a);
    const abs = errs.map(Math.abs);
    const mae = abs.reduce((a, b) => a + b, 0) / abs.length;
    const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
    console.log(
      `${key.padEnd(28)} n=${String(xs.length).padStart(7)} predmed=${min(q(preds, 0.5)).padStart(7)} ` +
        `actmed=${min(q(actuals, 0.5)).padStart(7)} MAE=${min(mae).padStart(7)} bias=${(bias >= 0 ? '+' : '') + min(bias)}`,
    );
  }
}
