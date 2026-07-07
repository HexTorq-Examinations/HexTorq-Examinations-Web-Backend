const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('organization-scoped accounts fail closed when organizationId is missing', () => {
  const auth = source('src/middleware/auth.js');
  assert.match(auth, /\['ADMIN', 'STUDENT'\]\.includes\(user\.role\)/);
  assert.match(auth, /!user\.organizationId/);
});

test('student update and delete require owned-student lookup', () => {
  const students = source('src/controllers/students.controller.js');
  assert.match(students, /const assertOwnedStudent/);
  assert.ok((students.match(/await assertOwnedStudent\(id, req\)/g) || []).length >= 2);
  assert.match(students, /role: 'STUDENT'/);
  assert.match(students, /organizationId: req\.user\.organizationId/);
});

test('manual student creation uses the validated owned class', () => {
  const students = source('src/controllers/students.controller.js');
  const createBlock = students.slice(students.indexOf('const create ='), students.indexOf('const update ='));
  assert.match(createBlock, /const cls = await assertOwnedClass\(classId, req\.user\.organizationId\)/);
  assert.match(createBlock, /organizationId: classOrganizationId\(cls\)/);
});

test('student register numbers are database-unique and races return conflict', () => {
  const schema = source('prisma/schema.prisma');
  const errorHandler = source('src/middleware/errorHandler.js');
  const migration = source('prisma/migrations/20260707140000_unique_student_register_number/migration.sql');
  assert.match(schema, /registerNumber\s+String\s+@unique/);
  assert.match(migration, /CREATE UNIQUE INDEX "StudentProfile_registerNumber_key"/);
  assert.match(migration, /HAVING COUNT\(\*\) > 1/);
  assert.match(errorHandler, /err\?\.code === 'P2002'/);
  assert.match(errorHandler, /status\(409\)/);
});

test('result publication is scoped through the owning exam organization', () => {
  const results = source('src/controllers/results.controller.js');
  assert.match(results, /return \{ exam: \{ organizationId: req\.user\.organizationId \} \}/);
  assert.match(results, /where: \{ id, \.\.\.scopeWhere\(req\) \}/);
});

test('exam and question mutations verify tenant and parent ownership', () => {
  const exams = source('src/controllers/exams.controller.js');
  const questions = source('src/controllers/questions.controller.js');
  assert.ok((exams.match(/where: \{ id, \.\.\.scopeWhere\(req\) \}/g) || []).length >= 2);
  assert.match(questions, /findFirst\(\{ where: \{ id, examId \} \}\)/);
  assert.match(questions, /deleteMany\(\{ where: \{ id, examId \} \}\)/);
});

test('attempt and personal mapping APIs are student-only', () => {
  const examsRoutes = source('src/routes/exams.routes.js');
  const mappingRoutes = source('src/routes/examMappings.routes.js');
  assert.ok((examsRoutes.match(/authorize\('STUDENT'\)/g) || []).length >= 7);
  assert.match(mappingRoutes, /router\.get\('\/mine', authorize\('STUDENT'\)/);
});

test('unexpected server errors are logged but hidden from API clients', () => {
  const errors = source('src/middleware/errorHandler.js');
  assert.match(errors, /statusCode >= 500 \? 'Internal server error'/);
  assert.match(errors, /requestId: req\.id/);
  assert.match(errors, /statusCode < 500 && err\.details/);
});

test('avatar uploads verify image content and use hierarchy folders', () => {
  const upload = source('src/middleware/upload.js');
  const users = source('src/controllers/users.controller.js');
  assert.match(upload, /multer\.memoryStorage\(\)/);
  assert.match(users, /imageExtension/);
  assert.match(users, /batch-\$\{profile\.class\.department\.school\.batchId\}/);
  assert.match(users, /class-\$\{profile\.classId\}/);
});
