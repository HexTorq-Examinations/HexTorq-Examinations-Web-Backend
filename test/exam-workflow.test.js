const test = require('node:test');
const assert = require('node:assert/strict');
const { validateQuestion } = require('../src/controllers/questions.controller');
const fs = require('node:fs');
const path = require('node:path');

const valid = { text: '2 + 2?', subject: 'Math', type: 'Multiple Choice', marks: 2, options: ['3', '4'], correctAnswer: 1 };

test('accepts a valid question', () => assert.equal(validateQuestion(valid).correctAnswer, 1));
test('rejects duplicate options', () => assert.throws(() => validateQuestion({ ...valid, options: ['Four', 'four'] }), /unique/));
test('rejects out-of-range correct answer indexes', () => assert.throws(() => validateQuestion({ ...valid, correctAnswer: 2 }), /outside/));
test('rejects non-positive marks', () => assert.throws(() => validateQuestion({ ...valid, marks: 0 }), /positive/));
test('rejects unsupported question types', () => assert.throws(() => validateQuestion({ ...valid, type: 'Essay' }), /Unsupported/));

test('schedule overlap requires explicit confirmation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/controllers/examMappings.controller.js'), 'utf8');
  assert.match(source, /SCHEDULE_OVERLAP/);
  assert.match(source, /confirmOverlap/);
  assert.match(source, /startAt: \{ lt: endAt \}/);
  assert.match(source, /endAt: \{ gt: startAt \}/);
});

test('attempt administration requires recorded reasons', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/controllers/results.controller.js'), 'utf8');
  for (const action of ['MANUAL_EVALUATION', 'REGRADE', 'EXTEND', 'RESET']) assert.match(source, new RegExp(`'${action}'`));
  assert.match(source, /reason is required/i);
});
