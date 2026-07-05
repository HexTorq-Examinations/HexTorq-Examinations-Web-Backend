const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const scopeWhere = (req) => {
  if (req.user.role === 'ADMIN' && req.user.organizationId) {
    return { organizationId: req.user.organizationId };
  }
  return {};
};

// Exams are pure content now — title/subject/marks/rules only. Scheduling for
// real students (date/time/class) happens separately via ExamMapping.
const toPublic = (exam) => ({
  id: exam.id,
  title: exam.title,
  subject: exam.subject,
  description: exam.description || undefined,
  duration: exam.duration,
  totalMarks: exam.totalMarks,
  passingMarks: exam.passingMarks,
  status: exam.status,
  shuffleQuestions: exam.shuffleQuestions,
  shuffleOptions: exam.shuffleOptions,
  negativeMarking: exam.negativeMarking,
  questionCount: exam._count?.questions ?? undefined,
  mappingCount: exam._count?.mappings ?? undefined,
});

const list = asyncHandler(async (req, res) => {
  const exams = await prisma.exam.findMany({
    where: scopeWhere(req),
    include: { _count: { select: { questions: true, mappings: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(exams.map(toPublic));
});

const buildData = (body, req) => ({
  title: body.title,
  subject: body.subject,
  description: body.description,
  duration: Number(body.duration),
  totalMarks: Number(body.totalMarks),
  passingMarks: Number(body.passingMarks),
  status: body.status || 'Draft',
  shuffleQuestions: !!body.shuffleQuestions,
  shuffleOptions: !!body.shuffleOptions,
  negativeMarking: !!body.negativeMarking,
  organizationId: req.user.organizationId || undefined,
});

const create = asyncHandler(async (req, res) => {
  const { title, subject, duration, totalMarks, passingMarks } = req.body;
  if (!title || !subject || !duration || !totalMarks || !passingMarks) {
    throw new ApiError(400, 'Missing required exam fields');
  }
  const exam = await prisma.exam.create({
    data: buildData(req.body, req),
    include: { _count: { select: { questions: true, mappings: true } } },
  });
  res.status(201).json(toPublic(exam));
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, subject, description, duration, totalMarks, passingMarks, status, shuffleQuestions, shuffleOptions, negativeMarking } = req.body;

  const exam = await prisma.exam.update({
    where: { id },
    data: {
      title,
      subject,
      description,
      duration: duration !== undefined ? Number(duration) : undefined,
      totalMarks: totalMarks !== undefined ? Number(totalMarks) : undefined,
      passingMarks: passingMarks !== undefined ? Number(passingMarks) : undefined,
      status,
      shuffleQuestions,
      shuffleOptions,
      negativeMarking,
    },
    include: { _count: { select: { questions: true, mappings: true } } },
  });
  res.json(toPublic(exam));
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.exam.delete({ where: { id } });
  res.json({ success: true });
});

module.exports = { list, create, update, remove };
