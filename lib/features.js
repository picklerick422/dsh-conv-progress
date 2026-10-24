/**
 * features.js — the single source of truth for the v3 ETA feature vector.
 *
 * The same module is used by
 *   - the host plugin (`lib/index.js`) when it folds live session events, and
 *   - the offline research tools (`tools/check-features.mjs`), which replay the
 *     session logs and compare against the training table `data/samples.csv`.
 *
 * Keeping one implementation is what makes the offline metrics transferable to
 * production: a feature mismatch here is the usual reason a model degrades in
 * the field, so it is tested rather than assumed.
 *
 * All values are observable at prediction time; nothing here reads the turn's
 * future (no ground-truth duration, no total step count).
 */

export const FEATURE_VECTOR_VERSION = 1;

/** Tool categories, identical to the training table. */
export function toolCategory(name) {
  if (typeof name !== 'string' || name === '') return 7;
  if (/bash|shell|job|exec|pty|terminal/i.test(name)) return 1;
  if (/edit|write|apply|patch|replace/i.test(name)) return 2;
  if (/read|grep|glob|list|search|find|ls|view/i.test(name)) return 3;
  if (/image|draw|photo|art/i.test(name)) return 4;
  if (/todo|plan/i.test(name)) return 5;
  if (/agent|subagent|workflow|team/i.test(name)) return 6;
  return 7;
}

const EMPTY_PROMPT = Object.freeze({
  chars: 0, lines: 0, codeFences: 0, commands: 0, mentions: 0, questionMarks: 0,
  hasImage: false, cjkRatio: 0, asciiRatio: 0,
});

/** Prompt-shape features of the user message that started a turn. */
export function promptFeatures(content) {
  const blocks = Array.isArray(content) ? content : [];
  let text = '';
  let hasImage = false;
  for (const block of blocks) {
    const type = block?.type;
    if (type === 'text' && typeof block.text === 'string') text += block.text;
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
    cjkRatio: text.length === 0 ? 0 : Math.round((cjk / text.length) * 100) / 100,
    asciiRatio: text.length === 0 ? 0 : Math.round((letters / text.length) * 100) / 100,
  };
}

/** Fresh per-session feature state. */
export function createFeatureState() {
  return {
    turnIndex: 0,
    turnNumber: 0,
    turnStart: 0,
    stepsDone: 0,
    stepStart: null,
    stepTools: [],          // [{ cat, start, end }] for the currently open step
    stepDurs: [],           // completed step durations of the current turn (ms)
    turnTools: [0, 0, 0, 0, 0, 0, 0, 0],
    prevTurnDurs: [],
    prevTurnSteps: [],
    prompt: EMPTY_PROMPT,
    promptFilled: false,
    pendingPrompt: null,
    planN: 0,
    planDone: 0,
    lastEventTs: 0,
  };
}

/** Reset the per-turn part of the state; keep the session history. */
export function beginTurn(state, { turn, turnStart, prompt }) {
  state.turnIndex += 1;
  state.turnNumber = Number.isFinite(turn) ? turn : state.turnIndex;
  state.turnStart = turnStart;
  state.stepsDone = 0;
  state.stepStart = null;
  state.stepTools = [];
  state.stepDurs = [];
  state.turnTools = [0, 0, 0, 0, 0, 0, 0, 0];
  state.planN = 0;
  state.planDone = 0;
  state.prompt = prompt ?? state.pendingPrompt ?? EMPTY_PROMPT;
  state.promptFilled = Boolean(prompt ?? state.pendingPrompt);
  state.pendingPrompt = null;
  state.lastEventTs = Math.max(state.lastEventTs, turnStart);
}

export function endTurn(state, { turnEnd, steps }) {
  const duration = Math.max(1, turnEnd - state.turnStart);
  state.prevTurnDurs.push(duration);
  state.prevTurnSteps.push(Number.isFinite(steps) ? steps : state.stepsDone);
  state.promptFilled = true;   // late messages before the next turn belong to the next prompt
  if (state.prevTurnDurs.length > 20) {
    state.prevTurnDurs = state.prevTurnDurs.slice(-20);
    state.prevTurnSteps = state.prevTurnSteps.slice(-20);
  }
}

const OPEN_CALLS = new WeakMap();

function openCallsOf(state) {
  let map = OPEN_CALLS.get(state);
  if (!map) {
    map = new Map();
    OPEN_CALLS.set(state, map);
  }
  return map;
}

/**
 * Fold one session event into the feature state.
 * Unknown events are ignored; the caller may pass every event.
 */
