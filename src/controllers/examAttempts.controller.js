const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

// Unbiased Fisher-Yates shuffle. Never mutates the input array.
const shuffle = (arr) => {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

const calculateScore = async (examId, answers = {}) => {
  const questions = await prisma.question.findMany({ where: { examId } });
  return questions.reduce((score, question) => {
    const correctOption = question.options[question.correctAnswer];
    return answers[question.id] !== undefined && answers[question.id] === correctOption
      ? score + question.marks
      : score;
  }, 0);
};

const ensurePendingResult = async (examId) => {
  const existingResult = await prisma.result.findFirst({ where: { examId } });
  if (existingResult) return;
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { organizationId: true } });
  await prisma.result.create({
    data: { examId, organizationId: exam?.organizationId || null, status: 'Pending Evaluation', totalStudents: 1 },
  });
};

// Finalization is server-owned and conditional, so a worker, a client submit, and
// a last-second request can race without completing/scoring the same attempt twice.
const finalizeAttempt = async (attempt, finalStatus = 'COMPLETED', endedAt = new Date()) => {
  const claimed = await prisma.examAttempt.updateMany({
    where: { id: attempt.id, status: 'IN_PROGRESS' },
    data: { status: 'FINALIZING', endedAt },
  });
  let frozenAttempt = await prisma.examAttempt.findUnique({ where: { id: attempt.id } });
  if (!frozenAttempt || (claimed.count === 0 && frozenAttempt.status !== 'FINALIZING')) return frozenAttempt;

  // Read answers only after claiming the attempt. No answer endpoint accepts the
  // FINALIZING state, so this is a stable server-side snapshot for scoring.
  const score = await calculateScore(frozenAttempt.examId, frozenAttempt.answers || {});
  const completed = await prisma.examAttempt.updateMany({
    where: { id: attempt.id, status: 'FINALIZING' },
    data: { status: finalStatus, endedAt, score },
  });
  if (completed.count > 0) await ensurePendingResult(frozenAttempt.examId);
  return prisma.examAttempt.findUnique({ where: { id: attempt.id } });
};

const finalizeExpiredAttempts = async () => {
  const now = new Date();
  const expired = await prisma.examAttempt.findMany({
    where: {
      OR: [
        { status: 'IN_PROGRESS', expiresAt: { lte: now } },
        { status: 'FINALIZING' },
      ],
    },
  });
  await Promise.all(expired.map((attempt) => finalizeAttempt(attempt, 'COMPLETED', attempt.expiresAt || now)));
  return expired.length;
};

const finalizeIfExpired = async (attempt) => {
  if (!attempt?.expiresAt || attempt.expiresAt.getTime() > Date.now()) return null;
  return finalizeAttempt(attempt, 'COMPLETED', attempt.expiresAt);
};

// A student may only view/start an exam once it's been mapped to their Class —
// this is what Exam Mapping actually assigns. Throws 403 if no mapping exists,
// if the exam's scheduled window hasn't opened yet or has already closed, or if
// the student has already completed/been terminated from this exam once.
const assertStudentHasMapping = async (examId, userId) => {
  const profile = await prisma.studentProfile.findUnique({ where: { userId } });
  if (!profile) throw new ApiError(403, 'Only students can take exams');

  const mapping = await prisma.examMapping.findUnique({
    where: { examId_classId: { examId, classId: profile.classId } },
    include: { exam: { select: { status: true } } },
  });
  if (!mapping) throw new ApiError(403, 'This exam has not been scheduled for your class');
  if (mapping.exam.status !== 'Published') throw new ApiError(403, 'This exam has not been published yet');

  const priorAttempt = await prisma.examAttempt.findFirst({
    where: { examId, userId, status: { in: ['COMPLETED', 'TERMINATED'] } },
  });
  if (priorAttempt) throw new ApiError(403, 'You have already attempted this exam');

  const dateStr = mapping.date.toISOString().slice(0, 10);
  const windowStart = new Date(`${dateStr}T${mapping.startTime}:00`);
  const windowEnd = new Date(`${dateStr}T${mapping.endTime}:00`);
  const now = new Date();
  if (now < windowStart) throw new ApiError(403, 'This exam has not started yet');
  if (now > windowEnd) throw new ApiError(403, 'This exam window has already ended');

  return mapping;
};

