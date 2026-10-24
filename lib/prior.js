/**
 * prior.js — experimental "prompt-injection" prior for the ETA capsule.
 *
 * Before a turn runs, the capsule can ask a model for a structured work-size
 * estimate and blend that estimate into its ETA. The request is a side call:
 * it never touches the session log, the user's prompt, or the model's own
 * conversation — the plugin stays read-only from the session's point of view.
 *
 * Measured state (see docs/dsh-conv-progress.md §14): the estimate is too noisy
 * to help (sigma(log steps ratio) ~ 1.3, spearman 0.32, best blend weight 0.0),
 * so this path is **off by default** and exists for further experiments.
 */

/** The estimate contract. Kept small: 4 integers + a confidence word. */
export const PRIOR_SYSTEM = `You are the planning head of an autonomous coding agent (DeepSeek Harness).
A user task is about to start. Estimate the TOTAL amount of work it will take.

Answer with STRICT JSON only, no prose, no code fence:
{"steps": <int>, "tools": <int>, "minutes": <number>, "confidence": "low"|"medium"|"high"}

Field meanings:
- steps: number of assistant steps (one model round that may call tools). A trivial reply is 1; a small edit is 2-4; a multi-file feature is 8-25; a big refactor or investigation is 25+.
- tools: total tool calls across the whole turn.
- minutes: wall-clock minutes until the final answer, including tool time.
- confidence: how sure you are about the ballpark (low when the task text is vague).

Be calibrated rather than optimistic: long investigations are common.`;

export const PRIOR_PROMPT_CHARS = 4000;
export const DEFAULT_PRIOR_TIMEOUT_MS = 2500;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Build the single user message sent to the estimating model. */
export function buildPriorMessage({ prompt, cwd, model, turn }) {
  const dir = typeof cwd === 'string' && cwd.length > 0
    ? cwd.split('/').filter(Boolean).slice(-2).join('/')
    : '(unknown)';
  const body = typeof prompt === 'string' ? prompt.slice(0, PRIOR_PROMPT_CHARS) : '';
  return `Task (from the user):
${body}

Context:
- working directory: ${dir}
- agent model: ${model || '(unknown)'}
- this is turn ${Number.isFinite(turn) ? turn : 1} of the session

Return the JSON estimate only.`;
}

/**
 * Parse a model answer into a prior, or null when it is unusable.
 * Never throws: a malformed answer must degrade to "no prior", not to a crash.
 */
export function parsePriorAnswer(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const number = (value, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? clamp(n, min, max) : null;
  };
  const steps = number(parsed.steps, 1, 500);
  const minutes = number(parsed.minutes, 0, 2400);
  if (steps === null || minutes === null) return null;
  return {
    steps,
    tools: number(parsed.tools, 0, 2000) ?? Math.round(steps * 1.6),
    minutes,
    confidence: parsed.confidence === 'low' || parsed.confidence === 'high' ? parsed.confidence : 'medium',
  };
}

/**
 * Blend the model ETA with the prior in log space.
 * `weight` 0 keeps the model ETA untouched; 1 returns the prior alone.
 */
export function blendWithPrior(etaMs, priorMinutes, weight) {
  const w = clamp(Number.isFinite(weight) ? weight : 0, 0, 1);
  const eta = Number.isFinite(etaMs) && etaMs > 0 ? etaMs : null;
  const prior = Number.isFinite(priorMinutes) && priorMinutes > 0 ? priorMinutes * 60_000 : null;
  if (eta === null || prior === null || w === 0) return eta;
  return Math.exp((1 - w) * Math.log(eta) + w * Math.log(prior));
}

/**
 * One estimate per turn, at most. `stream` is the host's `ctx.llm.stream`
 * adapter, injected so the module stays testable without a live model.
 *
 * @param {object} options
 * @param {(request: object) => AsyncIterable<{type: string, text?: string}>} options.stream
 * @param {(request: object) => {provider?: string, model?: string}} options.resolveTarget
 * @param {number} [options.timeoutMs]
 */
export function createPriorRequester({ stream, resolveTarget, timeoutMs = DEFAULT_PRIOR_TIMEOUT_MS }) {
  let inFlight = null;
  let lastTurn = null;

  return {
    /** True while an estimate for the current turn is pending. */
    get busy() {
      return inFlight !== null;
    },

    /**
     * Ask for a prior for one turn. Resolves to a prior or null; concurrent
     * callers for the same turn share the in-flight request.
     */
    async request({ turn, prompt, cwd, model }) {
      if (!prompt || turn === lastTurn) return null;
      if (inFlight !== null) return inFlight;
      lastTurn = turn;
      inFlight = (async () => {
        const target = resolveTarget?.({}) ?? {};
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          let text = '';
          const chunks = stream({
            provider: target.provider,
            model: target.model,
            system: PRIOR_SYSTEM,
            messages: [{ role: 'user', content: [{ type: 'text', text: buildPriorMessage({ prompt, cwd, model, turn }) }] }],
            temperature: 0,
            maxTokens: 200,
            signal: controller.signal,
          });
          for await (const chunk of chunks) {
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
          }
          return parsePriorAnswer(text);
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
          inFlight = null;
        }
      })();
      return inFlight;
    },

    /** Forget the turn memo (session switch). */
    reset() {
      inFlight = null;
      lastTurn = null;
    },
  };
}
