const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { assertOwnedClass } = require('./classes.controller');
const { ensureClassGroupConversation, postSystemMessage } = require('./messaging.controller');
const { DateTime } = require('luxon');

const toPublic = (m) => {
  const start = DateTime.fromJSDate(m.startAt, { zone: 'utc' }).setZone(m.timezone);
  const end = DateTime.fromJSDate(m.endAt, { zone: 'utc' }).setZone(m.timezone);
  return ({
  id: m.id,
  examId: m.examId,
  examTitle: m.exam?.title,
  examSubject: m.exam?.subject,
  examDuration: m.exam?.duration,
  examTotalMarks: m.exam?.totalMarks,
  examQuestionCount: m.exam?._count?.questions ?? 0,
  examMaxViolations: m.exam?.maxViolations,
  examCalculatorEnabled: m.exam?.calculatorEnabled,
  examIsTest: m.exam?.isTestExam,
  classId: m.classId,
  className: m.class?.name,
  date: start.toISODate(),
  startTime: start.toFormat('HH:mm'),
  endTime: end.toFormat('HH:mm'),
  timezone: m.timezone,
  startAt: m.startAt.toISOString(),
  endAt: m.endAt.toISOString(),
  hall: m.hall,
  status: m.status,
  graceMinutes: m.graceMinutes,
  createdAt: m.createdAt,
  });
};

const buildWindow = (date, startTime, endTime, timezone) => {
  const start = DateTime.fromISO(`${date}T${startTime}`, { zone: timezone });
  const end = DateTime.fromISO(`${date}T${endTime}`, { zone: timezone });
  if (!start.isValid || !end.isValid) throw new ApiError(400, 'Invalid exam date, time, or timezone');
  if (end <= start) throw new ApiError(400, 'Exam end time must be after its start time');
  return { startAt: start.toUTC().toJSDate(), endAt: end.toUTC().toJSDate() };
};

const assertNoOverlap = async ({ classId, startAt, endAt, excludeId, confirmed }) => {
  const conflicts = await prisma.examMapping.findMany({
    where: {
      classId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      status: { not: 'Cancelled' },
    },
    include: { exam: { select: { title: true } } },
  });
  if (conflicts.length > 0 && !confirmed) {
    throw new ApiError(409, 'This schedule overlaps another exam for the same class. Confirm to schedule it anyway.', 'SCHEDULE_OVERLAP', conflicts.map((conflict) => ({
      id: conflict.id,
      examTitle: conflict.exam.title,
      startAt: conflict.startAt,
      endAt: conflict.endAt,
    })));
  }
};

const assertOwnedExam = async (examId, organizationId) => {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { organization: true } });
  if (!exam || (organizationId && exam.organizationId !== organizationId)) {
    throw new ApiError(404, 'Exam not found');
  }
  return exam;
};

// GET /api/exam-mappings?examId=&classId=
const list = asyncHandler(async (req, res) => {
  const { examId, classId } = req.query;
  const where = {};
  if (req.user.role === 'ADMIN' && req.user.organizationId) {
    where.exam = { organizationId: req.user.organizationId };
  }
  if (examId) {
    await assertOwnedExam(examId, req.user.organizationId);
    where.examId = examId;
  }
  if (classId) {
    await assertOwnedClass(classId, req.user.organizationId);
    where.classId = classId;
  }

  const mappings = await prisma.examMapping.findMany({
    where,
    include: { exam: { include: { _count: { select: { questions: true } } } }, class: true },
    orderBy: { startAt: 'asc' },
  });
  res.json(mappings.map(toPublic));
});

