import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRIOR_SYSTEM,
  PRIOR_PROMPT_CHARS,
  DEFAULT_PRIOR_TIMEOUT_MS,
  buildPriorMessage,
  parsePriorAnswer,
  blendWithPrior,
  createPriorRequester,
} from '../lib/prior.js';

test('buildPriorMessage carries the prompt, a truncated tail and the turn', () => {
  const longPrompt = 'x'.repeat(PRIOR_PROMPT_CHARS + 500);
  const text = buildPriorMessage({ prompt: longPrompt, cwd: '/home/user/projects/demo-app', model: 'deepseek-flash', turn: 3 });
  assert.ok(text.startsWith('Task (from the user):'));
  assert.ok(text.includes('x'.repeat(PRIOR_PROMPT_CHARS)));
  assert.ok(!text.includes('x'.repeat(PRIOR_PROMPT_CHARS + 1)), 'prompt must be truncated');
  assert.ok(text.includes('projects/demo-app'));
  assert.ok(text.includes('deepseek-flash'));
  assert.ok(text.includes('turn 3'));
  // Missing inputs must not throw and must not print "undefined".
  const bare = buildPriorMessage({});
  assert.ok(!bare.includes('undefined'));
  assert.ok(bare.includes('(unknown)'));
});

test('parsePriorAnswer accepts a well-formed estimate', () => {
  const prior = parsePriorAnswer('{"steps": 9, "tools": 14, "minutes": 12.5, "confidence": "high"}');
  assert.deepEqual(prior, { steps: 9, tools: 14, minutes: 12.5, confidence: 'high' });
});

test('parsePriorAnswer tolerates prose around the JSON object', () => {
  const prior = parsePriorAnswer('Sure! Here is my estimate:\n```json\n{"steps": 4, "minutes": 3}\n```\nHope that helps.');
  assert.equal(prior.steps, 4);
  assert.equal(prior.minutes, 3);
  assert.equal(prior.tools, 6, 'tools defaults to ~1.6 steps when omitted');
  assert.equal(prior.confidence, 'medium', 'unknown confidence falls back to medium');
});

test('parsePriorAnswer clamps absurd values', () => {
  const prior = parsePriorAnswer('{"steps": 99999, "tools": -5, "minutes": 100000}');
  assert.equal(prior.steps, 500);
  assert.equal(prior.tools, 0);
  assert.equal(prior.minutes, 2400);
});

test('parsePriorAnswer returns null instead of throwing', () => {
  for (const answer of ['', 'no json here', '{broken json', '{"steps": "many"}', '{"minutes": 5}', null, undefined, 42]) {
    assert.equal(parsePriorAnswer(answer), null, `expected null for ${String(answer)}`);
  }
});

test('blendWithPrior: weight 0 keeps the model ETA, weight 1 returns the prior alone', () => {
  assert.equal(blendWithPrior(120_000, 10, 0), 120_000);
  assert.ok(Math.abs(blendWithPrior(120_000, 10, 1) - 600_000) < 1e-6);
  const half = blendWithPrior(60_000, 60, 0.5);
  assert.ok(half > 60_000 && half < 3_600_000, 'w=0.5 sits between the two estimates in log space');
  // Degenerate inputs must not poison the ETA.
  assert.equal(blendWithPrior(60_000, null, 0.5), 60_000);
  assert.equal(blendWithPrior(Number.NaN, 10, 0.5), null);
  assert.ok(Math.abs(blendWithPrior(60_000, 10, 5) - 600_000) < 1e-3, 'weight clamps to 1');
});

test('createPriorRequester asks once per turn and caches the parsed prior', async () => {
  let calls = 0;
  const requester = createPriorRequester({
    stream: async function* () {
      calls += 1;
      yield { type: 'text-delta', text: '{"steps": 7, ' };
      yield { type: 'text-delta', text: '"minutes": 6}' };
    },
    resolveTarget: () => ({ provider: 'p', model: 'm' }),
  });
  const first = await requester.request({ turn: 1, prompt: 'do a thing' });
  const again = await requester.request({ turn: 1, prompt: 'do a thing' });
  assert.equal(calls, 1, 'second call for the same turn must not hit the model');
  assert.equal(again, null, 'a memoized turn returns null instead of a duplicate prior');
  assert.deepEqual(first, { steps: 7, tools: 11, minutes: 6, confidence: 'medium' });
  const next = await requester.request({ turn: 2, prompt: 'do another thing' });
  assert.equal(calls, 2);
  assert.equal(next.steps, 7);
});

test('createPriorRequester degrades to null on model failure', async () => {
  const failing = createPriorRequester({
    stream: async function* () {
      throw new Error('provider exploded');
    },
    resolveTarget: () => ({}),
  });
  assert.equal(await failing.request({ turn: 1, prompt: 'x' }), null);

  const garbage = createPriorRequester({
    stream: async function* () {
      yield { type: 'text-delta', text: 'I would rather not answer.' };
    },
    resolveTarget: () => ({}),
  });
  assert.equal(await garbage.request({ turn: 1, prompt: 'x' }), null);
});

test('createPriorRequester honors the abort timeout', async () => {
  const requester = createPriorRequester({
    timeoutMs: 30,
    stream: (request) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (request.signal?.aborted === true) throw new Error('aborted');
        yield { type: 'text-delta', text: '{"steps":1,"minutes":1}' };
      },
    }),
    resolveTarget: () => ({}),
  });
  assert.equal(await requester.request({ turn: 1, prompt: 'x' }), null);
});

test('createPriorRequester exposes busy state and reset()', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requester = createPriorRequester({
    stream: async function* () {
      await gate;
      yield { type: 'text-delta', text: '{"steps":1,"minutes":1}' };
    },
    resolveTarget: () => ({}),
  });
  const pending = requester.request({ turn: 1, prompt: 'x' });
  assert.equal(requester.busy, true);
  requester.reset();
  assert.equal(requester.busy, false);
  release();
  assert.equal((await pending).steps, 1);
});

test('prompt contract is a strict JSON estimate (prompt-injection version)', () => {
  assert.ok(PRIOR_SYSTEM.includes('STRICT JSON'));
  assert.ok(PRIOR_SYSTEM.includes('"steps"'));
  assert.ok(PRIOR_SYSTEM.includes('"minutes"'));
  assert.ok(DEFAULT_PRIOR_TIMEOUT_MS > 0 && DEFAULT_PRIOR_TIMEOUT_MS <= 5000);
});
