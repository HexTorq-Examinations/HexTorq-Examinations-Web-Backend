const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreAttemptSnapshot } = require('../src/utils/scoring');

const questions = [
  { id: 'q1', correctAnswer: 'A', marks: 4 },
  { id: 'q2', correctAnswer: 'B', marks: 3 },
  { id: 'q3', correctAnswer: 'C', marks: 1 },
];

test('awards full marks for correct answers', () => {
  assert.equal(scoreAttemptSnapshot(questions, { q1: 'A', q2: 'B' }), 7);
});

test('does not penalize incorrect answers when disabled', () => {
  assert.equal(scoreAttemptSnapshot(questions, { q1: 'wrong', q2: 'B' }), 3);
});

test('deducts 25 percent per incorrect answered question when enabled', () => {
  assert.equal(scoreAttemptSnapshot(questions, { q1: 'wrong', q2: 'B', q3: 'wrong' }, { negativeMarking: true, negativeMarkingRate: 0.25 }), 1.75);
});

test('does not penalize unanswered questions', () => {
  assert.equal(scoreAttemptSnapshot(questions, { q1: 'A' }, { negativeMarking: true, negativeMarkingRate: 0.25 }), 4);
});

test('matches imported hyphen and slash fraction answers', () => {
  assert.equal(scoreAttemptSnapshot([{ id: 'q1', correctAnswer: '1-2', marks: 1 }], { q1: '1/2' }), 1);
  assert.equal(scoreAttemptSnapshot([{ id: 'q1', correctAnswer: '1/13', marks: 1 }], { q1: '1-13' }), 1);
  assert.equal(scoreAttemptSnapshot([{ id: 'q1', correctAnswer: '1-2', marks: 1 }], { q1: 'Fri Jan 02 2026 00:00:00 GMT+0000 (Coordinated Universal Time)' }), 1);
});