// POST /api/exam-mappings { examId, classId, date, startTime, endTime, hall, status }
const create = asyncHandler(async (req, res) => {
  const { examId, classId, date, startTime, endTime, hall, status, graceMinutes = 0, confirmOverlap = false } = req.body;
  if (!examId || !classId || !date || !startTime || !endTime) {
    throw new ApiError(400, 'examId, classId, date, startTime, and endTime are required');
  }
  const exam = await assertOwnedExam(examId, req.user.organizationId);
  if (exam.status !== 'Published') {
    throw new ApiError(400, 'Publish the exam before mapping it to students');
  }
  await assertOwnedClass(classId, req.user.organizationId);
  const timezone = exam.organization?.timezone || 'Asia/Kolkata';
  const { startAt, endAt } = buildWindow(date, startTime, endTime, timezone);
  const existing = await prisma.examMapping.findUnique({ where: { examId_classId: { examId, classId } } });
  await assertNoOverlap({ classId, startAt, endAt, excludeId: existing?.id, confirmed: confirmOverlap });

  const mapping = await prisma.$transaction(async (tx) => {
    const saved = await tx.examMapping.upsert({
      where: { examId_classId: { examId, classId } },
      update: { date: startAt, startTime, endTime, timezone, startAt, endAt, graceMinutes: Math.max(0, Number(graceMinutes) || 0), hall: hall || 'Virtual', status: status || 'Scheduled' },
      create: { examId, classId, date: startAt, startTime, endTime, timezone, startAt, endAt, graceMinutes: Math.max(0, Number(graceMinutes) || 0), hall: hall || 'Virtual', status: status || 'Scheduled' },
      include: { exam: { include: { _count: { select: { questions: true } } } }, class: true },
    });
    const conversationId = await ensureClassGroupConversation(classId, req.user.id, tx);
    await postSystemMessage(conversationId, req.user.id, `Exam scheduled: "${exam.title}" on ${date} from ${startTime} to ${endTime} (${timezone})${saved.hall ? ` at ${saved.hall}` : ''}.`, tx);
    return saved;
  });

  res.status(201).json(toPublic(mapping));
});

const assertOwnedMapping = async (id, organizationId) => {
  const mapping = await prisma.examMapping.findUnique({ where: { id }, include: { exam: true } });
  if (!mapping || (organizationId && mapping.exam.organizationId !== organizationId)) {
    throw new ApiError(404, 'Exam mapping not found');
  }
  return mapping;
};

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { date, startTime, endTime, hall, status, graceMinutes, confirmOverlap = false } = req.body;
  const existingMapping = await assertOwnedMapping(id, req.user.organizationId);
  const existingStart = DateTime.fromJSDate(existingMapping.startAt, { zone: 'utc' }).setZone(existingMapping.timezone);
  const nextDate = date || existingStart.toISODate();
  const nextStartTime = startTime || existingStart.toFormat('HH:mm');
  const nextEndTime = endTime || DateTime.fromJSDate(existingMapping.endAt, { zone: 'utc' }).setZone(existingMapping.timezone).toFormat('HH:mm');
  const window = buildWindow(nextDate, nextStartTime, nextEndTime, existingMapping.timezone);
  await assertNoOverlap({ classId: existingMapping.classId, ...window, excludeId: id, confirmed: confirmOverlap });

  const mapping = await prisma.$transaction(async (tx) => {
    const saved = await tx.examMapping.update({
      where: { id },
      data: { date: window.startAt, startTime, endTime, startAt: window.startAt, endAt: window.endAt, graceMinutes: graceMinutes !== undefined ? Math.max(0, Number(graceMinutes) || 0) : undefined, hall, status },
      include: { exam: { include: { _count: { select: { questions: true } } } }, class: true },
    });
    const conversationId = await ensureClassGroupConversation(saved.classId, req.user.id, tx);
    await postSystemMessage(conversationId, req.user.id, `Exam schedule updated: "${existingMapping.exam.title}" is on ${nextDate} from ${nextStartTime} to ${nextEndTime} (${saved.timezone})${saved.hall ? ` at ${saved.hall}` : ''}.`, tx);
    return saved;
  });

  res.json(toPublic(mapping));
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertOwnedMapping(id, req.user.organizationId);
  await prisma.examMapping.delete({ where: { id } });
  res.json({ success: true });
});

// GET /api/exam-mappings/mine — for the logged-in STUDENT, mappings for their own class
const mine = asyncHandler(async (req, res) => {
  const profile = await prisma.studentProfile.findUnique({ where: { userId: req.user.id } });
  if (!profile) return res.json([]);

  const mappings = await prisma.examMapping.findMany({
    where: { classId: profile.classId, exam: { status: 'Published' } },
    include: { exam: { include: { _count: { select: { questions: true } } } }, class: true },
    orderBy: { startAt: 'asc' },
  });
  res.json(mappings.map(toPublic));
});

module.exports = { list, create, update, remove, mine };
