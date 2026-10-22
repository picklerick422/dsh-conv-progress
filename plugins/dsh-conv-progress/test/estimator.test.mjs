/**
 * estimator v2 tests — the ETA now comes from the fitted survival table
 * (`eta-model.js`), so these tests pin *behaviour and invariants*, not exact
 * table numbers: ranges are generous on purpose, the model may be re-fitted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel, beginTurn, observeTurn, estimate, DEFAULT_PARAMS } from '../lib/estimator.js';
import { lookupEtaMs, medianRemainingSteps } from '../lib/eta-model.js';

const T0 = 1_700_000_000_000;
const at = (seconds) => T0 + seconds * 1000;

/** One live sample at `elapsed` seconds into a turn that completed `k` steps. */
function sample(model, { turn = 1, k = 0, elapsed = 1, todos = null, stepStartedAt = null } = {}) {
  return estimate(model, {
    running: true,
    turn,
    stepsDone: k,
    stepStartedAt,
    turnStartedAt: T0,
    now: at(elapsed),
    todos,
  });
}

test('a fresh turn shows a small but non-zero bar and a plausible ETA', () => {
  const model = createModel();
  beginTurn(model, 1);
  const out = sample(model, { k: 0, elapsed: 1 });
  assert.ok(out.percent >= DEFAULT_PARAMS.percentFloor && out.percent <= 0.1, `percent=${out.percent}`);
  assert.ok(out.etaMs >= 30_000 && out.etaMs <= 15 * 60_000, `eta=${out.etaMs}`);
  assert.ok(['low', 'medium', 'high'].includes(out.confidence));
  assert.ok(out.expectedSteps >= 1);
});

test('progress never goes backwards inside a turn', () => {
  const model = createModel();
  beginTurn(model, 1);
  let last = 0;
  for (let t = 1; t <= 900; t += 5) {
    const k = Math.floor(t / 30); // one step every 30 s
    const out = sample(model, { k, elapsed: t });
    assert.ok(out.percent >= last - 1e-9, `percent dropped at ${t}s: ${last} → ${out.percent}`);
    last = out.percent;
  }
  assert.ok(last <= DEFAULT_PARAMS.percentCap + 1e-9);
});

test('the bar approaches but never reaches the cap while running', () => {
  const model = createModel();
  beginTurn(model, 1);
  let out = sample(model, { k: 0, elapsed: 1 });
  for (let t = 2; t <= 7_200; t += 20) out = sample(model, { k: Math.floor(t / 20), elapsed: t });
  assert.ok(out.percent > 0.5, `percent=${out.percent}`);
  assert.ok(out.percent <= DEFAULT_PARAMS.percentCap + 1e-9, `percent=${out.percent}`);
});

test('a finished turn is 100 % with no remaining time', () => {
  const model = createModel();
  beginTurn(model, 1);
  const out = estimate(model, { running: false, turn: 1, stepsDone: 12, now: at(600) });
  assert.equal(out.percent, 1);
  assert.equal(out.etaMs, 0);
  assert.equal(out.remainingSteps, 0);
  assert.equal(out.basis, 'done');
});

test('a new turn resets the per-turn smoothing', () => {
  const model = createModel();
  beginTurn(model, 1);
  for (let t = 1; t <= 600; t += 10) sample(model, { k: Math.floor(t / 30), elapsed: t });
  const doneTurn = estimate(model, { running: false, turn: 1, stepsDone: 20, now: at(610) });
  assert.equal(doneTurn.percent, 1);
  beginTurn(model, 2);
  const next = sample(model, { turn: 2, k: 0, elapsed: 1 });
  assert.ok(next.percent < 0.1, `percent=${next.percent}`);
  assert.ok(next.etaMs > 30_000);
});

test('an unfinished todo plan pulls the bar ahead of the time share', () => {
  const todos = [
    { status: 'completed' },
    { status: 'completed' },
    { status: 'in_progress' },
    { status: 'pending' },
  ];
  const withPlan = createModel();
  beginTurn(withPlan, 1);
  const planOut = sample(withPlan, { k: 1, elapsed: 120, todos });
  const withoutPlan = createModel();
  beginTurn(withoutPlan, 1);
  const plainOut = sample(withoutPlan, { k: 1, elapsed: 120 });
  assert.ok(planOut.percent > plainOut.percent, `${planOut.percent} vs ${plainOut.percent}`);
  assert.equal(planOut.basis, 'time-table+plan');
  assert.equal(plainOut.basis, 'time-table');
});

test('a fully credited plan does not pin the bar at 100 %', () => {
  const todos = [{ status: 'completed' }, { status: 'completed' }];
  const model = createModel();
  beginTurn(model, 1);
  const out = sample(model, { k: 1, elapsed: 60, todos });
  assert.ok(out.percent < 0.7, `percent=${out.percent}`);
  assert.equal(out.basis, 'time-table');
});

test('the fitted table is well supported for ordinary turns', () => {
  const early = lookupEtaMs(0, 1_000);
  assert.equal(early.source, 'fine');
  assert.ok(early.samples > 1_000, `samples=${early.samples}`);
  assert.ok(early.reliability > 0.8);
  const mid = lookupEtaMs(5, 5 * 60_000);
  assert.ok(Number.isFinite(mid.etaMs) && mid.etaMs > 0);
  assert.ok(medianRemainingSteps(0) >= 1);
});

test('completed turns feed the calibration EMAs with clamped step times', () => {
  const model = createModel();
  observeTurn(model, { durationMs: 100_000, steps: 10 });
  assert.equal(model.stepSamples, 1);
  assert.ok(Math.abs(model.stepMs - 10_000) < 1_000, `stepMs=${model.stepMs}`);
  observeTurn(model, { durationMs: 4 * 3600_000, steps: 4 });
  assert.ok(model.stepMs <= DEFAULT_PARAMS.maxStepMs);
  assert.equal(model.turnSamples, 2);
  assert.ok(model.stepsPerTurn >= DEFAULT_PARAMS.minStepsPerTurn);
});

test('confidence stays a valid level and the low path is reachable', () => {
  const model = createModel();
  beginTurn(model, 1);
  const common = sample(model, { k: 3, elapsed: 300 });
  assert.ok(['low', 'medium', 'high'].includes(common.confidence));
  // A cell the tables know nothing about (absurd step count) is less trusted.
  const exotic = sample(model, { k: 5_000, elapsed: 900 });
  assert.ok(['low', 'medium', 'high'].includes(exotic.confidence));
  assert.ok(exotic.breakdown.reliability <= 1);
});
