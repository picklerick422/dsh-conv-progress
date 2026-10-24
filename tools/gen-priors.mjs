#!/usr/bin/env node
/**
 * gen-priors.mjs — ask an LLM for an up-front work estimate ("prompt-injection prior").
 *
 * Input : data/prompt-sample.jsonl   (tools/extract-prompts.mjs)
 * Output: data/priors.jsonl          { sid, turn, bucket, pred, raw, latencyMs, usage }
 *
 * The estimate is requested *before* the turn runs and sees only what the host
 * knows at turn start: the user task text, the working directory, the selected
 * model. Nothing from the future of the turn leaks into the prompt.
 *
 * Every call is cached in the output file: re-running skips completed rows.
 *
 * Usage:
 *   node tools/gen-priors.mjs [--limit 500] [--concurrency 8] [--model deepseek-flash]
 *                             [--in data/prompt-sample.jsonl] [--out data/priors.jsonl]
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const IN = resolve(ROOT, opt('--in', 'data/prompt-sample.jsonl'));
const OUT = resolve(ROOT, opt('--out', 'data/priors.jsonl'));
const LIMIT = Number(opt('--limit', '10000'));
const CONCURRENCY = Number(opt('--concurrency', '8'));
const MODEL = opt('--model', 'deepseek-flash');
const VARIANT = opt('--variant', 'v1');
const TIMEOUT_MS = Number(opt('--timeout', '30000'));
const KEY = process.env.DEEPSEEK_API_KEY ?? (() => {
  const yaml = readFileSync(`${process.env.HOME ?? '/home/user'}/.dsh/.credentials.yaml`, 'utf8');
  const match = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m.exec(yaml);
  if (!match) throw new Error('DEEPSEEK_API_KEY not found in ~/.dsh/.credentials.yaml');
  return match[1];
})();

const SYSTEM_V1 = `You are the planning head of an autonomous coding agent (DeepSeek Harness).
A user task is about to start. Estimate the TOTAL amount of work it will take.

Answer with STRICT JSON only, no prose, no code fence:
{"steps": <int>, "tools": <int>, "minutes": <number>, "plan_items": <int>, "confidence": "low"|"medium"|"high"}

Field meanings:
- steps: number of assistant steps (one model round that may call tools). A trivial reply is 1; a small edit is 2-4; a multi-file feature is 8-25; a big refactor or investigation is 25+.
- tools: total tool calls across the whole turn (bash/read/edit/write/grep/...).
- minutes: wall-clock minutes until the final answer, including tool time.
- plan_items: how many checklist items a careful engineer would track (0 when the task needs no plan).
- confidence: how sure you are about the ballpark (low when the task text is vague).

Be calibrated rather than optimistic: long investigations are common.`;

const SYSTEM_V2 = `You are the planning head of an autonomous coding agent (DeepSeek Harness).
A user task is about to start. Choose the work-size bucket, not a point estimate.

Answer with STRICT JSON only, no prose, no code fence:
{"steps_bucket": <one of the bucket labels>, "minutes_bucket": <one of the bucket labels>, "confidence": "low"|"medium"|"high"}

Allowed step buckets: "1", "2-3", "4-6", "7-10", "11-16", "17-25", "26-40", "41-70", "71+".
Allowed minute buckets: "1-2", "3-6", "7-15", "16-30", "31-60", "61-120", "120+".

Bucket meanings (total across the whole turn):
- 1: a one-shot reply, no tools or a single trivial tool call.
- 2-3: read one file and answer, or one small edit.
- 4-6: a focused edit with a couple of verification reads.
- 7-10: several files touched, or one investigation with a few greps.
- 11-16: a small feature/bugfix: read, edit, run tests, fix.
- 17-25: multi-file change or a deep investigation.
- 26-40: a large refactor or a long debugging session.
- 41-70: very large multi-step work.
- 71+: unbounded exploration, e.g. "keep going until done", long running jobs.

Reference examples (real sessions, anonymised):
- "帮我看看这个文件里的函数是干什么的" → steps "2-3", minutes "1-2".
- "修复登录页在移动端的布局错位，顺便加个回归测试" → steps "11-16", minutes "16-30".
- "调研一下 XX 方案的可行性，给出实现建议" → steps "17-25", minutes "31-60".
- "把整个插件迁移到仓库根目录并更新所有引用，然后发布新版本" → steps "26-40", minutes "61-120".

Be calibrated rather than optimistic: long investigations are common.`;

const SYSTEM = VARIANT === 'v2' ? SYSTEM_V2 : SYSTEM_V1;
const MAX_TOKENS = VARIANT === 'v2' ? 120 : 300;

const estimatePrompt = (row) => {
  const dir = row.cwd ? row.cwd.split('/').filter(Boolean).slice(-2).join('/') : '(unknown)';
  return `Task (from the user):
${row.prompt}

Context:
- working directory: ${dir}
- agent model: ${row.model}
- this is turn ${row.turn} of the session

Return the JSON estimate only.`;
};

/** One chat call with retries; returns {text, usage, latencyMs}. */
async function callOnce(row) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          max_tokens: MAX_TOKENS,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: estimatePrompt(row) },
          ],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body?.error?.message ?? 'unknown'}`);
      const text = body?.choices?.[0]?.message?.content ?? '';
      const pred = parsePrediction(text); // throw → retry with a stricter reminder
      return { text, usage: body?.usage ?? null, latencyMs: Date.now() - started, pred };
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw lastError;
}

const STEP_BUCKETS = { '1': 1, '2-3': 2.5, '4-6': 5, '7-10': 8.5, '11-16': 13, '17-25': 21, '26-40': 33, '41-70': 55, '71+': 90 };
const MINUTE_BUCKETS = { '1-2': 1.5, '3-6': 4.5, '7-15': 11, '16-30': 22, '31-60': 45, '61-120': 90, '120+': 150 };

function parsePrediction(text) {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error(`no JSON object in response: ${text.slice(0, 120)}`);
  const parsed = JSON.parse(match[0]);
  if (VARIANT === 'v2') {
    const stepsKey = String(parsed.steps_bucket ?? '').trim();
    const minutesKey = String(parsed.minutes_bucket ?? '').trim();
    const steps = STEP_BUCKETS[stepsKey];
    const minutes = MINUTE_BUCKETS[minutesKey];
    if (steps === undefined || minutes === undefined) {
      throw new Error(`unknown bucket: ${stepsKey} / ${minutesKey}`);
    }
    return {
      steps,
      stepsKey,
      tools: Math.round(steps * 1.6),
      minutes,
      minutesKey,
      planItems: null,
      confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'medium',
    };
  }
  const num = (value, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  };
  const pred = {
    steps: num(parsed.steps, 1, 500),
    tools: num(parsed.tools, 0, 2000),
    minutes: num(parsed.minutes, 0, 2400),
    planItems: num(parsed.plan_items ?? parsed.planItems, 0, 100),
    confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'medium',
  };
  if (pred.steps === null || pred.minutes === null) throw new Error(`incomplete estimate: ${text.slice(0, 120)}`);
  return pred;
}

const rows = readFileSync(IN, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).slice(0, LIMIT);
const done = new Set();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (!row.error) done.add(`${row.sid}#${row.turn}`);
    } catch {
      /* ignore truncated tail */
    }
  }
}
const todo = rows.filter((row) => !done.has(`${row.sid}#${row.turn}`));
console.log(`priors: ${done.size} cached, ${todo.length} to generate (model ${MODEL})`);

let cursor = 0;
let ok = 0;
let failed = 0;
const results = [];
async function worker(id) {
  while (cursor < todo.length) {
    const row = todo[cursor];
    cursor += 1;
    const started = Date.now();
    let record;
    try {
      const { text, usage, latencyMs, pred } = await callOnce(row);
      record = { sid: row.sid, turn: row.turn, bucket: row.bucket, pred, raw: text.slice(0, 400), usage, latencyMs };
      ok += 1;
    } catch (error) {
      record = { sid: row.sid, turn: row.turn, bucket: row.bucket, error: String(error?.message ?? error), latencyMs: Date.now() - started };
      failed += 1;
    }
    results.push(record);
    if (results.length % 20 === 0 || cursor === todo.length) {
      process.stdout.write(`\r  ${cursor}/${todo.length} (ok ${ok}, fail ${failed})`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, todo.length)) }, (_, i) => worker(i)));
appendFileSync(OUT, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`);
console.log(`\nwrote ${results.length} rows → ${OUT}`);
