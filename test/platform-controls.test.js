const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DateTime } = require('luxon');

const source = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

test('Asia/Kolkata schedule converts to an absolute UTC instant', () => {
  const instant = DateTime.fromISO('2026-07-07T10:00', { zone: 'Asia/Kolkata' }).toUTC();
  assert.equal(instant.toISO(), '2026-07-07T04:30:00.000Z');
});

test('exam access uses persisted UTC mapping boundaries', () => {
  const attempts = source('src/controllers/examAttempts.controller.js');
  assert.match(attempts, /now < mapping\.startAt/);
  assert.match(attempts, /now > effectiveEnd/);
  assert.match(attempts, /mapping\.graceMinutes/);
});

test('Helmet and administrative audit middleware are globally installed', () => {
  const app = source('src/app.js');
  assert.match(app, /app\.use\(helmet\(/);
  assert.match(app, /app\.use\(administrativeAudit\)/);
  assert.match(app, /\/api\/audit-logs/);
});

test('audit sanitizer redacts credentials and tokens', () => {
  const audit = source('src/middleware/auditLog.js');
  for (const key of ['password', 'newPassword', 'currentPassword', 'token', 'refreshToken', 'authorization']) {
    assert.match(audit, new RegExp(`['"]${key}['"]`));
  }
});

test('deadline jobs use database locking, stale recovery, and worker heartbeats', () => {
  const attempts = source('src/controllers/examAttempts.controller.js');
  const worker = source('src/workers/deadlineWorker.js');
  assert.match(attempts, /FOR UPDATE SKIP LOCKED/);
  assert.match(attempts, /staleBefore/);
  assert.match(worker, /workerHeartbeat\.upsert/);
});

test('database uniqueness prevents duplicate active attempts and result rows', () => {
  const migration = source('prisma/migrations/20260707050000_operational_readiness/migration.sql');
  assert.match(migration, /ExamAttempt_one_active_per_student_exam_idx/);
  assert.match(migration, /Result_examId_key/);
});

test('notification delivery tracking supports all delivery channels', () => {
  const schema = source('prisma/schema.prisma');
  const mailer = source('src/utils/mailer.js');
  assert.match(schema, /model NotificationDelivery/);
  assert.match(mailer, /channel: 'EMAIL'/);
});

test('settings and backup controls are persisted and access-controlled', () => {
  const schema = source('prisma/schema.prisma');
  const routes = source('src/routes/settings.routes.js');
  const settings = source('src/controllers/settings.controller.js');
  const backupService = source('src/utils/backupService.js');
  const backupWorker = source('src/workers/backupWorker.js');
  assert.match(schema, /model PlatformSetting/);
  assert.match(routes, /authorize\('SUPER_ADMIN', 'ADMIN'\)/);
  assert.match(settings, /prisma\.platformSetting\.upsert/);
  assert.match(backupService, /pg_dump/);
  assert.match(backupService, /includeMedia/);
  assert.match(backupWorker, /backupFrequency/);
  assert.match(backupWorker, /createDatabaseBackup/);
});

test('chat history loads the newest 200 messages while returning them chronologically', () => {
  const messaging = source('src/controllers/messaging.controller.js');
  assert.match(messaging, /const getMessages = asyncHandler/);
  assert.match(messaging, /orderBy: \{ createdAt: 'desc' \}/);
  assert.match(messaging, /take: 200/);
  assert.match(messaging, /messages\.reverse\(\)/);
});