// Returns exam details + the question set (without correct answers) for the exam-taking UI.
// Both question order and option order are randomized server-side, per request, when enabled
// on the exam. The client only ever receives option text (never the correct-answer index),
// and answers are matched by text server-side, so shuffling here cannot affect scoring.
const getExamForTaking = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertStudentHasMapping(id, req.user.id);

  const exam = await prisma.exam.findUnique({ where: { id } });
  if (!exam) throw new ApiError(404, 'Exam not found');

  const rawQuestions = await prisma.question.findMany({ where: { examId: id } });
  if (rawQuestions.length === 0) {
    throw new ApiError(400, 'This exam has no questions configured. Please contact your exam administrator.');
  }

  let questions = rawQuestions.map((q) => ({
    id: q.id,
    text: q.text,
    options: exam.shuffleOptions ? shuffle(q.options) : q.options,
    marks: q.marks,
  }));

  if (exam.shuffleQuestions) {
    questions = shuffle(questions);
  }

  res.json({
    id: exam.id,
    title: exam.title,
    subject: exam.subject,
    duration: exam.duration,
    totalMarks: exam.totalMarks,
    negativeMarking: exam.negativeMarking,
    questions,
  });
});

const startAttempt = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const mapping = await assertStudentHasMapping(id, req.user.id);

  const exam = await prisma.exam.findUnique({
    where: { id },
    include: { _count: { select: { questions: true } } },
  });
  if (!exam) throw new ApiError(404, 'Exam not found');
  if (exam._count.questions === 0) {
    throw new ApiError(400, 'This exam has no questions configured. Add questions before starting it.');
  }

  let attempt = await prisma.examAttempt.findFirst({
    where: { examId: id, userId: req.user.id, status: 'IN_PROGRESS' },
  });

  if (!attempt) {
    const startedAt = new Date();
    const durationDeadline = new Date(startedAt.getTime() + exam.duration * 60 * 1000);
    const mappingDate = mapping.date.toISOString().slice(0, 10);
    const mappingDeadline = new Date(`${mappingDate}T${mapping.endTime}:00`);
    const expiresAt = new Date(Math.min(durationDeadline.getTime(), mappingDeadline.getTime()));
    attempt = await prisma.examAttempt.create({
      data: { examId: id, userId: req.user.id, status: 'IN_PROGRESS', startedAt, expiresAt, answers: {}, violations: [] },
    });
  } else if (!attempt.expiresAt) {
    const expiresAt = new Date(attempt.startedAt.getTime() + exam.duration * 60 * 1000);
    attempt = await prisma.examAttempt.update({ where: { id: attempt.id }, data: { expiresAt } });
  }

  const expiredAttempt = await finalizeIfExpired(attempt);
  if (expiredAttempt) throw new ApiError(409, 'This exam attempt has expired and was submitted automatically');

  res.status(201).json({
    attemptId: attempt.id,
    status: attempt.status,
    answers: attempt.answers,
    violations: attempt.violations,
    serverNow: new Date().toISOString(),
    startedAt: attempt.startedAt.toISOString(),
    expiresAt: attempt.expiresAt.toISOString(),
    durationSeconds: Math.max(0, Math.ceil((attempt.expiresAt.getTime() - Date.now()) / 1000)),
  });
});

const saveAnswer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { questionId, answer } = req.body;
  if (!questionId) throw new ApiError(400, 'questionId is required');

  const attempt = await prisma.examAttempt.findFirst({
    where: { examId: id, userId: req.user.id, status: 'IN_PROGRESS' },
  });
  if (!attempt) {
    // A delayed offline retry may arrive after the server has already finalized
    // the deadline. Return the authoritative final snapshot so the client can
    // stop retrying; answers received after expiry are intentionally not counted.
    const finished = await prisma.examAttempt.findFirst({
      where: { examId: id, userId: req.user.id, status: { in: ['COMPLETED', 'TERMINATED'] } },
      orderBy: { endedAt: 'desc' },
    });
    if (finished) return res.json({ answers: finished.answers, status: finished.status });
    throw new ApiError(404, 'No active attempt found for this exam');
  }
  if (await finalizeIfExpired(attempt)) {
    throw new ApiError(409, 'The exam time has ended and the attempt was submitted automatically');
  }

  const answers = { ...(attempt.answers || {}), [questionId]: answer };
  const updated = await prisma.examAttempt.updateMany({
    where: { id: attempt.id, status: 'IN_PROGRESS', expiresAt: { gt: new Date() } },
    data: { answers },
  });
  if (updated.count === 0) {
    await finalizeIfExpired(attempt);
    throw new ApiError(409, 'The exam time has ended and the attempt was submitted automatically');
  }
  res.json({ answers });
});

// Warnings 1-5 are allowed; the 6th violation (count > MAX_VIOLATIONS) auto-terminates the attempt.
const MAX_VIOLATIONS = 5;