export function applyEvent(state, event) {
  const type = event?.type;
  const time = Number(event?.time) || 0;
  const data = event?.data ?? {};
  switch (type) {
    case 'user/message': {
      const kind = data?.source?.kind;
      // Harness-injected context is not a prompt; only the real submission shapes the turn.
      if (kind !== undefined && kind !== 'user') return;
      const feature = promptFeatures(data.content);
      if (state.turnStart > 0 && !state.promptFilled) {
        state.prompt = feature;
        state.promptFilled = true;
      } else {
        state.pendingPrompt = feature;
      }
      return;
    }
    case 'turn/start': {
      beginTurn(state, { turn: data.turn, turnStart: time, prompt: state.pendingPrompt });
      return;
    }
    case 'step/start': {
      state.stepStart = time;
      state.stepTools = [];
      state.stepsDone = Math.max(0, Number(data?.step ?? state.stepsDone + 1) - 1);
      state.lastEventTs = Math.max(state.lastEventTs, time);
      return;
    }
    case 'step/end': {
      if (state.stepStart !== null) state.stepDurs.push(Math.max(1, time - state.stepStart));
      state.stepStart = null;
      state.stepsDone += 1;
      state.lastEventTs = Math.max(state.lastEventTs, time);
      return;
    }
    case 'tool/call': {
      const cat = toolCategory(data?.name);
      const callId = typeof data?.callId === 'string' ? data.callId : '';
      const entry = { cat, start: time, end: null };
      state.stepTools.push(entry);
      if (callId) openCallsOf(state).set(callId, entry);
      state.lastEventTs = Math.max(state.lastEventTs, time);
      return;
    }
    case 'tool/result': {
      const callId = data?.message?.source?.callId ?? data?.callId ?? '';
      const entry = openCallsOf(state).get(callId);
      if (entry) {
        entry.end = time;
        state.turnTools[entry.cat] += 1;
        openCallsOf(state).delete(callId);
      }
      state.lastEventTs = Math.max(state.lastEventTs, time);
      return;
    }
    case 'todo/write': {
      const todos = Array.isArray(data?.todos) ? data.todos : [];
      state.planN = todos.length;
      state.planDone = todos.filter((item) => item?.status === 'completed').length;
      return;
    }
    case 'turn/end': {
      endTurn(state, { turnEnd: time, steps: state.stepsDone });
      state.lastEventTs = Math.max(state.lastEventTs, time);
      return;
    }
    default:
      return;
  }
}

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Materialise the model inputs as a name-keyed map.
 *
 * Mapping by name (then `toVector(map, model.features)`) instead of relying on a
 * hand-maintained array order is deliberate: a silently reordered vector is the
 * classic way an offline-validated model degrades in production.
 *
 * @param {object} state     feature state folded so far
 * @param {object} options   { now, stepMsEma }
 * @returns {Record<string, number>}
 */
export function buildFeatureMap(state, options = {}) {
  const now = Number(options.now) || Date.now();
  const stepMsEma = Number(options.stepMsEma) || 0;
  const openStep = state.stepStart !== null && state.stepStart <= now;
  const stepElapsed = openStep ? now - state.stepStart : 0;
  const stepTools = openStep ? state.stepTools.filter((tool) => tool.start <= now) : [];
  const toolsDone = stepTools.filter((tool) => tool.end !== null).length;
  const lastTool = stepTools.length > 0 ? stepTools[stepTools.length - 1] : null;
  const recentDurs = state.stepDurs.slice(-3);
  const elapsed = state.turnStart > 0 ? Math.max(0, now - state.turnStart) : 0;
  const prompt = state.prompt ?? EMPTY_PROMPT;
  const prevDurs = state.prevTurnDurs;
  const prevSteps = state.prevTurnSteps;
  return {
    k: state.stepsDone,
    elapsed_ms: elapsed,
    step_elapsed_ms: stepElapsed,
    step_open: openStep ? 1 : 0,
    step_has_tools: stepTools.length > 0 ? 1 : 0,
    tools_done_in_step: toolsDone,
    pending_tools: stepTools.length - toolsDone,
    last_tool_cat: lastTool ? lastTool.cat : 0,
    since_last_evt_ms: Math.max(0, now - state.lastEventTs),
    prev_step_mean_ms: recentDurs.length ? mean(recentDurs) : 0,
    prev_step_max_ms: recentDurs.length ? Math.max(...recentDurs) : 0,
    step_ms_ema: stepMsEma,
    n_prev_turns: prevDurs.length,
    prev_turn_dur_med: prevDurs.length ? median(prevDurs) : 0,
    prev_turn_steps_med: prevSteps.length ? median(prevSteps) : 0,
    turn_index: state.turnIndex,
    prompt_chars: prompt.chars,
    prompt_lines: prompt.lines,
    prompt_code_fences: prompt.codeFences,
    prompt_commands: prompt.commands,
    prompt_mentions: prompt.mentions,
    prompt_questions: prompt.questionMarks,
    prompt_has_image: prompt.hasImage ? 1 : 0,
    prompt_cjk_ratio: Math.round((prompt.cjkRatio ?? 0) * 100),
    plan_n: state.planN,
    plan_done: state.planDone,
    plan_has: state.planN > 0 ? 1 : 0,
    turn_tools_bash: state.turnTools[1],
    turn_tools_edit: state.turnTools[2],
    turn_tools_read: state.turnTools[3],
    turn_tools_image: state.turnTools[4],
    turn_tools_agent: state.turnTools[6],
  };
}

/** Dense vector in the model's own feature order. */
export function toVector(map, names) {
  return names.map((name) => {
    const value = map[name];
    return Number.isFinite(value) ? value : 0;
  });
}

function mean(values) {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Canonical feature names, in the order the exported model stores them. */
export const FEATURE_NAMES = [
  'k', 'elapsed_ms', 'step_elapsed_ms', 'step_open', 'step_has_tools',
  'tools_done_in_step', 'pending_tools', 'last_tool_cat', 'since_last_evt_ms',
  'prev_step_mean_ms', 'prev_step_max_ms', 'step_ms_ema',
  'n_prev_turns', 'prev_turn_dur_med', 'prev_turn_steps_med',
  'prompt_chars', 'prompt_lines', 'prompt_code_fences', 'prompt_commands', 'prompt_mentions',
  'prompt_questions', 'prompt_has_image', 'prompt_cjk_ratio',
  'plan_n', 'plan_done', 'plan_has', 'turn_index',
  'turn_tools_bash', 'turn_tools_edit', 'turn_tools_read', 'turn_tools_image', 'turn_tools_agent',
];
