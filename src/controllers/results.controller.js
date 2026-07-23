const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const PDFDocument = require('pdfkit');
const { answersMatch, scoreAttemptSnapshot } = require('../utils/scoring');
const { ensureClassGroupConversation, postSystemMessage } = require('./messaging.controller');

const scopeWhere = (req) => {
  if (req.user.role === 'ADMIN' && req.user.organizationId) {
    return { exam: { organizationId: req.user.organizationId } };
  }
  return {};
};

const publicationState = (exam, now = new Date()) => {
  if (exam?.isTestExam) return { canPublish: false, publishBlockedReason: 'Test exams do not produce official results' };
  if (!exam?.mappings?.length) return { canPublish: false, publishBlockedReason: 'The exam has not been scheduled' };
  const latestEnd = new Date(Math.max(...exam.mappings.map((mapping) => mapping.endAt.getTime() + mapping.graceMinutes * 60_000)));
  if (now <= latestEnd) return { canPublish: false, publishBlockedReason: `Results can be published after ${latestEnd.toISOString()}` };
  if (exam._count?.attempts > 0) return { canPublish: false, publishBlockedReason: 'Students still have active attempts' };
  return { canPublish: true, publishBlockedReason: null };
};

const attemptStats = (attempts, totalMarks, passingMarks) => {
  const completed = attempts.filter((attempt) => ['COMPLETED', 'TERMINATED'].includes(attempt.status));
  const passed = completed.filter((attempt) => attempt.status === 'COMPLETED' && attempt.score >= passingMarks).length;
  const averageScorePercent = completed.length && totalMarks
    ? Math.round(completed.reduce((sum, attempt) => sum + (attempt.score / totalMarks) * 100, 0) / completed.length)
    : 0;
  return {
    evaluated: completed.length,
    completed: completed.filter((attempt) => attempt.status === 'COMPLETED').length,
    terminated: completed.filter((attempt) => attempt.status === 'TERMINATED').length,
    active: attempts.filter((attempt) => attempt.status === 'IN_PROGRESS').length,
    averageScorePercent,
    passRate: completed.length ? Math.round((passed / completed.length) * 1000) / 10 : 0,
  };
};

const mappingSummaries = (exam) => (exam?.mappings || []).map((mapping) => {
  const attempts = (exam.attempts || []).filter((attempt) => attempt.user?.studentProfile?.classId === mapping.classId);
  return {
    mappingId: mapping.id,
    classId: mapping.classId,
    className: mapping.class?.name || 'Class',
    date: mapping.date?.toISOString?.() || mapping.date,
    startAt: mapping.startAt?.toISOString?.() || mapping.startAt,
    endAt: mapping.endAt?.toISOString?.() || mapping.endAt,
    startTime: mapping.startTime,
    endTime: mapping.endTime,
    assignedStudents: mapping.class?._count?.students || 0,
    ...attemptStats(attempts, exam.totalMarks, exam.passingMarks),
  };
});

const toPublic = (r) => ({
  id: r.id,
  examId: r.examId,
  examName: r.exam?.title,
  isTestExam: !!r.exam?.isTestExam,
  totalStudents: r.totalStudents,
  publishedDate: r.publishedDate ? r.publishedDate.toISOString().split('T')[0] : '',
  status: r.status,
  mappingSummaries: mappingSummaries(r.exam),
  ...publicationState(r.exam),
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
    where: { status: { in: ['COMPLETED', 'TERMINATED'] }, exam: { ...examOrgFilter, isTestExam: false } },
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
    where: { ...scopeWhere(req), exam: { ...(scopeWhere(req).exam || {}), isTestExam: false } },
    include: {
      exam: {
        include: {
          mappings: { include: { class: { include: { _count: { select: { students: true } } } } }, orderBy: { startAt: 'asc' } },
          attempts: { include: { user: { include: { studentProfile: true } } } },
          _count: { select: { attempts: { where: { status: 'IN_PROGRESS' } } } },
        },
      },
    },
    orderBy: { id: 'desc' },
  });
  res.json(results.map(toPublic));
});

