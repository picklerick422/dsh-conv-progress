#!/usr/bin/env node
/**
 * eval-v3.mjs — score the *deployed* v3 code path offline.
 *
 * Reads data/samples.csv (same replay samples used to train/evaluate the Python
 * model), builds the feature vector in `model.features` order, runs the real
 * inference module `lib/eta-v3.js`, and reports the same metrics as the Python
 * study. Because the CSV columns were produced by the same feature builder the
 * host will use, agreement here means the exported model + JS evaluator are
 * correct; it does not by itself prove the host assembles identical values (that
 * is checked separately by tools/check-features.mjs).
 *
 * Usage:
 *   node tools/eval-v3.mjs --model data/eta-v3-model-v31.json [--out data/v3-pred.csv]
 */
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { predictRemainingMs, validateModel, describeModel } from '../lib/eta-v3.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const MODEL_PATH = resolve(ROOT, opt('--model', 'data/eta-v3-model-v31.json'));
const DATA_PATH = resolve(ROOT, opt('--data', 'data/samples.csv'));
const OUT_PATH = opt('--out', '');

const model = validateModel(JSON.parse(readFileSync(MODEL_PATH, 'utf8')));
console.log('model:', JSON.stringify(describeModel(model)));
const features = model.features;
const index = new Map(features.map((name, i) => [name, i]));

const stats = new Map(); // split -> { n, absErr, sqErr, err, sumRel, within30, within50, confs }
const preds = [];

const fmt = (ms) => (Math.abs(ms) >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`);

function record(split, pred, actual, confidence) {
  let s = stats.get(split);
  if (!s) {
    s = { n: 0, absErr: 0, sqErr: 0, err: 0, sumRel: 0, within30: 0, within50: 0,
          confs: { high: { n: 0, absErr: 0, sumRel: 0 }, medium: { n: 0, absErr: 0, sumRel: 0 }, low: { n: 0, absErr: 0, sumRel: 0 } } };
    stats.set(split, s);
  }
  const err = pred - actual;
  const absErr = Math.abs(err);
  const rel = absErr / Math.max(3_000, actual);
  s.n += 1;
  s.absErr += absErr;
  s.sqErr += err * err;
  s.err += err;
  s.sumRel += Math.min(rel, 5);
  if (absErr <= 0.3 * Math.max(actual, 3_000)) s.within30 += 1;
  if (absErr <= 0.5 * Math.max(actual, 3_000)) s.within50 += 1;
  const conf = s.confs[confidence];
  conf.n += 1;
  conf.absErr += absErr;
  conf.sumRel += Math.min(rel, 5);
}

const lines = createInterface({ input: createReadStream(DATA_PATH), crlfDelay: Infinity });
let header = null;
let columns = null;
let rows = 0;
const startedAt = Date.now();
for await (const line of lines) {
  if (header === null) {
    header = line.split(',');
    columns = features.map((name) => header.indexOf(name));
    const missing = features.filter((name, i) => columns[i] < 0);
    if (missing.length) throw new Error(`missing feature columns: ${missing.join(', ')}`);
    continue;
  }
  const cells = line.split(',');
  const values = new Array(features.length).fill(0);
  for (let i = 0; i < features.length; i += 1) {
    const column = columns[i];
    const raw = column >= 0 ? Number(cells[column]) : 0;
    values[i] = Number.isFinite(raw) ? raw : 0;
  }
  const split = cells[header.indexOf('split')];
  const actual = Number(cells[header.indexOf('remaining_ms')]);
  const result = predictRemainingMs(model, values);
  record(split, result.etaMs, actual, result.confidence);
  if (OUT_PATH) {
    preds.push([
      split, cells[header.indexOf('sid')], cells[header.indexOf('turn')],
      cells[header.indexOf('t_rel')], cells[header.indexOf('k')],
      cells[header.indexOf('dur_ms')], cells[header.indexOf('n_prev_turns')],
      Math.round(result.etaMs), Math.round(result.loMs), Math.round(result.hiMs),
      Math.round(actual), result.confidence, result.bucket,
    ].join(','));
  }
  rows += 1;
}
console.log(`rows=${rows} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
for (const split of ['train', 'calib', 'test']) {
  const s = stats.get(split);
  if (!s) continue;
  console.log(`\n[${split}] n=${s.n}  MAE=${fmt(s.absErr / s.n)}  bias=${fmt(s.err / s.n)}  `
    + `RMSE=${fmt(Math.sqrt(s.sqErr / s.n))}  MAPE=${(s.sumRel / s.n).toFixed(2)}  `
    + `±30%=${((100 * s.within30) / s.n).toFixed(1)}%  ±50%=${((100 * s.within50) / s.n).toFixed(1)}%`);
  for (const [name, conf] of Object.entries(s.confs)) {
    if (conf.n === 0) continue;
    console.log(`   conf=${name.padEnd(6)} n=${conf.n}  MAE=${fmt(conf.absErr / conf.n)}  MAPE=${(conf.sumRel / conf.n).toFixed(2)}`);
  }
}
if (OUT_PATH) {
  writeFileSync(resolve(ROOT, OUT_PATH),
    `split,sid,turn,t_rel,k,dur_ms,n_prev_turns,v3_pred,v3_lo,v3_hi,v3_actual,confidence,bucket\n${preds.join('\n')}\n`);
  console.log(`\npredictions → ${OUT_PATH}`);
}
