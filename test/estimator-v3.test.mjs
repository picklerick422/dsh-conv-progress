/**
 * estimator-v3.test.mjs — the estimator contract the host relies on.
 *
 * The v3 predictor is a fitted model, so the tests do not assert exact numbers:
 * they pin behaviour that must stay stable across retrains — the shape of the
 * result, the interval ordering, monotonic progress inside one turn, the
 * cold-start penalty, and the fact that the feature vector really is fed by the
 * event stream (i.e. observing events changes the estimate).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createModel,
  beginTurn,
  observe,
  observeStepMs,
  observeTurn,
  estimate,
  describeModel,
  assertModelFeatures,
} from '../lib/estimator-v3.js';
import { FEATURE_NAMES, toVector } from '../lib/features.js';
import { validateModel } from '../lib/eta-v3.js';
import { ETA_V3_MODEL } from '../lib/eta-v3-model.js';

const T0 = 1_790_000_000_000;
const at = (ms) => T0 + ms;

/** Minimal but realistic event sequence for one turn. */
function openTurn(model, { turn = 1, start = T0, prompt = 'fix the failing test and report' } = {}) {
  observe(model, { type: 'turn/start', time: start, data: { turn } });
  beginTurn(model, turn);
  observe(model, {
    type: 'user/message',
    time: start + 5,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] },
  });
}

function runStep(model, { turn = 1, step = 1, start, durationMs, tool = 'bash' }) {
  observe(model, { type: 'step/start', time: start, data: { turn, step } });
  observe(model, {
    type: 'tool/call',
    time: start + 200,
    data: { turn, step, callId: `call-${step}`, name: tool, arguments: '{}' },
  });
  observe(model, {
    type: 'tool/result',
    time: start + durationMs - 100,
    data: { turn, step, message: { source: { callId: `call-${step}` } } },
  });
  observe(model, { type: 'step/end', time: start + durationMs, data: { turn, step } });
  observeStepMs(model, durationMs);
}

const factsFor = (model, { now, stepsDone = 0, stepStartedAt = null, turnStartedAt = T0, turn = 1, running = true, todos = null }) => ({
  running,
  turn,
  stepsDone,
  stepStartedAt,
  turnStartedAt,
  now,
  todos,
});

test('model carries the exported booster and validates', () => {
  const model = createModel();
  assert.equal(model.model.schema, 'eta-v3-quantile-v1');
  assert.deepEqual(model.model.features, FEATURE_NAMES);
  assert.ok(validateModel(model.model), 'exported model must pass validation');
  const info = describeModel(model);
  assert.equal(info.schema, 'eta-v3-quantile-v1');
  assert.ok(info.model.trees > 0);
});

test('idle session reports 100 % and no remaining time', () => {
  const model = createModel();
  const result = estimate(model, factsFor(model, { now: at(1000), running: false }));
  assert.equal(result.percent, 1);
  assert.equal(result.etaMs, 0);
  assert.equal(result.confidence, 'high');
  assert.equal(result.basis, 'done');
});

test('running turn yields a bounded estimate with a sane interval', () => {
  const model = createModel();
  openTurn(model);
  const result = estimate(model, factsFor(model, { now: at(1000) }));
  assert.ok(result.percent > 0 && result.percent < 1);
  assert.ok(result.etaMs >= 3000 && result.etaMs <= 4 * 3600_000);
  assert.ok(result.loMs <= result.etaMs && result.etaMs <= result.hiMs, 'interval must contain the point estimate');
  assert.ok(['high', 'medium', 'low'].includes(result.confidence));
  assert.equal(result.breakdown.isColdStart, true, 'first turn has no session tempo yet');
  assert.equal(result.breakdown.features.k, 0);
  assert.equal(result.breakdown.features.n_prev_turns, 0);
});

