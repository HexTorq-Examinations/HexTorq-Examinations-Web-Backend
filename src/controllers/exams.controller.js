const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const scopeWhere = (req) => {
  if (req.user.role === 'ADMIN' && req.user.organizationId) {
    return { organizationId: req.user.organizationId };
  }
  return {};
};

const toPublic = async (exam) => {
  const assigned = await prisma.user.count({
    where: {
      role: 'STUDENT',
      ...(exam.organizationId ? { organizationId: exam.organizationId } : {}),
    },
  });
  return {
    id: exam.id,
    title: exam.title,
    subject: exam.subject,
    description: exam.description || undefined,
    duration: exam.duration,
    totalMarks: exam.totalMarks,
    passingMarks: exam.passingMarks,
    startDate: exam.startDate.toISOString(),
    endDate: exam.endDate.toISOString(),
    status: exam.status,
    assigned,
    shuffleQuestions: exam.shuffleQuestions,
    shuffleOptions: exam.shuffleOptions,
    negativeMarking: exam.negativeMarking,
    questions: (exam.examQuestions || []).map((eq) => eq.questionId),
  };
};

const list = asyncHandler(async (req, res) => {
  const exams = await prisma.exam.findMany({
    where: scopeWhere(req),
    include: { examQuestions: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(await Promise.all(exams.map(toPublic)));
});

const buildData = (body, req) => ({
  title: body.title,
  subject: body.subject,
  description: body.description,
  duration: Number(body.duration),
  totalMarks: Number(body.totalMarks),
  passingMarks: Number(body.passingMarks),
  startDate: new Date(body.startDate),
  endDate: new Date(body.endDate),
  status: body.status || 'Draft',
  shuffleQuestions: !!body.shuffleQuestions,
  shuffleOptions: !!body.shuffleOptions,
  negativeMarking: !!body.negativeMarking,
  organizationId: req.user.organizationId || undefined,
});

const create = asyncHandler(async (req, res) => {
  const { title, subject, duration, totalMarks, passingMarks, startDate, endDate } = req.body;
  if (!title || !subject || !duration || !totalMarks || !passingMarks || !startDate || !endDate) {
    throw new ApiError(400, 'Missing required exam fields');
  }
  const exam = await prisma.exam.create({
    data: buildData(req.body, req),
    include: { examQuestions: true },
  });
  res.status(201).json(await toPublic(exam));
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, subject, description, duration, totalMarks, passingMarks, startDate, endDate, status, shuffleQuestions, shuffleOptions, negativeMarking, questions } = req.body;

  const exam = await prisma.exam.update({
    where: { id },
    data: {
      title,
      subject,
      description,
      duration: duration !== undefined ? Number(duration) : undefined,
      totalMarks: totalMarks !== undefined ? Number(totalMarks) : undefined,
      passingMarks: passingMarks !== undefined ? Number(passingMarks) : undefined,
      startDate: startDate !== undefined ? new Date(startDate) : undefined,
      endDate: endDate !== undefined ? new Date(endDate) : undefined,
      status,
      shuffleQuestions,
      shuffleOptions,
      negativeMarking,
    },
  });

  if (Array.isArray(questions)) {
    await prisma.examQuestion.deleteMany({ where: { examId: id } });
    if (questions.length > 0) {
      await prisma.examQuestion.createMany({
        data: questions.map((questionId) => ({ examId: id, questionId })),
        skipDuplicates: true,
      });
    }
  }

  const withQuestions = await prisma.exam.findUnique({ where: { id }, include: { examQuestions: true } });
  res.json(await toPublic(withQuestions));
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.exam.delete({ where: { id } });
  res.json({ success: true });
});

module.exports = { list, create, update, remove };
