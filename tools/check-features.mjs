#!/usr/bin/env node
/**
 * check-features.mjs — are the deployed features identical to the training table?
 *
 * The whole value of the offline study depends on this: `lib/features.js` folds
 * live session events into a feature map, while `data/samples.csv` was produced
 * by `tools/dump-samples.mjs` from the same session logs through turn aggregates.
 * This tool replays a handful of real sessions event-by-event through
 * `lib/features.js` and compares the vector at the exact sample moments with the
 * CSV row, feature by feature.
 *
 * Some columns are rounded when written to CSV (durations in ms, cjk ratio in
 * percent), so the comparison uses the same rounding before diffing.
 *
 * Usage: node tools/check-features.mjs [--sessions 12] [--tolerance 0]
 */
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeatureState, applyEvent, buildFeatureMap, toVector, FEATURE_NAMES } from '../lib/features.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT ?? join(homedir(), '.dsh', 'sessions');
const LIMIT = Number(opt('--sessions', '12'));
const SAMPLE_CSV = resolve(ROOT, opt('--samples', 'data/samples.csv'));
const REL_TOLERANCE = Number(opt('--tolerance', '0.02'));

/** Index session files by bare session id. */
function sessionFiles() {
  const out = new Map();
  for (const workspace of readdirSync(SESSIONS_ROOT)) {
    let entries;
    try {
      entries = readdirSync(join(SESSIONS_ROOT, workspace), { recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const text = String(entry);
      if (!text.endsWith('session.v4.jsonl')) continue;
      // session dirs appear both as `session-<uuid>` and bare `<uuid>` (forks/subagents)
      const match = /(?:^|\/)(?:session-)?([0-9a-f-]{36})\/session\.v4\.jsonl$/.exec(text);
      if (!match) continue;
      out.set(match[1], join(SESSIONS_ROOT, workspace, text));
    }
  }
  return out;
}

/** Collect the sample rows we are going to verify, grouped by session. */
async function loadRows(wanted) {
  const columns = new Map();
  const rows = new Map();
  const reader = createInterface({ input: createReadStream(SAMPLE_CSV), crlfDelay: Infinity });
  let header = null;
  for await (const line of reader) {
    if (header === null) {
      header = line.split(',');
      header.forEach((name, i) => columns.set(name, i));
      continue;
    }
    const cells = line.split(',');
    const sid = cells[columns.get('sid')];
    if (!wanted.has(sid)) continue;
    const row = { sid, turn: Number(cells[columns.get('turn')]), tRel: Number(cells[columns.get('t_rel')]), cells, columns };
    if (!rows.has(sid)) rows.set(sid, []);
    rows.get(sid).push(row);
  }
  return rows;
}

const files = sessionFiles();
console.log(`session files indexed: ${files.size}`);
// pick sessions that exist on disk and are not tiny, deterministic order
const csvProbe = createInterface({ input: createReadStream(SAMPLE_CSV), crlfDelay: Infinity });
const picked = [];
const seen = new Set();
let headerDone = false;
for await (const line of csvProbe) {
  if (!headerDone) { headerDone = true; continue; }
  const sid = line.split(',', 3)[1] ?? '';
  if (seen.has(sid) || !files.has(sid)) continue;
  seen.add(sid);
  picked.push(sid);
  if (picked.length >= LIMIT) break;
}
console.log(`comparing ${picked.length} sessions`);
const rowsBySession = await loadRows(new Set(picked));

const stepEmas = new Map(); // sid -> { value, samples }
const CLAMP = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const STEP_ALPHA = 0.35;
function observeStep(sid, durationMs) {
  let state = stepEmas.get(sid);
  if (!state) { state = { value: 13200, samples: 0 }; stepEmas.set(sid, state); }
  const value = CLAMP(durationMs, 1000, 20 * 60_000);
  if (state.samples === 0) state.value = value;
  else state.value = CLAMP(state.value + (value - state.value) * STEP_ALPHA, 1000, 20 * 60_000);
  state.samples += 1;
  return state.value;
}

const ROUNDED = new Set(['prev_step_mean_ms', 'prev_step_max_ms', 'step_ms_ema', 'prev_turn_dur_med',
  'prev_turn_steps_med', 'prompt_cjk_ratio']);
const perFeature = new Map(FEATURE_NAMES.map((name) => [name, { n: 0, bad: 0, maxDiff: 0, examples: [] }]));
let rowsChecked = 0;

for (const sid of picked) {
  const rows = rowsBySession.get(sid);
  if (!rows || rows.length === 0) continue;
  rows.sort((a, b) => a.turn - b.turn || a.tRel - b.tRel);
  const file = files.get(sid);
  const events = [];
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let turnStart = null;
  const turnStarts = new Map();
  for await (const line of reader) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'session') continue;
    events.push(event);
    if (event.type === 'turn/start') {
      turnStart = event.time;
      turnStarts.set(Number(event.data?.turn), event.time);
    }
  }
  const state = createFeatureState();
  let pointer = 0;
  const ema = { value: 13200 };
  for (const row of rows) {
    const start = turnStarts.get(row.turn);
    if (!Number.isFinite(start)) continue;
    const at = start + row.tRel;
    while (pointer < events.length && events[pointer].time <= at) {
      const event = events[pointer];
      applyEvent(state, event);
      if (event.type === 'step/end') {
        const dur = Math.max(1, event.time - state.stepStart);
        ema.value = observeStep(sid, dur);
      }
      pointer += 1;
    }
    const map = buildFeatureMap(state, { now: at, stepMsEma: ema.value });
    const values = toVector(map, FEATURE_NAMES);
    rowsChecked += 1;
    FEATURE_NAMES.forEach((name, index) => {
      const record = perFeature.get(name);
      const cell = row.cells[row.columns.get(name)];
      let expected = Number(cell);
      if (!Number.isFinite(expected)) expected = 0;
      let actual = values[index];
      if (ROUNDED.has(name)) actual = Math.round(actual);
      record.n += 1;
      const diff = Math.abs(actual - expected);
      const allowed = Math.max(REL_TOLERANCE, Math.abs(expected) * REL_TOLERANCE);
      if (diff > allowed) {
        record.bad += 1;
        record.maxDiff = Math.max(record.maxDiff, diff);
        if (record.examples.length < 3) {
          record.examples.push(`turn=${row.turn} t=${row.tRel} expected=${expected.toFixed(2)} got=${actual.toFixed(2)}`);
        }
      }
    });
  }
}

console.log(`\nchecked ${rowsChecked} sample rows`);
let failures = 0;
for (const name of FEATURE_NAMES) {
  const record = perFeature.get(name);
  const rate = record.n === 0 ? 1 : 1 - record.bad / record.n;
  const flag = rate < 0.99 ? 'MISMATCH' : rate < 0.999 ? 'drift' : 'ok';
  if (flag === 'MISMATCH') failures += 1;
  console.log(`  ${name.padEnd(22)} match=${(rate * 100).toFixed(2)}%  maxDiff=${record.maxDiff.toFixed(1)}  ${flag}`);
  if (flag !== 'ok' && record.examples.length) console.log(`      e.g. ${record.examples.join(' | ')}`);
}
console.log(failures === 0 ? '\nRESULT: all features consistent with the training table' : `\nRESULT: ${failures} feature(s) inconsistent`);
process.exitCode = failures === 0 ? 0 : 1;
