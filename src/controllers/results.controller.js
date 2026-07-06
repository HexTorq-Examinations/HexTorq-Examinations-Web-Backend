const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const PDFDocument = require('pdfkit');
const { scoreAttemptSnapshot } = require('../utils/scoring');
const { ensureClassGroupConversation, postSystemMessage } = require('./messaging.controller');

const scopeWhere = (req) => {
  if (req.user.role === 'ADMIN' && req.user.organizationId) {
    return { exam: { organizationId: req.user.organizationId } };
  }
  return {};
};

const toPublic = (r) => ({
  id: r.id,
  examId: r.examId,
  examName: r.exam?.title,
  isTestExam: !!r.exam?.isTestExam,
  totalStudents: r.totalStudents,
  publishedDate: r.publishedDate ? r.publishedDate.toISOString().split('T')[0] : '',
  status: r.status,
});

// Results are derived from real ExamAttempt rows (score, status) rather than entered by
// hand — every exam that has at least one finished attempt gets a Result row lazily
// created/kept in sync here, so the registry always reflects actual student activity.
const syncResultsFromAttempts = async (req) => {
  const examOrgFilter = req.user.role === 'ADMIN' && req.user.organizationId
    ? { organizationId: req.user.organizationId }
    : {};

  const finishedByExam = await prisma.examAttempt.groupBy({
    by: ['examId'],
    where: { status: { in: ['COMPLETED', 'TERMINATED'] }, exam: examOrgFilter },
    _count: { _all: true },
  });

  for (const row of finishedByExam) {
    const existing = await prisma.result.findUnique({ where: { examId: row.examId } });
    if (existing) {
      if (existing.totalStudents !== row._count._all) {
        await prisma.result.update({ where: { id: existing.id }, data: { totalStudents: row._count._all } });
      }
    } else {
      const exam = await prisma.exam.findUnique({ where: { id: row.examId } });
      await prisma.result.upsert({
        where: { examId: row.examId },
        update: { totalStudents: row._count._all },
        create: {
          examId: row.examId,
          totalStudents: row._count._all,
          organizationId: exam?.organizationId || null,
          status: 'Pending Evaluation',
        },
      });
    }
  }
};

const list = asyncHandler(async (req, res) => {
  await syncResultsFromAttempts(req);
  const results = await prisma.result.findMany({
    where: scopeWhere(req),
    include: { exam: true },
    orderBy: { id: 'desc' },
  });
  res.json(results.map(toPublic));
});

const publish = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const ownedResult = await prisma.result.findFirst({
    where: { id, ...scopeWhere(req) },
    select: { id: true },
  });
  if (!ownedResult) {
    throw new ApiError(404, 'Result not found');
  }
  const result = await prisma.result.update({
    where: { id },
    data: { status: 'Published', publishedDate: new Date() },
    include: { exam: true },
  });
  const mappings = await prisma.examMapping.findMany({ where: { examId: result.examId } });
  const notifications = await Promise.allSettled(mappings.map(async (mapping) => {
    const conversationId = await ensureClassGroupConversation(mapping.classId, req.user.id);
    await postSystemMessage(conversationId, req.user.id, `Results published for "${result.exam.title}". Students can now view their scorecards.`);
    await prisma.notificationDelivery.create({
      data: {
        channel: 'IN_APP', recipient: `class:${mapping.classId}`, template: 'RESULT_PUBLISHED', status: 'DELIVERED',
        organizationId: result.exam.organizationId, relatedEntityType: 'Result', relatedEntityId: result.id,
        attempts: 1, sentAt: new Date(), deliveredAt: new Date(),
      },
    });
  }));
  notifications.filter((notification) => notification.status === 'rejected').forEach((notification) => console.error('Result publication notification failed', notification.reason));
  res.json(toPublic(result));
});

const attemptScope = (req) => req.user.role === 'ADMIN'
  ? { exam: { organizationId: req.user.organizationId } }
  : {};

const listAttempts = asyncHandler(async (req, res) => {
  const attempts = await prisma.examAttempt.findMany({
    where: { ...attemptScope(req), ...(req.query.examId ? { examId: req.query.examId } : {}) },
    include: { user: { include: { studentProfile: true } }, exam: true },
    orderBy: { startedAt: 'desc' },
  });
  res.json(attempts.map((attempt) => ({
    id: attempt.id,
    examId: attempt.examId,
    examTitle: attempt.exam.title,
    studentName: attempt.user.name,
    registerNumber: attempt.user.studentProfile?.registerNumber,
    status: attempt.status,
    score: attempt.score,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    violationsCount: Array.isArray(attempt.violations) ? attempt.violations.length : 0,
    manuallyEvaluated: attempt.manuallyEvaluated,
  })));
});