const recordViolation = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { type, description, clientViolationId } = req.body;
  if (!type) throw new ApiError(400, 'Violation type is required');

  const attempt = await prisma.examAttempt.findFirst({
    where: { examId: id, userId: req.user.id, status: 'IN_PROGRESS' },
  });
  if (!attempt) {
    // The attempt may already be terminated/completed (e.g. a queued retry landing
    // after the exam ended offline). Return the final state instead of erroring so
    // background sync loops can resolve cleanly rather than retrying forever.
    const finished = await prisma.examAttempt.findFirst({
      where: { examId: id, userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    if (finished) return res.json({ violations: finished.violations, status: finished.status });
    throw new ApiError(404, 'No attempt found for this exam');
  }

  if (await finalizeIfExpired(attempt)) {
    return res.json({ violations: attempt.violations || [], status: 'COMPLETED' });
  }

  const existing = attempt.violations || [];
  // Idempotent: a retried request with the same client-generated id is a no-op.
  if (clientViolationId && existing.some((v) => v.clientViolationId === clientViolationId)) {
    return res.json({ violations: existing, status: attempt.status });
  }

  const violations = [...existing, {
    id: Math.random().toString(36).slice(2),
    clientViolationId,
    timestamp: Date.now(),
    type,
    description,
  }];

  const shouldTerminate = violations.length > MAX_VIOLATIONS;

  const updated = await prisma.examAttempt.update({
    where: { id: attempt.id },
    data: {
      violations,
      ...(shouldTerminate ? { status: 'TERMINATED', endedAt: new Date() } : {}),
    },
  });

  res.json({ violations: updated.violations, status: updated.status });
});

const submitAttempt = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const attempt = await prisma.examAttempt.findFirst({
    where: { examId: id, userId: req.user.id, status: 'IN_PROGRESS' },
  });

  if (!attempt) {
    // Idempotent: if a previous submit already landed (e.g. this is a retried
    // request whose earlier response was lost to a flaky connection), just
    // return the already-finalized result instead of erroring.
    const finished = await prisma.examAttempt.findFirst({
      where: { examId: id, userId: req.user.id, status: { in: ['COMPLETED', 'TERMINATED'] } },
      orderBy: { endedAt: 'desc' },
    });
    if (finished) {
      return res.json({ attemptId: finished.id, status: finished.status, score: finished.score });
    }
    throw new ApiError(404, 'No active attempt found for this exam');
  }

  const finalStatus = status === 'TERMINATED' ? 'TERMINATED' : 'COMPLETED';
  const updated = await finalizeAttempt(attempt, finalStatus);

  res.json({ attemptId: updated.id, status: updated.status, score: updated.score });
});

// Scores are only ever revealed to the student once the org's Admin has explicitly
// published the Result for that exam — an unpublished/missing Result row means
// "Pending Evaluation" and the raw score is withheld entirely, not just hidden in the UI.
const myHistory = asyncHandler(async (req, res) => {
  const attempts = await prisma.examAttempt.findMany({
    where: { userId: req.user.id, status: { in: ['COMPLETED', 'TERMINATED'] } },
    include: { exam: true },
    orderBy: { endedAt: 'desc' },
  });

  const examIds = attempts.map((a) => a.examId);
  const results = await prisma.result.findMany({ where: { examId: { in: examIds } } });
  const publishedExamIds = new Set(results.filter((r) => r.status === 'Published').map((r) => r.examId));

  res.json(attempts.map((a) => {
    const isPublished = publishedExamIds.has(a.examId);
    return {
      examId: a.examId,
      status: a.status,
      resultStatus: isPublished ? 'Published' : 'Pending Evaluation',
      score: isPublished ? a.score : null,
      date: (a.endedAt || a.createdAt).getTime(),
    };
  }));
});

// Read-only progress snapshot for the Active Exams list — does NOT create an
// attempt as a side effect (unlike startAttempt), so simply viewing the list
// can never start the clock on an exam.
const myAttemptStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [attempt, totalQuestions] = await Promise.all([
    prisma.examAttempt.findFirst({ where: { examId: id, userId: req.user.id, status: 'IN_PROGRESS' } }),
    prisma.question.count({ where: { examId: id } }),
  ]);
  const finalized = attempt ? await finalizeIfExpired(attempt) : null;
  const activeAttempt = finalized ? null : attempt;
  res.json({
    hasActiveAttempt: !!activeAttempt,
    status: finalized?.status || activeAttempt?.status || null,
    serverNow: new Date().toISOString(),
    expiresAt: activeAttempt?.expiresAt?.toISOString() || null,
    answeredCount: activeAttempt ? Object.keys(activeAttempt.answers || {}).length : 0,
    totalQuestions,
  });
});

module.exports = { getExamForTaking, startAttempt, saveAnswer, recordViolation, submitAttempt, myHistory, myAttemptStatus, finalizeExpiredAttempts };
