const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { scoreAttemptSnapshot } = require('../utils/scoring');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');

// Unbiased Fisher-Yates shuffle. Never mutates the input array.
const shuffle = (arr) => {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

const buildQuestionSnapshot = (exam, questions) => {
  let snapshot = questions.map((question) => ({
    id: question.id,
    text: question.text,
    options: exam.shuffleOptions ? shuffle(question.options) : [...question.options],
    correctAnswer: question.options[question.correctAnswer],
    marks: question.marks,
  }));
  if (exam.shuffleQuestions) snapshot = shuffle(snapshot);
  return snapshot;
};

const toCandidateQuestions = (snapshot) => snapshot.map(({ correctAnswer, ...question }) => question);

const answerRecordsToMap = (records) => Object.fromEntries(
  records.map((record) => [record.questionId, record.selectedAnswer])
);

const ensureQuestionSnapshot = async (attempt) => {
  if (Array.isArray(attempt.questionSnapshot) && attempt.questionSnapshot.length > 0) return attempt;
  const exam = await prisma.exam.findUnique({
    where: { id: attempt.examId },
    include: { questions: { orderBy: { createdAt: 'asc' } } },
  });
  if (!exam || exam.questions.length === 0) return attempt;
  return prisma.examAttempt.update({
    where: { id: attempt.id },
    data: { questionSnapshot: buildQuestionSnapshot(exam, exam.questions) },
  });
};

const calculateScore = async (attempt) => {
  const frozenAttempt = await ensureQuestionSnapshot(attempt);
  const [records, legacyAnswers] = await Promise.all([
    prisma.examAnswer.findMany({ where: { attemptId: frozenAttempt.id } }),
    Promise.resolve(frozenAttempt.answers || {}),
  ]);
  const answers = records.length > 0 ? answerRecordsToMap(records) : legacyAnswers;
  const snapshot = Array.isArray(frozenAttempt.questionSnapshot) ? frozenAttempt.questionSnapshot : [];
  return scoreAttemptSnapshot(snapshot, answers, {
    negativeMarking: frozenAttempt.negativeMarking,
    negativeMarkingRate: frozenAttempt.negativeMarkingRate,
  });
};

const ensurePendingResult = async (examId) => {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { organizationId: true } });
  await prisma.result.upsert({
    where: { examId },
    update: {},
    create: { examId, organizationId: exam?.organizationId || null, status: 'Pending Evaluation', totalStudents: 1 },
  });
};

// Finalization is server-owned and conditional, so a worker, a client submit, and
// a last-second request can race without completing/scoring the same attempt twice.
const completeFinalizingAttempt = async (attemptId, finalStatus, endedAt) => {
  let frozenAttempt = await prisma.examAttempt.findUnique({ where: { id: attemptId } });
  if (!frozenAttempt || frozenAttempt.status !== 'FINALIZING') return frozenAttempt;
  // Read answers only after claiming the attempt. No answer endpoint accepts the
  // FINALIZING state, so this is a stable server-side snapshot for scoring.
  const score = await calculateScore(frozenAttempt);
  const completed = await prisma.examAttempt.updateMany({
    where: { id: attemptId, status: 'FINALIZING' },
    data: { status: finalStatus, endedAt, score },
  });
  if (completed.count > 0) await ensurePendingResult(frozenAttempt.examId);
  return prisma.examAttempt.findUnique({ where: { id: attemptId } });
};

const finalizeAttempt = async (attempt, finalStatus = 'COMPLETED', endedAt = new Date()) => {
  const claimed = await prisma.examAttempt.updateMany({
    where: { id: attempt.id, status: 'IN_PROGRESS' },
    data: { status: 'FINALIZING', endedAt },
  });
  const current = await prisma.examAttempt.findUnique({ where: { id: attempt.id } });
  if (!current || (claimed.count === 0 && current.status !== 'FINALIZING')) return current;
  return completeFinalizingAttempt(attempt.id, finalStatus, endedAt);
};

const claimDeadlineJobs = async (workerId, batchSize = 25) => {
  const staleBefore = new Date(Date.now() - 60_000);
  return prisma.$queryRaw`
    WITH claimable AS (
      SELECT "id"
      FROM "AttemptDeadlineJob"
      WHERE ("status" = 'PENDING' AND "runAt" <= NOW())
         OR ("status" = 'PROCESSING' AND "lockedAt" < ${staleBefore})
      ORDER BY "runAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "AttemptDeadlineJob" AS job
    SET "status" = 'PROCESSING',
        "lockedAt" = NOW(),
        "lockedBy" = ${workerId},
        "attempts" = job."attempts" + 1,
        "updatedAt" = NOW()
    FROM claimable
    WHERE job."id" = claimable."id"
    RETURNING job."id", job."attemptId"
  `;
};