const loadOwnedAttempt = async (id, req) => {
  const attempt = await prisma.examAttempt.findFirst({
    where: { id, ...attemptScope(req) },
    include: {
      user: { include: { studentProfile: true } },
      exam: true,
      answerRecords: true,
      administrativeActions: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!attempt) throw new ApiError(404, 'Attempt not found');
  return attempt;
};

const attemptDetail = asyncHandler(async (req, res) => {
  const attempt = await loadOwnedAttempt(req.params.id, req);
  const answers = Object.fromEntries(attempt.answerRecords.map((answer) => [answer.questionId, answer.selectedAnswer]));
  const snapshot = Array.isArray(attempt.questionSnapshot) ? attempt.questionSnapshot : [];
  res.json({
    id: attempt.id,
    status: attempt.status,
    score: attempt.score,
    exam: { id: attempt.exam.id, title: attempt.exam.title, totalMarks: attempt.exam.totalMarks, passingMarks: attempt.exam.passingMarks },
    student: { id: attempt.user.id, name: attempt.user.name, email: attempt.user.email, registerNumber: attempt.user.studentProfile?.registerNumber },
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    endedAt: attempt.endedAt,
    violations: attempt.violations,
    manuallyEvaluated: attempt.manuallyEvaluated,
    evaluationReason: attempt.evaluationReason,
    actions: attempt.administrativeActions,
    questions: snapshot.map((question) => ({ ...question, selectedAnswer: answers[question.id] })),
  });
});

const recordAttemptAction = (attemptId, req, action, reason, details) => prisma.attemptAdministrativeAction.create({
  data: { attemptId, actorId: req.user.id, action, reason, details },
});

const manualEvaluate = asyncHandler(async (req, res) => {
  const attempt = await loadOwnedAttempt(req.params.id, req);
  const score = Number(req.body.score);
  const reason = String(req.body.reason || '').trim();
  if (!Number.isFinite(score) || !reason) throw new ApiError(400, 'A valid score and reason are required');
  await prisma.$transaction([
    prisma.examAttempt.update({ where: { id: attempt.id }, data: { score, manuallyEvaluated: true, evaluationReason: reason, evaluatedAt: new Date(), evaluatedById: req.user.id } }),
    prisma.result.updateMany({ where: { examId: attempt.examId }, data: { status: 'Pending Evaluation', publishedDate: null } }),
    recordAttemptAction(attempt.id, req, 'MANUAL_EVALUATION', reason, { previousScore: attempt.score, score }),
  ]);
  res.json({ success: true, score });
});

const regrade = asyncHandler(async (req, res) => {
  const attempt = await loadOwnedAttempt(req.params.id, req);
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw new ApiError(400, 'Regrade reason is required');
  const answers = Object.fromEntries(attempt.answerRecords.map((answer) => [answer.questionId, answer.selectedAnswer]));
  const score = scoreAttemptSnapshot(attempt.questionSnapshot, answers, { negativeMarking: attempt.negativeMarking, negativeMarkingRate: attempt.negativeMarkingRate });
  await prisma.$transaction([
    prisma.examAttempt.update({ where: { id: attempt.id }, data: { score, manuallyEvaluated: false, evaluationReason: reason, evaluatedAt: new Date(), evaluatedById: req.user.id } }),
    prisma.result.updateMany({ where: { examId: attempt.examId }, data: { status: 'Pending Evaluation', publishedDate: null } }),
    recordAttemptAction(attempt.id, req, 'REGRADE', reason, { previousScore: attempt.score, score }),
  ]);
  res.json({ success: true, score });
});

const extendAttempt = asyncHandler(async (req, res) => {
  const attempt = await loadOwnedAttempt(req.params.id, req);
  const minutes = Number(req.body.minutes);
  const reason = String(req.body.reason || '').trim();
  if (attempt.status !== 'IN_PROGRESS' || !attempt.expiresAt) throw new ApiError(409, 'Only active attempts can be extended');
  if (!Number.isFinite(minutes) || minutes <= 0 || !reason) throw new ApiError(400, 'Positive extension minutes and a reason are required');
  const expiresAt = new Date(attempt.expiresAt.getTime() + minutes * 60 * 1000);
  await prisma.$transaction([
    prisma.examAttempt.update({ where: { id: attempt.id }, data: { expiresAt, extensionSeconds: { increment: Math.round(minutes * 60) } } }),
    prisma.attemptDeadlineJob.upsert({ where: { attemptId: attempt.id }, update: { runAt: expiresAt, status: 'PENDING', completedAt: null }, create: { attemptId: attempt.id, runAt: expiresAt } }),
    recordAttemptAction(attempt.id, req, 'EXTEND', reason, { minutes, expiresAt }),
  ]);
  res.json({ success: true, expiresAt });
});

const resetAttempt = asyncHandler(async (req, res) => {
  const attempt = await loadOwnedAttempt(req.params.id, req);
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw new ApiError(400, 'Reset reason is required');
  if (!['COMPLETED', 'TERMINATED'].includes(attempt.status)) throw new ApiError(409, 'Only finalized attempts can be reset');
  await prisma.$transaction([
    prisma.examAttempt.update({ where: { id: attempt.id }, data: { status: 'RESET' } }),
    prisma.result.updateMany({ where: { examId: attempt.examId }, data: { status: 'Pending Evaluation', publishedDate: null } }),
    prisma.attemptDeadlineJob.updateMany({ where: { attemptId: attempt.id }, data: { status: 'DONE', completedAt: new Date() } }),
    recordAttemptAction(attempt.id, req, 'RESET', reason, { previousStatus: attempt.status, previousScore: attempt.score }),
  ]);
  res.json({ success: true });
});

const csvEscape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
const exportCsv = asyncHandler(async (req, res) => {
  const result = await prisma.result.findFirst({ where: { id: req.params.id, ...scopeWhere(req) }, include: { exam: true } });
  if (!result) throw new ApiError(404, 'Result not found');
  const attempts = await prisma.examAttempt.findMany({ where: { examId: result.examId, status: { in: ['COMPLETED', 'TERMINATED'] } }, include: { user: { include: { studentProfile: true } } } });
  const rows = [['Register Number', 'Student', 'Email', 'Score', 'Status'], ...attempts.map((a) => [a.user.studentProfile?.registerNumber, a.user.name, a.user.email, a.score, a.status])];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${result.exam.title.replace(/[^a-z0-9]+/gi, '-')}-results.csv"`);
  res.send(rows.map((row) => row.map(csvEscape).join(',')).join('\n'));
});

const exportAllCsv = asyncHandler(async (req, res) => {
  const attempts = await prisma.examAttempt.findMany({
    where: { ...attemptScope(req), status: { in: ['COMPLETED', 'TERMINATED'] } },
    include: { exam: true, user: { include: { studentProfile: true } } },
    orderBy: { endedAt: 'desc' },
  });
  const rows = [['Exam', 'Register Number', 'Student', 'Email', 'Score', 'Total Marks', 'Status'], ...attempts.map((a) => [a.exam.title, a.user.studentProfile?.registerNumber, a.user.name, a.user.email, a.score, a.exam.totalMarks, a.status])];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="all-results.csv"');
  res.send(rows.map((row) => row.map(csvEscape).join(',')).join('\n'));
});

const attemptPdf = asyncHandler(async (req, res) => {
  const attempt = await loadOwnedAttempt(req.params.id, req);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="scorecard-${attempt.id}.pdf"`);
  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);
  doc.fontSize(20).text('HexTorq Examination Scorecard', { align: 'center' }).moveDown();
  doc.fontSize(12).text(`Student: ${attempt.user.name}`);
  doc.text(`Register Number: ${attempt.user.studentProfile?.registerNumber || '-'}`);
  doc.text(`Exam: ${attempt.exam.title}`);
  doc.text(`Score: ${attempt.score} / ${attempt.exam.totalMarks}`);
  doc.text(`Result: ${attempt.score >= attempt.exam.passingMarks ? 'PASS' : 'FAIL'}`);
  doc.text(`Status: ${attempt.status}`);
  doc.text(`Completed: ${attempt.endedAt?.toISOString() || '-'}`);
  doc.end();
});

const attemptResponsePdf = asyncHandler(async (req, res) => {
  const attempt = await loadOwnedAttempt(req.params.id, req);
  const answers = Object.fromEntries(attempt.answerRecords.map((answer) => [answer.questionId, answer.selectedAnswer]));
  const snapshot = Array.isArray(attempt.questionSnapshot) ? attempt.questionSnapshot : [];
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="response-${attempt.user.studentProfile?.registerNumber || attempt.userId}-${attempt.id}.pdf"`);
  const doc = new PDFDocument({ margin: 42, size: 'A4' });
  doc.pipe(res);
  doc.fontSize(19).text('HexTorq Examination Response', { align: 'center' }).moveDown(0.5);
  doc.fontSize(10).fillColor('#475569').text(`Attempt ID: ${attempt.id}`, { align: 'center' }).moveDown();
  doc.fillColor('#111827').fontSize(11);
  doc.text(`Student: ${attempt.user.name}`);
  doc.text(`Register Number: ${attempt.user.studentProfile?.registerNumber || '-'}`);
  doc.text(`Exam: ${attempt.exam.title}`);
  doc.text(`Score: ${attempt.score} / ${attempt.exam.totalMarks}    Status: ${attempt.status}`);
  doc.text(`Started: ${attempt.startedAt.toISOString()}    Submitted: ${attempt.endedAt?.toISOString() || '-'}`).moveDown();
  const violations = Array.isArray(attempt.violations) ? attempt.violations : [];
  doc.fontSize(12).fillColor('#111827').text(`Violations: ${violations.length}`);
  violations.forEach((violation, index) => {
    const at = violation.timestamp ? new Date(violation.timestamp).toISOString() : 'Time unavailable';
    doc.fontSize(9).fillColor('#b45309').text(`${index + 1}. ${violation.type || 'VIOLATION'} — ${violation.description || 'No reason recorded'} (${at})`);
  });
  doc.moveDown();
  snapshot.forEach((question, index) => {
    if (doc.y > 690) doc.addPage();
    const selected = answers[question.id] ?? attempt.answers?.[question.id] ?? 'Unanswered';
    doc.fontSize(11).fillColor('#111827').text(`${index + 1}. ${question.text}`, { continued: false });
    doc.fontSize(9).fillColor('#475569').text(`Marks: ${question.marks}`);
    (question.options || []).forEach((option, optionIndex) => doc.text(`   ${String.fromCharCode(65 + optionIndex)}. ${option}`));
    doc.moveDown(0.25).fillColor(selected === question.correctAnswer ? '#047857' : '#b91c1c').text(`Student answer: ${selected}`);
    doc.fillColor('#047857').text(`Correct answer: ${question.correctAnswer}`).moveDown();
  });
  if (!snapshot.length) doc.text('No frozen questions were available for this attempt.');
  doc.end();
});

const GRADE_BUCKETS = [
  { name: 'Distinction', color: '#10b981', min: 75 },
  { name: 'First Class', color: '#3b82f6', min: 60 },
  { name: 'Second Class', color: '#f59e0b', min: 0 },
];

// Real pass/fail/grade/subject analytics computed directly from ExamAttempt rows —
// no mock data, no separate manually-entered stats table.
const analytics = asyncHandler(async (req, res) => {
  const examOrgFilter = req.user.role === 'ADMIN' && req.user.organizationId
    ? { organizationId: req.user.organizationId }
    : {};

  const attempts = await prisma.examAttempt.findMany({
    where: { status: { in: ['COMPLETED', 'TERMINATED'] }, exam: examOrgFilter },
    include: { exam: true },
  });

  const totalStudents = attempts.length;

  const withPct = attempts
    .filter((a) => a.exam && a.exam.totalMarks > 0)
    .map((a) => ({
      pct: (a.score / a.exam.totalMarks) * 100,
      passed: a.status === 'COMPLETED' && a.score >= a.exam.passingMarks,
      subject: a.exam.subject,
    }));

  const passCount = withPct.filter((a) => a.passed).length;
  const overallPassRate = withPct.length > 0 ? Math.round((passCount / withPct.length) * 1000) / 10 : 0;
  const averageScorePercent = withPct.length > 0
    ? Math.round(withPct.reduce((sum, a) => sum + a.pct, 0) / withPct.length)
    : 0;
  const needsAttention = withPct.filter((a) => !a.passed).length;

  const subjectMap = new Map();
  for (const a of withPct) {
    const bucket = subjectMap.get(a.subject) || [];
    bucket.push(a.pct);
    subjectMap.set(a.subject, bucket);
  }
  const subjectPerformance = Array.from(subjectMap.entries()).map(([subject, pcts]) => ({
    subject,
    average: Math.round(pcts.reduce((s, p) => s + p, 0) / pcts.length),
    highest: Math.round(Math.max(...pcts)),
  }));

  const gradeCounts = { Distinction: 0, 'First Class': 0, 'Second Class': 0, Failed: 0 };
  for (const a of withPct) {
    if (!a.passed) {
      gradeCounts.Failed += 1;
      continue;
    }
    const bucket = GRADE_BUCKETS.find((b) => a.pct >= b.min);
    gradeCounts[bucket.name] += 1;
  }
  const gradeDistribution = [
    ...GRADE_BUCKETS.map((b) => ({ name: b.name, value: gradeCounts[b.name], color: b.color })),
    { name: 'Failed', value: gradeCounts.Failed, color: '#ef4444' },
  ];

  res.json({
    totalStudents,
    overallPassRate,
    averageScorePercent,
    needsAttention,
    subjectPerformance,
    gradeDistribution,
  });
});

module.exports = { list, publish, analytics, listAttempts, attemptDetail, manualEvaluate, regrade, extendAttempt, resetAttempt, exportCsv, exportAllCsv, attemptPdf, attemptResponsePdf };
