const test = require('node:test');
const assert = require('node:assert/strict');
const { validateQuestion } = require('../src/controllers/questions.controller');
const { parseQuestionsWorkbook } = require('../src/utils/questionImport');
const { simplifyImportedDateOption, repairQuestionOptions } = require('../src/utils/questionOptionRepair');
const ExcelJS = require('exceljs');
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
  assert.match(attempts, /answers: activeAttempt \? \(answerRecords\.length > 0 \? answerRecordsToMap\(answerRecords, snapshot\) : normalizeAnswerMap\(activeAttempt\.answers, snapshot\)\) : \{\}/);
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

test('question import preserves hyphen-style options that Excel auto-converts to dates', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Questions');
  sheet.addRow(['Question', 'Type', 'Marks', 'Difficulty', 'Option1', 'Option2', 'Option3', 'Option4', 'Answer']);
  sheet.addRow([
    'A card is drawn from a standard deck of 52 cards. What is the probability of drawing a King?',
    'Multiple Choice',
    1,
    'Medium',
    new Date(Date.UTC(2026, 0, 13)),
    '1/52',
    new Date(Date.UTC(2026, 3, 15)),
    new Date(Date.UTC(2026, 3, 13)),
    '1-13',
  ]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const { questions, errors } = await parseQuestionsWorkbook(buffer, 'questions.xlsx', {
    subject: 'Math',
    marks: 1,
    difficulty: 'Medium',
    type: 'Multiple Choice',
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(questions[0].options, ['1-13', '1/52', '4-15', '4-13']);
  assert.equal(questions[0].correctAnswer, 0);
});

test('question option repair cleans already-imported JavaScript date strings', () => {
  assert.equal(
    simplifyImportedDateOption('Sun Jan 04 2026 00:00:00 GMT+0000 (Coordinated Universal Time)'),
    '1-4'
  );
  assert.equal(
    simplifyImportedDateOption('Sat Dec 30 1899 12:17:00 GMT+0000 (Coordinated Universal Time)'),
    '12:17'
  );
  const repaired = repairQuestionOptions([
    'Sat Dec 30 1899 12:17:00 GMT+0000 (Coordinated Universal Time)',
    '4:5',
    '2:3',
    'Sat Dec 30 1899 10:21:00 GMT+0000 (Coordinated Universal Time)',
  ]);
  assert.equal(repaired.changed, true);
  assert.deepEqual(repaired.options, ['12:17', '4:5', '2:3', '10:21']);
});