test('percent never goes down inside one turn', () => {
  const model = createModel();
  openTurn(model);
  let previous = 0;
  for (let ms = 1000; ms <= 120_000; ms += 5_000) {
    const result = estimate(model, factsFor(model, { now: at(ms) }));
    assert.ok(result.percent >= previous, `percent dropped at ${ms}ms: ${result.percent} < ${previous}`);
    previous = result.percent;
  }
  assert.ok(previous > 0);
});

test('events change the estimate (features are wired to the stream)', () => {
  const model = createModel();
  openTurn(model);
  const before = estimate(model, factsFor(model, { now: at(2000) }));

  // a slow session: three 40 s steps with a tool each
  for (let step = 1; step <= 3; step += 1) {
    runStep(model, { step, start: at(step * 40_000 - 39_000), durationMs: 40_000 });
  }
  const after = estimate(model, factsFor(model, {
    now: at(121_000),
    stepsDone: 3,
    stepStartedAt: at(120_500),
  }));
  assert.equal(after.breakdown.features.k, 3);
  assert.equal(after.breakdown.features.turn_tools_bash, 3);
  assert.ok(after.breakdown.features.prev_step_mean_ms > 0);
  assert.notEqual(after.etaMs, before.etaMs);
  assert.ok(after.percent > before.percent);
});

test('warm session loses the cold-start penalty after one finished turn', () => {
  const model = createModel();
  openTurn(model);
  for (let step = 1; step <= 2; step += 1) {
    runStep(model, { step, start: at(step * 10_000 - 9_000), durationMs: 10_000 });
  }
  observe(model, { type: 'turn/end', time: at(25_000), data: { turn: 1, reason: { type: 'completed' } } });
  observeTurn(model, { durationMs: 25_000, steps: 2, todoDelta: 0 });

  openTurn(model, { turn: 2, start: at(30_000) });
  const result = estimate(model, factsFor(model, { now: at(31_000), turn: 2, turnStartedAt: at(30_000) }));
  assert.equal(result.breakdown.features.n_prev_turns, 1);
  assert.equal(result.breakdown.isColdStart, false);
});

test('plan items shift the bar without faking completion', () => {
  const model = createModel();
  openTurn(model);
  observe(model, {
    type: 'todo/write',
    time: at(500),
    data: {
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ],
    },
  });
  const withPlan = estimate(model, factsFor(model, { now: at(3000), todos: [
    { status: 'completed' }, { status: 'in_progress' }, { status: 'pending' },
  ] }));
  assert.equal(withPlan.breakdown.planItems, 3);
  assert.ok(withPlan.breakdown.planPercent > 0);

  // a fully credited plan must not pin the bar at 100 % while work continues
  const donePlan = estimate(model, factsFor(model, { now: at(4000), todos: [
    { status: 'completed' }, { status: 'completed' }, { status: 'completed' },
  ] }));
  assert.ok(donePlan.percent < 0.97);
  assert.equal(donePlan.breakdown.planPercent, 1);
});

test('step EMA feeds the feature vector', () => {
  const model = createModel();
  openTurn(model);
  runStep(model, { step: 1, start: at(1000), durationMs: 15_000 });
  const result = estimate(model, factsFor(model, { now: at(17_000), stepsDone: 1, stepStartedAt: at(16_000) }));
  assert.ok(result.breakdown.features.step_ms_ema > 13_000, 'EMA should have moved above the 13.2 s prior');
  assert.ok(result.breakdown.features.step_ms_ema < 15_500);
});

test('a model expecting an unknown feature is rejected at creation', () => {
  // The retrain→host contract: every model feature must be computable here.
  assert.ok(assertModelFeatures(ETA_V3_MODEL));
  assert.throws(
    () => assertModelFeatures({ features: ['k', 'model_code'] }),
    /cannot compute: model_code/,
  );
  // Unknown names are tolerated by the vector builder (as 0), which is exactly
  // why the check above has to exist.
  assert.deepEqual(toVector({ k: 3 }, ['k', 'nope']), [3, 0]);
});