const publish = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const ownedResult = await prisma.result.findFirst({
    where: { id, ...scopeWhere(req) },
    include: { exam: { include: { mappings: true, _count: { select: { attempts: { where: { status: 'IN_PROGRESS' } } } } } } },
  });
  if (!ownedResult) {
    throw new ApiError(404, 'Result not found');
  }
  const publication = publicationState(ownedResult.exam);
  if (!publication.canPublish) throw new ApiError(409, publication.publishBlockedReason);
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

const buildLiveMonitorPayload = async (user) => {
  const now = new Date();
  const examOrgFilter = user.role === 'ADMIN' && user.organizationId
    ? { organizationId: user.organizationId }
    : {};

  const rawMappings = await prisma.examMapping.findMany({
    where: {
      status: { not: 'Cancelled' },
      startAt: { lte: now },
      exam: { ...examOrgFilter, status: 'Published' },
    },
    include: {
      exam: { include: { _count: { select: { questions: true } } } },
      class: {
        include: {
          students: {
            include: { user: true },
            orderBy: { registerNumber: 'asc' },
          },
        },
      },
    },
    orderBy: { startAt: 'asc' },
  });

  const activeMappings = rawMappings.filter((mapping) => (
    now <= new Date(mapping.endAt.getTime() + Math.max(0, mapping.graceMinutes || 0) * 60_000)
  ));

  const examIds = [...new Set(activeMappings.map((mapping) => mapping.examId))];
  const studentUserIds = [...new Set(activeMappings.flatMap((mapping) => mapping.class.students.map((student) => student.userId)))];
  const attempts = examIds.length && studentUserIds.length
    ? await prisma.examAttempt.findMany({
        where: { examId: { in: examIds }, userId: { in: studentUserIds } },
        include: { answerRecords: { select: { questionId: true } } },
        orderBy: { startedAt: 'desc' },
      })
    : [];

  const latestAttemptByExamStudent = new Map();
  attempts.forEach((attempt) => {
    const key = `${attempt.examId}:${attempt.userId}`;
    if (!latestAttemptByExamStudent.has(key)) latestAttemptByExamStudent.set(key, attempt);
  });

  const exams = new Map();
  activeMappings.forEach((mapping) => {
    const examEntry = exams.get(mapping.examId) || {
      examId: mapping.examId,
      title: mapping.exam.title,
      subject: mapping.exam.subject,
      duration: mapping.exam.duration,
      totalMarks: mapping.exam.totalMarks,
      questionCount: mapping.exam._count.questions,
      totalMappedStudents: 0,
      activeStudents: 0,
      completedStudents: 0,
      terminatedStudents: 0,
      violationCount: 0,
      mappings: [],
    };

    const students = mapping.class.students.map((profile) => {
      const attempt = latestAttemptByExamStudent.get(`${mapping.examId}:${profile.userId}`);
      const status = attempt?.status || 'NOT_STARTED';
      const violations = Array.isArray(attempt?.violations) ? attempt.violations : [];
      const answeredCount = attempt
        ? (attempt.answerRecords.length || Object.keys(attempt.answers || {}).length)
        : 0;
      return {
        userId: profile.userId,
        attemptId: attempt?.id || null,
        registerNumber: profile.registerNumber,
        name: profile.user.name,
        status,
        answeredCount,
        totalQuestions: mapping.exam._count.questions,
        violationsCount: violations.length,
        violations,
        score: attempt?.score ?? null,
        startedAt: attempt?.startedAt?.toISOString?.() || null,
        endedAt: attempt?.endedAt?.toISOString?.() || null,
        expiresAt: attempt?.expiresAt?.toISOString?.() || null,
      };
    });

    const counts = students.reduce((out, student) => {
      if (student.status === 'IN_PROGRESS') out.active += 1;
      else if (student.status === 'COMPLETED') out.completed += 1;
      else if (student.status === 'TERMINATED') out.terminated += 1;
      else out.notStarted += 1;
      out.violations += student.violationsCount;
      return out;
    }, { active: 0, completed: 0, terminated: 0, notStarted: 0, violations: 0 });

    examEntry.totalMappedStudents += students.length;
    examEntry.activeStudents += counts.active;
    examEntry.completedStudents += counts.completed;
    examEntry.terminatedStudents += counts.terminated;
    examEntry.violationCount += counts.violations;
    examEntry.mappings.push({
      mappingId: mapping.id,
      classId: mapping.classId,
      className: mapping.class.name,
      startAt: mapping.startAt.toISOString(),
      endAt: mapping.endAt.toISOString(),
      startTime: mapping.startTime,
      endTime: mapping.endTime,
      graceMinutes: mapping.graceMinutes,
      totalStudents: students.length,
      activeStudents: counts.active,
      completedStudents: counts.completed,
      terminatedStudents: counts.terminated,
      notStartedStudents: counts.notStarted,
      violationCount: counts.violations,
      students,
    });
    exams.set(mapping.examId, examEntry);
  });

  return { serverNow: now.toISOString(), exams: [...exams.values()] };
};

