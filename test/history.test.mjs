import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HISTORY_LIMIT,
  TASK_TITLE_MAX,
  appendTurnRecord,
  confidenceAtEnd,
  describeReason,
  extractTaskTitle,
} from '../lib/history.js';

test('extractTaskTitle joins text blocks and normalises whitespace', () => {
  assert.equal(
    extractTaskTitle([
      { type: 'text', text: '  帮我  改造\n进度条  ' },
      { type: 'image', attachment: {} },
    ]),
    '帮我 改造 进度条 [image]',
  );
});

test('extractTaskTitle handles missing/invalid content', () => {
  assert.equal(extractTaskTitle(undefined), '');
  assert.equal(extractTaskTitle([]), '');
  assert.equal(extractTaskTitle([null, 42, { type: 'text' }]), '');
  assert.equal(extractTaskTitle([{ type: 'file', attachment: {} }]), '[file]');
});

test('extractTaskTitle truncates very long titles', () => {
  const long = 'x'.repeat(TASK_TITLE_MAX * 2);
  const title = extractTaskTitle([{ type: 'text', text: long }]);
  assert.equal(title.length, TASK_TITLE_MAX);
  assert.ok(title.endsWith('…'));
});

test('describeReason normalises unions, strings and junk', () => {
  assert.equal(describeReason({ type: 'completed' }), 'completed');
  assert.equal(describeReason({ kind: 'aborted', reason: 'user' }), 'aborted');
  assert.equal(describeReason('max-tokens'), 'max-tokens');
  assert.equal(describeReason(undefined), 'unknown');
  assert.equal(describeReason({}), 'unknown');
});

test('confidenceAtEnd maps sample counts to levels', () => {
  assert.equal(confidenceAtEnd({ steps: 0 }), 'low');
  assert.equal(confidenceAtEnd({ steps: 1 }), 'low');
  assert.equal(confidenceAtEnd({ steps: 2 }), 'medium');
  assert.equal(confidenceAtEnd({ steps: 4 }), 'medium');
  assert.equal(confidenceAtEnd({ steps: 5 }), 'high');
  assert.equal(confidenceAtEnd(undefined), 'low');
});

test('appendTurnRecord keeps the newest entries up to the limit', () => {
  const history = [];
  for (let index = 1; index <= DEFAULT_HISTORY_LIMIT + 5; index += 1) {
    appendTurnRecord(history, { turn: index });
  }
  assert.equal(history.length, DEFAULT_HISTORY_LIMIT);
  assert.equal(history[0].turn, 6);
  assert.equal(history.at(-1).turn, DEFAULT_HISTORY_LIMIT + 5);
});

test('appendTurnRecord honours a custom limit and falls back on junk', () => {
  const history = [];
  appendTurnRecord(history, { turn: 1 }, 3);
  appendTurnRecord(history, { turn: 2 }, 3);
  appendTurnRecord(history, { turn: 3 }, 3);
  appendTurnRecord(history, { turn: 4 }, 3);
  assert.deepEqual(history.map((record) => record.turn), [2, 3, 4]);

  const other = [];
  appendTurnRecord(other, { turn: 1 }, Number.NaN);
  assert.equal(other.length, 1);
});
