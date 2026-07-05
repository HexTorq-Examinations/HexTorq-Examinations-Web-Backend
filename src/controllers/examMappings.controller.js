const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { assertOwnedClass } = require('./classes.controller');
const { ensureClassGroupConversation, postSystemMessage } = require('./messaging.controller');

const toPublic = (m) => ({
  id: m.id,
  examId: m.examId,
  examTitle: m.exam?.title,
  classId: m.classId,
  className: m.class?.name,
  date: m.date.toISOString().split('T')[0],
  startTime: m.startTime,
  endTime: m.endTime,
  hall: m.hall,
  status: m.status,
  createdAt: m.createdAt,
});

const assertOwnedExam = async (examId, organizationId) => {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam || (organizationId && exam.organizationId !== organizationId)) {
    throw new ApiError(404, 'Exam not found');
  }
  return exam;
};

// GET /api/exam-mappings?examId=&classId=
const list = asyncHandler(async (req, res) => {
  const { examId, classId } = req.query;
  const where = {};
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
    include: { exam: true, class: true },
    orderBy: { date: 'asc' },
  });
  res.json(mappings.map(toPublic));
});

// POST /api/exam-mappings { examId, classId, date, startTime, endTime, hall, status }
const create = asyncHandler(async (req, res) => {
  const { examId, classId, date, startTime, endTime, hall, status } = req.body;
  if (!examId || !classId || !date || !startTime || !endTime) {
    throw new ApiError(400, 'examId, classId, date, startTime, and endTime are required');
  }
  const exam = await assertOwnedExam(examId, req.user.organizationId);
  await assertOwnedClass(classId, req.user.organizationId);

  const mapping = await prisma.examMapping.upsert({
    where: { examId_classId: { examId, classId } },
    update: { date: new Date(date), startTime, endTime, hall: hall || 'Virtual', status: status || 'Scheduled' },
    create: { examId, classId, date: new Date(date), startTime, endTime, hall: hall || 'Virtual', status: status || 'Scheduled' },
    include: { exam: true, class: true },
  });

  // Notify the class: get-or-create their announcement group and post the mapping.
  const conversationId = await ensureClassGroupConversation(classId, req.user.id);
  await postSystemMessage(
    conversationId,
    req.user.id,
    `New exam mapped: "${exam.title}" on ${mapping.date.toISOString().split('T')[0]} at ${startTime}.`
  );

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
  const { date, startTime, endTime, hall, status } = req.body;
  await assertOwnedMapping(id, req.user.organizationId);

  const mapping = await prisma.examMapping.update({
    where: { id },
    data: {
      date: date !== undefined ? new Date(date) : undefined,
      startTime,
      endTime,
      hall,
      status,
    },
    include: { exam: true, class: true },
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
    where: { classId: profile.classId },
    include: { exam: true, class: true },
    orderBy: { date: 'asc' },
  });
  res.json(mappings.map(toPublic));
});

module.exports = { list, create, update, remove, mine };
