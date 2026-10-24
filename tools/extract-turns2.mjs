/**
 * extract-turns2.mjs — turn-level dataset builder, v2.
 *
 * Same as extract-turns.mjs but adds turn-start observables that are available
 * *before* any step has run (this is what an "ask the model for a plan first"
 * strategy could condition on):
 *
 *   prompt: { chars, lines, codeFences, commands, mentions, hasImage, blocks, cjk, questionMarks }
 *   todosPlan: n (model-authored plan size at first todo/write) + todoTimeline
 *
 * Emit per finished turn:
 *   { sid, ws, model, turn, start, end, durMs, reason, todos, todoTimeline,
 *     prompt, steps: [{ n, start, end, first, tools:[{name,start,end}] }] }
 *
 * Usage: node tools/extract-turns2.mjs [maxFiles] [out]
 */
import { readdirSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT ?? join(homedir(), '.dsh', 'sessions');
const OUT = process.argv[3] ?? resolve(ROOT, 'data/turns2.jsonl');
const MAX_FILES = Number(process.argv[2] ?? 0) || Infinity;

const NEEDLES = ['"type":"turn/start"', '"type":"turn/end"', '"type":"step/start"', '"type":"step/end"',
  '"type":"tool/call"', '"type":"tool/result"', '"type":"assistant/message"', '"type":"todo/write"',
  '"type":"user/message"', '"type":"request/context"'];

function listSessions() {
  const out = [];
  const seen = new Set();
  for (const workspace of readdirSync(SESSIONS_ROOT)) {
    const workspaceDir = join(SESSIONS_ROOT, workspace);
    let entries;
    try { entries = readdirSync(workspaceDir, { recursive: true }); } catch { continue; }
    for (const entry of entries) {
      if (!String(entry).endsWith('session.v4.jsonl')) continue;
      const file = join(workspaceDir, entry);
      if (seen.has(file)) continue;
      seen.add(file);
      let size = 0;
      try { size = statSync(file).size; } catch { continue; }
      if (size < 2_000) continue;
      out.push({ file, size, workspace });
    }
  }
  out.sort((a, b) => a.size - b.size);
  return out;
}

function header(file) {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(4096);
  const n = readSync(fd, buf, 0, 4096, 0);
  closeSync(fd);
  const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
  try { return JSON.parse(first); } catch { return {}; }
}

/** Turn-start prompt features. Never stores the prompt text itself. */
function promptFeatures(content) {
  const blocks = Array.isArray(content) ? content : [];
  let text = '';
  let hasImage = false;
  let textBlocks = 0;
  for (const block of blocks) {
    const type = block?.type;
    if (type === 'text' && typeof block.text === 'string') { text += block.text; textBlocks += 1; }
    else if (type === 'image' || type === 'image_url') hasImage = true;
  }
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  return {
    chars: text.length,
    lines: text.length === 0 ? 0 : text.split('\n').length,
    codeFences: (text.match(/```/g) ?? []).length >> 1,
    commands: (text.match(/(^|\s)\/[\w-]+/g) ?? []).length,
    mentions: (text.match(/(^|\s)@[\w./-]+/g) ?? []).length,
    questionMarks: (text.match(/[?？]/g) ?? []).length,
    hasImage,
    blocks: blocks.length,
    textBlocks,
    cjkRatio: text.length === 0 ? 0 : Math.round((cjk / text.length) * 100) / 100,
    asciiRatio: text.length === 0 ? 0 : Math.round((letters / text.length) * 100) / 100,
  };
}

function extract(file, workspace) {
  const text = readFileSync(file, 'utf8');
  const meta = header(file);
  const sid = meta.id ?? file;
  const cwd = meta.cwd ?? '';
  const turns = [];
  let turn = null;
  let step = null;
  let model = '';
  let pendingPrompt = null;                 // user message seen before turn/start
  const callIndex = new Map();

  const closeStep = (time) => {
    if (step === null) return;
    step.end = step.end ?? time;
    if (step.tools.length > 0 && step.tools[step.tools.length - 1].end === null) {
      step.tools[step.tools.length - 1].end = time;
    }
    step = null;
  };

  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let hit = false;
    for (const needle of NEEDLES) { if (line.includes(needle)) { hit = true; break; } }
    if (!hit) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const type = event.type;
    const time = Number(event.time) || 0;
    const data = event.data ?? {};

    if (type === 'request/context') { model = data.model ?? model; continue; }

    if (type === 'user/message') {
      // Only the real user submission; harness-injected messages have another source.kind.
      const kind = data?.source?.kind;
      if (kind === undefined || kind === 'user') {
        const feature = promptFeatures(data.content);
        if (turn !== null && turn.prompt === null) turn.prompt = feature;
        else pendingPrompt = feature;
      }
      continue;
    }

    if (type === 'turn/start') {
      turn = { turn: data.turn, start: time, end: null, reason: null, todos: null, todoTimeline: [], prompt: pendingPrompt, steps: [] };
      pendingPrompt = null;
      turns.push(turn);
      continue;
    }
    if (turn === null) continue;

    if (type === 'step/start') {
      step = { n: data.step, start: time, end: null, first: null, tools: [] };
      turn.steps.push(step);
      continue;
    }
    if (type === 'assistant/message') {
      if (step !== null && step.first === null) step.first = time;
      continue;
    }
    if (type === 'tool/call') {
      const call = { name: typeof data.name === 'string' ? data.name : '?', start: time, end: null };
      if (step !== null) step.tools.push(call);
      if (typeof data.callId === 'string') callIndex.set(data.callId, call);
      continue;
    }
    if (type === 'tool/result') {
      const callId = data?.message?.source?.callId;
      const call = typeof callId === 'string' ? callIndex.get(callId) : undefined;
      if (call !== undefined) { call.end = time; callIndex.delete(callId); }
      continue;
    }
    if (type === 'todo/write') {
      const items = Array.isArray(data.todos) ? data.todos : [];
      const completed = items.filter((todo) => todo?.status === 'completed').length;
      turn.todos = items.length;
      turn.todoTimeline.push({ t: time - turn.start, n: items.length, completed });
      continue;
    }
    if (type === 'step/end') { closeStep(time); continue; }
    if (type === 'turn/end') {
      closeStep(time);
      turn.end = time;
      turn.reason = typeof data.reason === 'object' && data.reason !== null ? (data.reason.kind ?? data.reason.type ?? null) : data.reason ?? null;
      turn.steps = turn.steps.filter((s) => s.end !== null);
      turn = null;
      step = null;
      callIndex.clear();
      continue;
    }
  }

  const records = [];
  for (const item of turns) {
    if (item.end === null || item.end <= item.start) continue;
    if (item.steps.length === 0) continue;
    const durationMs = item.end - item.start;
    if (durationMs < 3_000) continue;
    records.push({
      sid,
      ws: workspace,
      cwd,
      model,
      turn: item.turn,
      start: item.start,
      end: item.end,
      durMs: durationMs,
      reason: item.reason,
      todos: item.todos,
      todoTimeline: item.todoTimeline,
      prompt: item.prompt,
      steps: item.steps.map((s) => ({
        n: s.n,
        start: s.start,
        end: s.end,
        first: s.first,
        tools: s.tools.map((t) => ({ name: t.name, start: t.start, end: t.end ?? s.end })),
      })),
    });
  }
  return records;
}

const files = listSessions().slice(0, MAX_FILES === Infinity ? undefined : MAX_FILES);
const sink = [];
let used = 0;
const started = Date.now();
for (const entry of files) {
  let records = [];
  try { records = extract(entry.file, entry.workspace); } catch (error) {
    console.error('skip', entry.file, String(error).slice(0, 120));
    continue;
  }
  for (const record of records) sink.push(JSON.stringify(record));
  used += 1;
  if (used % 200 === 0) console.error(`… ${used}/${files.length} files, ${sink.length} turns, ${Math.round((Date.now() - started) / 1000)}s`);
}
writeFileSync(OUT, `${sink.join('\n')}\n`);
console.error(`done: ${used} files → ${sink.length} turns in ${Math.round((Date.now() - started) / 1000)}s → ${OUT}`);
