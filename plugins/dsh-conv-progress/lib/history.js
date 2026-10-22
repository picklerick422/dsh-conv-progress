/**
 * dsh-conv-progress — pure helpers for the per-turn history log.
 *
 * Kept dependency-free so the host can fold events with them and `node:test`
 * can exercise them without booting a Cordis context.
 *
 * Lifecycle: history lives in the host's per-session state (`state.history`),
 * is rebuilt by replaying the session's committed event log on first access
 * (`bootstrap()`), and is bounded by the configured `historyLimit`. It is not
 * mirrored to a separate file — the session's own JSONL log is the durable copy.
 */

/** How many finished turns one session keeps by default. */
export const DEFAULT_HISTORY_LIMIT = 100;
/** Task titles are stored already-shortened: the panel clamps them visually. */
export const TASK_TITLE_MAX = 240;
/** Placeholder text used when a turn carries no recoverable user text. */
export const TASK_TITLE_FALLBACK = '';

/**
 * Flatten a UserMessage's content blocks into a one-line task title.
 * Text blocks are joined; images/files get a short marker so the list still
 * tells a user "this turn contained a screenshot".
 * @param {readonly {type?: string, text?: string}[]|undefined} content
 * @returns {string}
 */
export function extractTaskTitle(content) {
  if (!Array.isArray(content)) return TASK_TITLE_FALLBACK;
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.replace(/\s+/gu, ' ').trim();
      if (text.length > 0) parts.push(text);
    } else if (block.type === 'image') {
      parts.push('[image]');
    } else if (block.type === 'file') {
      parts.push('[file]');
    }
  }
  const joined = parts.join(' ').replace(/\s+/gu, ' ').trim();
  if (joined.length <= TASK_TITLE_MAX) return joined;
  return joined.slice(0, TASK_TITLE_MAX - 1) + '…';
}

/**
 * Normalise `turn/end.reason` (a discriminated union with varying keys) into a
 * short kind string the UI can switch on.
 * @param {unknown} reason
 * @returns {string}
 */
export function describeReason(reason) {
  if (typeof reason === 'string' && reason.length > 0) return reason;
  if (reason !== null && typeof reason === 'object') {
    const kind = reason.type ?? reason.kind;
    if (typeof kind === 'string' && kind.length > 0) return kind;
  }
  return 'unknown';
}

/**
 * How much the estimator could learn before this turn ended. Displayed per row:
 * "low" means the number is a prior, "high" means it is calibrated by ≥5 steps.
 * @param {{steps?: number, turns?: number}} samples
 * @returns {'low'|'medium'|'high'}
 */
export function confidenceAtEnd(samples) {
  const steps = Number(samples?.steps ?? 0);
  if (!Number.isFinite(steps)) return 'low';
  if (steps >= 5) return 'high';
  if (steps >= 2) return 'medium';
  return 'low';
}

/**
 * Push one finished-turn record, keeping the newest `limit` entries.
 * `history` is mutated in place (it lives inside the session state object).
 * @param {object[]} history
 * @param {object} record
 * @param {number} [limit]
 * @returns {object[]}
 */
export function appendTurnRecord(history, record, limit = DEFAULT_HISTORY_LIMIT) {
  history.push(record);
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_HISTORY_LIMIT;
  if (history.length > max) history.splice(0, history.length - max);
  return history;
}
