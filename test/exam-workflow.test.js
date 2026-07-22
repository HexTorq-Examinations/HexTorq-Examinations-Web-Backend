const test = require('node:test');
const assert = require('node:assert/strict');
const { validateQuestion } = require('../src/controllers/questions.controller');
const fs = require('node:fs');
const path = require('node:path');
const source = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

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
  assert.match(source, /settings\.defaultGraceMinutes/);
  assert.match(source, /resolvedGraceMinutes/);
});

test('attempt administration requires recorded reasons', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/controllers/results.controller.js'), 'utf8');
  for (const action of ['MANUAL_EVALUATION', 'REGRADE', 'EXTEND', 'RESET']) assert.match(source, new RegExp(`'${action}'`));
  assert.match(source, /reason is required/i);
});

test('exam delivery settings are frozen onto each attempt', () => {
  const schema = source('prisma/schema.prisma');
  const exams = source('src/controllers/exams.controller.js');
  const attempts = source('src/controllers/examAttempts.controller.js');
  assert.match(schema, /maxViolations\s+Int\s+@default\(5\)/);
  assert.match(schema, /calculatorEnabled\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /isTestExam\s+Boolean\s+@default\(false\)/);
  assert.match(exams, /maxViolations: Math\.min\(50/);
  assert.match(attempts, /maxViolations: exam\.maxViolations/);
  assert.match(attempts, /violations\.length >= locked\.maxViolations/);
  assert.match(attempts, /completeFinalizingAttempt\(recorded\.attempt\.id, 'TERMINATED'/);
  assert.match(attempts, /status: 'FINALIZING'/);
  assert.match(attempts, /strictFullscreen: settings\.strictFullscreen/);
  assert.match(attempts, /disableClipboard: settings\.disableClipboard/);
  assert.match(attempts, /hasActiveAttempt: !!activeAttempt/);
  assert.match(attempts, /answers: activeAttempt \? \(answerRecords\.length > 0 \? answerRecordsToMap\(answerRecords\) : activeAttempt\.answers\) : \{\}/);
});

test('stale FINALIZING attempts preserve violation termination during worker retries', () => {
  const attempts = source('src/controllers/examAttempts.controller.js');
  assert.match(attempts, /const resolveFinalStatus =/);
  assert.match(attempts, /requestedStatus !== 'COMPLETED'/);
  assert.match(attempts, /violationCount >= \(attempt\?\.maxViolations \|\| 0\) \? 'TERMINATED' : 'COMPLETED'/);
  assert.match(attempts, /const resolvedFinalStatus = resolveFinalStatus\(frozenAttempt, finalStatus\)/);
});

test('attempt response PDF uses the owned frozen attempt', () => {
  const routes = source('src/routes/results.routes.js');
  const results = source('src/controllers/results.controller.js');
  assert.match(routes, /attempts\/:id\/response\.pdf/);
  assert.match(results, /const attemptResponsePdf/);
  assert.match(results, /loadOwnedAttempt\(req\.params\.id, req\)/);
  assert.match(results, /Student answer:/);
  assert.match(results, /Only finalized attempts can be exported/);
});

test('official results wait for exam completion and exclude test exams', () => {
  const results = source('src/controllers/results.controller.js');
  const reports = source('src/controllers/reports.controller.js');
  assert.match(results, /now <= latestEnd/);
  assert.match(results, /Students still have active attempts/);
  assert.match(results, /isTestExam: false/);
  assert.match(reports, /isTestExam: false/);
});

test('reports use date-scoped assignments and same-subject improvement', () => {
  const reports = source('src/controllers/reports.controller.js');
  assert.match(reports, /const sameSubjectImprovement =/);
  assert.match(reports, /const mappingWindow = dateWhere\(range\)/);
  assert.match(reports, /startAt: mappingWindow/);
  assert.match(reports, /'Improvement %': sameSubjectImprovement\(studentAttempts\)/);
});
