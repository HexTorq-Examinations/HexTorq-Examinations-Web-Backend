const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const scopeWhere = (req) => {
  if (req.user.role === 'ADMIN' && req.user.organizationId) {
    return { organizationId: req.user.organizationId };
  }
  return {};
};

const toPublic = (s) => ({
  id: s.id,
  examId: s.examId,
  examName: s.exam?.title,
  batch: s.batch,
  department: s.department,
  date: s.date.toISOString().split('T')[0],
  startTime: s.startTime,
  endTime: s.endTime,
  hall: s.hall,
  status: s.status,
});

const list = asyncHandler(async (req, res) => {
  const schedules = await prisma.schedule.findMany({
    where: scopeWhere(req),
    include: { exam: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(schedules.map(toPublic));
});

const create = asyncHandler(async (req, res) => {
  const { examId, batch, department, date, startTime, endTime, hall, status } = req.body;
  if (!examId || !batch || !department || !date || !startTime || !endTime) {
    throw new ApiError(400, 'Missing required schedule fields');
  }
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw new ApiError(404, 'Exam not found');

  const schedule = await prisma.schedule.create({
    data: {
      examId,
      batch,
      department,
      date: new Date(date),
      startTime,
      endTime,
      hall: hall || 'Virtual',
      status: status || 'Scheduled',
      organizationId: req.user.organizationId || undefined,
    },
    include: { exam: true },
  });
  res.status(201).json(toPublic(schedule));
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { examId, batch, department, date, startTime, endTime, hall, status } = req.body;
  const schedule = await prisma.schedule.update({
    where: { id },
    data: {
      examId,
      batch,
      department,
      date: date !== undefined ? new Date(date) : undefined,
      startTime,
      endTime,
      hall,
      status,
    },
    include: { exam: true },
  });
  res.json(toPublic(schedule));
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.schedule.delete({ where: { id } });
  res.json({ success: true });
});

module.exports = { list, create, update, remove };