const processDeadlineJobs = async (workerId, batchSize = 25) => {
  const jobs = await claimDeadlineJobs(workerId, batchSize);
  for (const job of jobs) {
    try {
      const attempt = await prisma.examAttempt.findUnique({ where: { id: job.attemptId } });
      if (!attempt || ['COMPLETED', 'TERMINATED'].includes(attempt.status)) {
        await prisma.attemptDeadlineJob.update({
          where: { id: job.id },
          data: { status: 'DONE', completedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null },
        });
        continue;
      }

      if (attempt.expiresAt && attempt.expiresAt.getTime() > Date.now()) {
        await prisma.attemptDeadlineJob.update({
          where: { id: job.id },
          data: { status: 'PENDING', runAt: attempt.expiresAt, lockedAt: null, lockedBy: null },
        });
        continue;
      }

      const finalized = await finalizeAttempt(attempt, 'COMPLETED', attempt.expiresAt || new Date());
      if (!finalized || !['COMPLETED', 'TERMINATED'].includes(finalized.status)) {
        throw new Error(`Attempt ${attempt.id} did not reach a final state`);
      }
      await prisma.attemptDeadlineJob.update({
        where: { id: job.id },
        data: { status: 'DONE', completedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.attemptDeadlineJob.updateMany({
        where: { id: job.id, lockedBy: workerId },
        data: {
          status: 'PENDING',
          runAt: new Date(Date.now() + 30_000),
          lockedAt: null,
          lockedBy: null,
          lastError: message.slice(0, 2000),
        },
      });
    }
  }
  return jobs.length;
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

  const now = new Date();
  if (now < mapping.startAt) throw new ApiError(403, 'This exam has not started yet');
  const effectiveEnd = new Date(mapping.endAt.getTime() + (mapping.graceMinutes + Math.max(0, profile.extraTimeMinutes || 0)) * 60 * 1000);
  if (now > effectiveEnd) throw new ApiError(403, 'This exam window has already ended');

  return { mapping, profile };
};

// Returns exam details + the question set (without correct answers) for the exam-taking UI.
// Both question order and option order are randomized server-side, per request, when enabled
// on the exam. The client only ever receives option text (never the correct-answer index),
// and answers are matched by text server-side, so shuffling here cannot affect scoring.
const getExamForTaking = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertStudentHasMapping(id, req.user.id);

  const exam = await prisma.exam.findUnique({
    where: { id },
    include: { questions: { orderBy: { createdAt: 'asc' } } },
  });
  if (!exam) throw new ApiError(404, 'Exam not found');
  if (exam.questions.length === 0) {
    throw new ApiError(400, 'This exam has no questions configured. Please contact your exam administrator.');
  }

  let activeAttempt = await prisma.examAttempt.findFirst({
    where: { examId: id, userId: req.user.id, status: 'IN_PROGRESS' },
  });
  if (activeAttempt) {
    activeAttempt = await ensureQuestionSnapshot(activeAttempt);
  }
  const snapshot = activeAttempt?.questionSnapshot?.length
    ? activeAttempt.questionSnapshot
    : buildQuestionSnapshot(exam, exam.questions);

  res.json({
    id: exam.id,
    title: exam.title,
    subject: exam.subject,
    duration: exam.duration,
    totalMarks: exam.totalMarks,
    negativeMarking: exam.negativeMarking,
    questions: toCandidateQuestions(snapshot),
  });
});

const startAttempt = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { mapping, profile } = await assertStudentHasMapping(id, req.user.id);

  const exam = await prisma.exam.findUnique({
    where: { id },
    include: { questions: { orderBy: { createdAt: 'asc' } } },
  });
  if (!exam) throw new ApiError(404, 'Exam not found');
  if (exam.questions.length === 0) {
    throw new ApiError(400, 'This exam has no questions configured. Add questions before starting it.');
  }

  let attempt = await prisma.examAttempt.findFirst({
    where: { examId: id, userId: req.user.id, status: 'IN_PROGRESS' },
  });

  if (!attempt) {
    const startedAt = new Date();
    const accommodationMinutes = Math.max(0, profile.extraTimeMinutes || 0);
    const durationDeadline = new Date(startedAt.getTime() + (exam.duration + accommodationMinutes) * 60 * 1000);
    const mappingDeadline = mapping.endAt.getTime() + (mapping.graceMinutes + accommodationMinutes) * 60 * 1000;
    const expiresAt = new Date(Math.min(durationDeadline.getTime(), mappingDeadline));
    const questionSnapshot = buildQuestionSnapshot(exam, exam.questions);
    const latest = await prisma.examAttempt.aggregate({ where: { examId: id, userId: req.user.id }, _max: { attemptNumber: true } });
    try {
      attempt = await prisma.examAttempt.create({
        data: {
        examId: id,
        userId: req.user.id,
        attemptNumber: (latest._max.attemptNumber || 0) + 1,
        status: 'IN_PROGRESS',
        startedAt,
        expiresAt,
        negativeMarking: exam.negativeMarking,
        negativeMarkingRate: 0.25,
        maxViolations: exam.maxViolations,
        calculatorEnabled: exam.calculatorEnabled,
        questionSnapshot,
        answers: {},
        violations: [],
          deadlineJob: { create: { runAt: expiresAt } },
        },
      });
    } catch (error) {
      if (error.code !== 'P2002') throw error;
      attempt = await prisma.examAttempt.findFirst({ where: { examId: id, userId: req.user.id, status: 'IN_PROGRESS' } });
      if (!attempt) throw new ApiError(409, 'An attempt is already being started. Please retry.');
    }
  } else if (!attempt.expiresAt) {
    const expiresAt = new Date(attempt.startedAt.getTime() + exam.duration * 60 * 1000);
    attempt = await prisma.examAttempt.update({ where: { id: attempt.id }, data: { expiresAt } });
  }
  attempt = await ensureQuestionSnapshot(attempt);
  if (attempt.expiresAt) {
    await prisma.attemptDeadlineJob.upsert({
      where: { attemptId: attempt.id },
      update: {
        runAt: attempt.expiresAt,
        ...(attempt.status === 'IN_PROGRESS' ? { status: 'PENDING', completedAt: null } : {}),
      },
      create: { attemptId: attempt.id, runAt: attempt.expiresAt },
    });
  }
  const answerRecords = await prisma.examAnswer.findMany({ where: { attemptId: attempt.id } });

  const expiredAttempt = await finalizeIfExpired(attempt);
  if (expiredAttempt) throw new ApiError(409, 'This exam attempt has expired and was submitted automatically');

  res.status(201).json({
    attemptId: attempt.id,
    status: attempt.status,
    answers: answerRecords.length > 0 ? answerRecordsToMap(answerRecords) : attempt.answers,
    violations: attempt.violations,
    questions: toCandidateQuestions(attempt.questionSnapshot),
    serverNow: new Date().toISOString(),
    startedAt: attempt.startedAt.toISOString(),
    expiresAt: attempt.expiresAt.toISOString(),
    durationSeconds: Math.max(0, Math.ceil((attempt.expiresAt.getTime() - Date.now()) / 1000)),
    maxViolations: attempt.maxViolations,
    calculatorEnabled: attempt.calculatorEnabled,
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

  const frozenAttempt = await ensureQuestionSnapshot(attempt);
  const question = frozenAttempt.questionSnapshot.find((item) => item.id === questionId);
  if (!question) throw new ApiError(400, 'Question is not part of this attempt');
  if (!question.options.includes(answer)) throw new ApiError(400, 'Answer is not a valid option for this question');

  // Lock the attempt row while saving. The expiry worker must acquire the same
  // row before FINALIZING it, so an answer either commits before the deadline
  // snapshot is scored or is rejected—never half-saved during finalization.
  const saved = await prisma.$transaction(async (tx) => {
    const activeRows = await tx.$queryRaw`
      SELECT "id" FROM "ExamAttempt"
      WHERE "id" = ${attempt.id}
        AND "status" = 'IN_PROGRESS'
        AND "expiresAt" > NOW()
      FOR UPDATE
    `;
    if (activeRows.length === 0) return null;
    return tx.examAnswer.upsert({
      where: { attemptId_questionId: { attemptId: attempt.id, questionId } },
      update: {
        selectedAnswer: answer,
        revision: { increment: 1 },
        syncStatus: 'SYNCED',
      },
      create: {
        attemptId: attempt.id,
        questionId,
        selectedAnswer: answer,
        revision: 1,
        syncStatus: 'SYNCED',
      },
    });
  });
  if (!saved) {
    await finalizeIfExpired(attempt);
    throw new ApiError(409, 'The exam time has ended and the attempt was submitted automatically');
  }
  res.json({
    questionId: saved.questionId,
    answer: saved.selectedAnswer,
    revision: saved.revision,
    syncStatus: saved.syncStatus,
    savedAt: saved.savedAt,
  });
});

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

  const endedAt = new Date();
  const recorded = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ExamAttempt" WHERE "id" = ${attempt.id} FOR UPDATE`;
    const locked = await tx.examAttempt.findUnique({ where: { id: attempt.id } });
    if (!locked || locked.status !== 'IN_PROGRESS') return { attempt: locked, duplicate: false, shouldTerminate: false };
    const existing = Array.isArray(locked.violations) ? locked.violations : [];
    if (clientViolationId && existing.some((violation) => violation.clientViolationId === clientViolationId)) {
      return { attempt: locked, duplicate: true, shouldTerminate: false };
    }
    const violations = [...existing, {
      id: crypto.randomUUID(),
      clientViolationId,
      timestamp: endedAt.getTime(),
      type,
      description: String(description || type),
    }];
    const shouldTerminate = violations.length >= locked.maxViolations;
    const updated = await tx.examAttempt.update({
      where: { id: locked.id },
      data: { violations, ...(shouldTerminate ? { status: 'FINALIZING', endedAt } : {}) },
    });
    return { attempt: updated, duplicate: false, shouldTerminate };
  });

  if (!recorded.attempt) throw new ApiError(404, 'No attempt found for this exam');
  if (recorded.shouldTerminate) {
    const finalized = await completeFinalizingAttempt(recorded.attempt.id, 'TERMINATED', endedAt);
    return res.json({ violations: finalized.violations, status: finalized.status, score: finalized.score });
  }
  res.json({ violations: recorded.attempt.violations, status: recorded.attempt.status });
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
      const confirmedAt = new Date().toISOString();
      return res.json({ attemptId: finished.id, status: finished.status, score: finished.score, submittedAt: finished.endedAt?.toISOString() || confirmedAt, serverConfirmedAt: confirmedAt });
    }
    throw new ApiError(404, 'No active attempt found for this exam');
  }

  const finalStatus = status === 'TERMINATED' ? 'TERMINATED' : 'COMPLETED';
  const updated = await finalizeAttempt(attempt, finalStatus);

  const serverConfirmedAt = new Date().toISOString();
  res.json({ attemptId: updated.id, status: updated.status, score: updated.score, submittedAt: updated.endedAt?.toISOString() || serverConfirmedAt, serverConfirmedAt });
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
      examTitle: a.exam.title,
      examSubject: a.exam.subject,
      totalMarks: a.exam.totalMarks,
      isTestExam: a.exam.isTestExam,
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
  const [attempt, latestFinished, totalQuestions] = await Promise.all([
    prisma.examAttempt.findFirst({
      where: { examId: id, userId: req.user.id, status: 'IN_PROGRESS' },
      include: { answerRecords: { select: { questionId: true } } },
    }),
    prisma.examAttempt.findFirst({
      where: { examId: id, userId: req.user.id, status: { in: ['COMPLETED', 'TERMINATED'] } },
      orderBy: { endedAt: 'desc' },
    }),
    prisma.question.count({ where: { examId: id } }),
  ]);
  const finalized = attempt ? await finalizeIfExpired(attempt) : null;
  const activeAttempt = finalized ? null : attempt;
  const receiptAttempt = finalized || (!activeAttempt ? latestFinished : null);
  const serverNow = new Date().toISOString();
  res.json({
    hasActiveAttempt: !!activeAttempt,
    status: receiptAttempt?.status || activeAttempt?.status || null,
    serverNow,
    attemptId: receiptAttempt?.id || activeAttempt?.id || null,
    submittedAt: receiptAttempt?.endedAt?.toISOString() || null,
    serverConfirmedAt: receiptAttempt ? serverNow : null,
    expiresAt: activeAttempt?.expiresAt?.toISOString() || null,
    answeredCount: activeAttempt
      ? (activeAttempt.answerRecords.length || Object.keys(activeAttempt.answers || {}).length)
      : 0,
    totalQuestions,
  });
});