const liveMonitor = asyncHandler(async (req, res) => {
  res.json(await buildLiveMonitorPayload(req.user));
});

const buildLiveLoginsPayload = async (user) => {
  const now = new Date();
  const classWhere = user.role === 'ADMIN' && user.organizationId
    ? { department: { school: { batch: { organizationId: user.organizationId } } } }
    : {};

  const classes = await prisma.class.findMany({
    where: classWhere,
    include: {
      department: { include: { school: { include: { batch: true } } } },
      students: {
        include: {
          user: {
            include: {
              refreshTokens: {
                where: { revokedAt: null, expiresAt: { gt: now } },
                select: { id: true, createdAt: true, expiresAt: true },
                orderBy: { createdAt: 'desc' },
              },
            },
          },
        },
        orderBy: { registerNumber: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  });

  const classrooms = classes.map((cls) => {
    const students = cls.students.map((profile) => {
      const activeSessions = profile.user.refreshTokens || [];
      return {
        userId: profile.userId,
        registerNumber: profile.registerNumber,
        name: profile.user.name,
        email: profile.user.email,
        status: profile.user.status,
        isLoggedIn: activeSessions.length > 0,
        activeSessionCount: activeSessions.length,
        lastLoginAt: profile.user.lastLoginAt?.toISOString?.() || null,
        currentSessionStartedAt: activeSessions[0]?.createdAt?.toISOString?.() || null,
        sessionExpiresAt: activeSessions[0]?.expiresAt?.toISOString?.() || null,
      };
    });
    return {
      classId: cls.id,
      className: cls.name,
      departmentName: cls.department.name,
      schoolName: cls.department.school.name,
      batchName: cls.department.school.batch.name,
      totalStudents: students.length,
      loggedInStudents: students.filter((student) => student.isLoggedIn).length,
      offlineStudents: students.filter((student) => !student.isLoggedIn).length,
      students,
    };
  }).filter((classroom) => classroom.totalStudents > 0);

  return {
    serverNow: now.toISOString(),
    totalClasses: classrooms.length,
    totalStudents: classrooms.reduce((sum, classroom) => sum + classroom.totalStudents, 0),
    loggedInStudents: classrooms.reduce((sum, classroom) => sum + classroom.loggedInStudents, 0),
    classrooms,
  };
};

const liveLogins = asyncHandler(async (req, res) => {
  res.json(await buildLiveLoginsPayload(req.user));
});

const listAttempts = asyncHandler(async (req, res) => {
  const attempts = await prisma.examAttempt.findMany({
    where: {
      ...attemptScope(req),
      ...(req.query.examId ? { examId: req.query.examId } : {}),
      ...(req.query.classId ? { user: { studentProfile: { classId: String(req.query.classId) } } } : {}),
    },
    include: { user: { include: { studentProfile: { include: { class: true } } } }, exam: true },
    orderBy: { startedAt: 'desc' },
  });
  res.json(attempts.map((attempt) => ({
    id: attempt.id,
    examId: attempt.examId,
    examTitle: attempt.exam.title,
    studentName: attempt.user.name,
    registerNumber: attempt.user.studentProfile?.registerNumber,
    classId: attempt.user.studentProfile?.classId,
    className: attempt.user.studentProfile?.class?.name,
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
const csvFilename = (value) => String(value || 'export').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'export';

const buildMappingResultRows = async (mapping) => {
  const students = mapping.class.students || [];
  const attempts = await prisma.examAttempt.findMany({
    where: {
      examId: mapping.examId,
      userId: { in: students.map((student) => student.userId) },
    },
    include: { answerRecords: { select: { questionId: true } } },
    orderBy: [{ userId: 'asc' }, { attemptNumber: 'desc' }, { startedAt: 'desc' }],
  });
  const latestAttemptByUser = new Map();
  attempts.forEach((attempt) => {
    if (!latestAttemptByUser.has(attempt.userId)) latestAttemptByUser.set(attempt.userId, attempt);
  });

  const totalQuestions = mapping.exam._count?.questions || 0;
  return students.map((profile) => {
    const attempt = latestAttemptByUser.get(profile.userId);
    const violations = Array.isArray(attempt?.violations) ? attempt.violations : [];
    const answeredCount = attempt
      ? (attempt.answerRecords?.length || Object.keys(attempt.answers || {}).length)
      : 0;
    const scorePercent = attempt && mapping.exam.totalMarks
      ? Math.round((Number(attempt.score || 0) / mapping.exam.totalMarks) * 10000) / 100
      : '';
    const passed = attempt?.status === 'COMPLETED' && Number(attempt.score || 0) >= mapping.exam.passingMarks;
    return [
      mapping.exam.title,
      mapping.exam.subject,
      mapping.examId,
      mapping.id,
      mapping.date?.toISOString?.().split('T')[0] || '',
      mapping.startTime,
      mapping.endTime,
      mapping.startAt?.toISOString?.() || '',
      mapping.endAt?.toISOString?.() || '',
      mapping.timezone,
      mapping.hall,
      mapping.status,
      mapping.graceMinutes,
      mapping.class.department.school.batch.name,
      mapping.class.department.school.name,
      mapping.class.department.name,
      mapping.class.name,
      profile.registerNumber,
      profile.user.name,
      profile.user.email,
      profile.user.phone || '',
      profile.user.status,
      profile.extraTimeMinutes,
      profile.accessibilityNotes || '',
      attempt?.id || '',
      attempt?.attemptNumber || '',
      attempt?.status || 'NOT_STARTED',
      attempt?.startedAt?.toISOString?.() || '',
      attempt?.endedAt?.toISOString?.() || '',
      attempt?.expiresAt?.toISOString?.() || '',
      attempt?.score ?? '',
      mapping.exam.totalMarks,
      scorePercent,
      attempt ? (passed ? 'PASS' : 'FAIL') : 'NOT_ATTEMPTED',
      answeredCount,
      totalQuestions,
      violations.length,
      attempt?.manuallyEvaluated ? 'Yes' : 'No',
      attempt?.evaluationReason || '',
    ];
  });
};

const detailedResultHeaders = [
  'Exam Name',
  'Subject',
  'Exam ID',
  'Mapping ID',
  'Mapping Date',
  'Start Time',
  'End Time',
  'Start At',
  'End At',
  'Timezone',
  'Hall',
  'Mapping Status',
  'Grace Minutes',
  'Batch',
  'School',
  'Department',
  'Class',
  'Register Number',
  'Student Name',
  'Email',
  'Phone',
  'Student Status',
  'Extra Time Minutes',
  'Accessibility Notes',
  'Attempt ID',
  'Attempt Number',
  'Attempt Status',
  'Started At',
  'Ended At',
  'Expires At',
  'Score',
  'Total Marks',
  'Score Percent',
  'Result',
  'Answered Questions',
  'Total Questions',
  'Violations Count',
  'Manually Evaluated',
  'Evaluation Reason',
];

const exportCsv = asyncHandler(async (req, res) => {
  const scoped = scopeWhere(req);
  const result = await prisma.result.findFirst({ where: { id: req.params.id, ...scoped, exam: { ...(scoped.exam || {}), isTestExam: false } }, include: { exam: true } });
  if (!result) throw new ApiError(404, 'Result not found');
  const attempts = await prisma.examAttempt.findMany({ where: { examId: result.examId, status: { in: ['COMPLETED', 'TERMINATED'] } }, include: { user: { include: { studentProfile: true } } } });
  const rows = [['Register Number', 'Student', 'Email', 'Score', 'Status'], ...attempts.map((a) => [a.user.studentProfile?.registerNumber, a.user.name, a.user.email, a.score, a.status])];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${result.exam.title.replace(/[^a-z0-9]+/gi, '-')}-results.csv"`);
  res.send(rows.map((row) => row.map(csvEscape).join(',')).join('\n'));
});

const exportMappingCsv = asyncHandler(async (req, res) => {
  const examOrgFilter = req.user.role === 'ADMIN' && req.user.organizationId
    ? { organizationId: req.user.organizationId }
    : {};
  const mapping = await prisma.examMapping.findFirst({
    where: { id: req.params.mappingId, exam: { ...examOrgFilter, isTestExam: false } },
    include: {
      exam: { include: { _count: { select: { questions: true } } } },
      class: {
        include: {
          department: { include: { school: { include: { batch: true } } } },
          students: { include: { user: true }, orderBy: { registerNumber: 'asc' } },
        },
      },
    },
  });
  if (!mapping) throw new ApiError(404, 'Exam mapping not found');
  const rows = [detailedResultHeaders, ...(await buildMappingResultRows(mapping))];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(`${mapping.exam.title}-${mapping.class.name}`)}-mapping-results.csv"`);
  res.send(rows.map((row) => row.map(csvEscape).join(',')).join('\n'));
});

const exportDetailedCsv = asyncHandler(async (req, res) => {
  const scoped = scopeWhere(req);
  const result = await prisma.result.findFirst({
    where: { id: req.params.id, ...scoped, exam: { ...(scoped.exam || {}), isTestExam: false } },
    include: {
      exam: {
        include: {
          mappings: {
            include: {
              exam: { include: { _count: { select: { questions: true } } } },
              class: {
                include: {
                  department: { include: { school: { include: { batch: true } } } },
                  students: { include: { user: true }, orderBy: { registerNumber: 'asc' } },
                },
              },
            },
            orderBy: { startAt: 'asc' },
          },
        },
      },
    },
  });
  if (!result) throw new ApiError(404, 'Result not found');
  const rows = [detailedResultHeaders];
  for (const mapping of result.exam.mappings) rows.push(...(await buildMappingResultRows(mapping)));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(result.exam.title)}-detailed-results.csv"`);
  res.send(rows.map((row) => row.map(csvEscape).join(',')).join('\n'));
});

const exportAllCsv = asyncHandler(async (req, res) => {
  const scoped = attemptScope(req);
  const attempts = await prisma.examAttempt.findMany({
    where: { ...scoped, exam: { ...(scoped.exam || {}), isTestExam: false }, status: { in: ['COMPLETED', 'TERMINATED'] } },
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
  if (!['COMPLETED', 'TERMINATED'].includes(attempt.status)) throw new ApiError(409, 'Only finalized attempts can be exported');
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
  if (!['COMPLETED', 'TERMINATED'].includes(attempt.status)) throw new ApiError(409, 'Only finalized attempts can be exported');
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
    doc.moveDown(0.25).fillColor(answersMatch(selected, question.correctAnswer) ? '#047857' : '#b91c1c').text(`Student answer: ${selected}`);
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
    where: { status: { in: ['COMPLETED', 'TERMINATED'] }, exam: { ...examOrgFilter, isTestExam: false } },
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

module.exports = { list, publish, analytics, buildLiveMonitorPayload, buildLiveLoginsPayload, liveMonitor, liveLogins, listAttempts, attemptDetail, manualEvaluate, regrade, extendAttempt, resetAttempt, exportCsv, exportMappingCsv, exportDetailedCsv, exportAllCsv, attemptPdf, attemptResponsePdf };
