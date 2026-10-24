#!/usr/bin/env node
/**
 * extract-prompts.mjs — pull the *text* of the user task prompt for sampled turns.
 *
 * The shipped feature pipeline deliberately never stores prompt text. The
 * prompt-injection experiment is the one place that needs it, so this tool
 * re-reads the sampled sessions and emits only the sampled turns, capped at
 * PROMPT_CHARS characters, to a local scratch file that never leaves the repo.
 *
 * Sampling is deterministic: session bucket = hash(session id) % 10, the same
 * scheme `tools/dump-samples.mjs` uses (0-6 train, 7-8 calib, 9 test).
 *
 * Usage:
 *   node tools/extract-prompts.mjs --train 300 --test 200 [--out data/prompt-sample.jsonl]
 *
 * Output row: { sid, turn, bucket, ws, cwd, model, prompt, promptChars, actualSteps, durMs }
 */
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT ?? join(homedir(), '.dsh', 'sessions');
const SESSIONS_JSONL = resolve(ROOT, opt('--turns', 'data/turns2.jsonl'));
const OUT = resolve(ROOT, opt('--out', 'data/prompt-sample.jsonl'));
const WANT_TRAIN = Number(opt('--train', '300'));
const WANT_TEST = Number(opt('--test', '200'));
const PROMPT_CHARS = Number(opt('--chars', '4000'));
const MAX_DUR_MS = Number(opt('--max-dur', String(2 * 60 * 60 * 1000)));
const MIN_DUR_MS = Number(opt('--min-dur', '30000'));

/** Session id → bucket, identical to dump-samples: FNV-1a % 10. */
function bucketOf(sid) {
  let h = 2166136261;
  for (let i = 0; i < sid.length; i += 1) {
    h ^= sid.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 10;
}

/** Index every session log by bare session id. */
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
      const match = /(?:^|\/)(?:session-)?([0-9a-f-]{36})\/session\.v4\.jsonl$/.exec(text);
      if (match) out.set(match[1], join(SESSIONS_ROOT, workspace, text));
    }
  }
  return out;
}

/**
 * Read the real user prompt of one turn, plus its step budget.
 *
 * Log order inside a turn is `turn/start` *then* the user message (the harness
 * opens the turn before admitting the submission), so the prompt of turn N is
 * the first real user message seen after that turn's start.
 */
function readTurn(file, turnNumber) {
  const text = readFileSync(file, 'utf8');
  const meta = JSON.parse(text.slice(0, text.indexOf('\n')));
  const target = Number(turnNumber);
  let current = null;
  let prompt = null;
  let steps = 0;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    if (!line.includes('turn/start') && !line.includes('user/message') && !line.includes('step/start')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      current = Number(data.turn);
      if (current > target) break;
      continue;
    }
    if (current !== target) continue;
    if (event.type === 'step/start') {
      steps += 1;
      continue;
    }
    const kind = data?.source?.kind;
    if (kind === undefined || kind === 'user') {
      const content = Array.isArray(data.content) ? data.content : [];
      const body = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
      if (prompt === null && body.length > 0) prompt = body;
    }
  }
  return { cwd: meta.cwd ?? '', prompt, steps };
}

/** Pick turns deterministically, newest sessions first, balanced across buckets. */
const all = new Map(); // sid → [{turn,...}]
const reader = createInterface({ input: createReadStream(SESSIONS_JSONL), crlfDelay: Infinity });
for await (const line of reader) {
  if (line.length === 0) continue;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  if (row.durMs < MIN_DUR_MS || row.durMs > MAX_DUR_MS) continue;
  if (!row.prompt || row.prompt.chars < 40) continue;
  const bucket = bucketOf(row.sid);
  if (bucket !== 9 && bucket > 6) continue; // only train + test
  if (!all.has(row.sid)) all.set(row.sid, []);
  all.get(row.sid).push(row);
}

const files = sessionFiles();
const candidates = [...all.entries()]
  .sort(([a], [b]) => (a < b ? 1 : -1))
  .flatMap(([sid, rows]) => rows.sort((x, y) => y.start - x.start).map((row) => ({ sid, row: { ...row, bucket: bucketOf(sid) } })));

const picked = { train: [], test: [] };
for (const item of candidates) {
  const key = item.row.bucket === 9 ? 'test' : 'train';
  if (picked[key].length >= (key === 'test' ? WANT_TEST : WANT_TRAIN)) continue;
  const file = files.get(item.sid);
  if (!file) continue;
  let detail;
  try {
    detail = readTurn(file, item.row.turn);
  } catch {
    continue;
  }
  if (!detail.prompt || detail.prompt.length < 40) continue;
  picked[key].push({
    sid: item.sid,
    turn: item.row.turn,
    bucket: item.row.bucket,
    ws: item.row.ws,
    cwd: item.row.cwd,
    model: item.row.model,
    prompt: detail.prompt.slice(0, PROMPT_CHARS),
    promptChars: detail.prompt.length,
    actualSteps: detail.steps,
    durMs: item.row.durMs,
  });
}

const rows = [...picked.train, ...picked.test];
const { writeFileSync } = await import('node:fs');
writeFileSync(OUT, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
console.log(`sampled: train ${picked.train.length} / test ${picked.test.length} → ${OUT}`);
console.log(`median prompt chars: ${rows.map((r) => r.promptChars).sort((a, b) => a - b)[Math.floor(rows.length / 2)]}`);