const myScorecard = asyncHandler(async (req, res) => {
  const attempt = await prisma.examAttempt.findFirst({
    where: { examId: req.params.id, userId: req.user.id, status: { in: ['COMPLETED', 'TERMINATED'] } },
    include: { exam: true, user: { include: { studentProfile: true } } },
    orderBy: { endedAt: 'desc' },
  });
  if (!attempt) throw new ApiError(404, 'Completed attempt not found');
  const published = await prisma.result.findFirst({ where: { examId: attempt.examId, status: 'Published' } });
  if (!published) throw new ApiError(403, 'Results have not been published yet');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="scorecard-${attempt.examId}.pdf"`);
  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);
  doc.fontSize(20).text('HexTorq Examination Scorecard', { align: 'center' }).moveDown();
  doc.fontSize(12).text(`Student: ${attempt.user.name}`);
  doc.text(`Register Number: ${attempt.user.studentProfile?.registerNumber || '-'}`);
  doc.text(`Exam: ${attempt.exam.title}`);
  doc.text(`Score: ${attempt.score} / ${attempt.exam.totalMarks}`);
  doc.text(`Result: ${attempt.score >= attempt.exam.passingMarks ? 'PASS' : 'FAIL'}`);
  doc.text(`Status: ${attempt.status}`);
  doc.end();
});

module.exports = {
  getExamForTaking, startAttempt, saveAnswer, recordViolation, submitAttempt, myHistory, myAttemptStatus,
  myScorecard, processDeadlineJobs,
};
