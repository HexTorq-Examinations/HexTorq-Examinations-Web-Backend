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

// A student may only view/start an exam once it's been mapped to their Class —
// this is what Exam Mapping actually assigns. Throws 403 if no mapping exists.
const assertStudentHasMapping = async (examId, userId) => {
  const profile = await prisma.studentProfile.findUnique({ where: { userId } });
  if (!profile) throw new ApiError(403, 'Only students can take exams');

  const mapping = await prisma.examMapping.findUnique({
    where: { examId_classId: { examId, classId: profile.classId } },
  });
  if (!mapping) throw new ApiError(403, 'This exam has not been scheduled for your class');
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
  await assertStudentHasMapping(id, req.user.id);

  const exam = await prisma.exam.findUnique({ where: { id } });
  if (!exam) throw new ApiError(404, 'Exam not found');

  let attempt = await prisma.examAttempt.findFirst({
    where: { examId: id, userId: req.user.id, status: 'IN_PROGRESS' },
  });

  if (!attempt) {
    attempt = await prisma.examAttempt.create({
      data: { examId: id, userId: req.user.id, status: 'IN_PROGRESS', answers: {}, violations: [] },
    });
  }

  res.status(201).json({
    attemptId: attempt.id,
    status: attempt.status,
    answers: attempt.answers,
    violations: attempt.violations,
    durationSeconds: exam.duration * 60,
  });
});

const saveAnswer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { questionId, answer } = req.body;
  if (!questionId) throw new ApiError(400, 'questionId is required');

  const attempt = await prisma.examAttempt.findFirst({
    where: { examId: id, userId: req.user.id, status: 'IN_PROGRESS' },
  });
  if (!attempt) throw new ApiError(404, 'No active attempt found for this exam');

  const answers = { ...(attempt.answers || {}), [questionId]: answer };
  const updated = await prisma.examAttempt.update({
    where: { id: attempt.id },
    data: { answers },
  });
  res.json({ answers: updated.answers });
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

  const questions = await prisma.question.findMany({ where: { examId: id } });

  const answers = attempt.answers || {};
  let score = 0;
  for (const q of questions) {
    const given = answers[q.id];
    const correctOption = q.options[q.correctAnswer];
    if (given !== undefined && given === correctOption) {
      score += q.marks;
    }
  }

  const finalStatus = status === 'TERMINATED' ? 'TERMINATED' : 'COMPLETED';
  const updated = await prisma.examAttempt.update({
    where: { id: attempt.id },
    data: { status: finalStatus, endedAt: new Date(), score },
  });

  res.json({ attemptId: updated.id, status: updated.status, score: updated.score });
});

const myHistory = asyncHandler(async (req, res) => {
  const attempts = await prisma.examAttempt.findMany({
    where: { userId: req.user.id, status: { in: ['COMPLETED', 'TERMINATED'] } },
    include: { exam: true },
    orderBy: { endedAt: 'desc' },
  });

  res.json(attempts.map((a) => ({
    examId: a.examId,
    status: a.status,
    score: a.score,
    date: (a.endedAt || a.createdAt).getTime(),
  })));
});

module.exports = { getExamForTaking, startAttempt, saveAnswer, recordViolation, submitAttempt, myHistory };
