const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const crypto = require('crypto');
const { repairQuestionOptions } = require('../utils/questionOptionRepair');

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
  maxViolations: exam.maxViolations,
  calculatorEnabled: exam.calculatorEnabled,
  isTestExam: exam.isTestExam,
  questionCount: exam._count?.questions ?? undefined,
  mappingCount: exam._count?.mappings ?? undefined,
  version: exam.version,
  versionGroupId: exam.versionGroupId || exam.id,
  parentExamId: exam.parentExamId || undefined,
  publishedAt: exam.publishedAt || undefined,
  closedAt: exam.closedAt || undefined,
});

const toPublicQuestion = (question) => ({
  ...question,
  options: repairQuestionOptions(question.options).options,
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
  // Publishing is a separate validated action; creation always starts in Draft.
  status: 'Draft',
  version: 1,
  versionGroupId: crypto.randomUUID(),
  shuffleQuestions: !!body.shuffleQuestions,
  shuffleOptions: !!body.shuffleOptions,
  negativeMarking: !!body.negativeMarking,
  maxViolations: Math.min(50, Math.max(1, Number(body.maxViolations) || 5)),
  calculatorEnabled: !!body.calculatorEnabled,
  isTestExam: !!body.isTestExam,
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
  const { title, subject, description, duration, totalMarks, passingMarks, status, shuffleQuestions, shuffleOptions, negativeMarking, maxViolations, calculatorEnabled, isTestExam } = req.body;

  const currentExam = await prisma.exam.findFirst({
    where: { id, ...scopeWhere(req) },
    include: { _count: { select: { attempts: true, mappings: true } } },
  });
  if (!currentExam) throw new ApiError(404, 'Exam not found');

  const hasContentChanges = [title, subject, description, duration, totalMarks, passingMarks, shuffleQuestions, shuffleOptions, negativeMarking, maxViolations, calculatorEnabled, isTestExam]
    .some((value) => value !== undefined);
  if (hasContentChanges && (currentExam.publishedAt || currentExam.status === 'Closed' || currentExam._count.attempts > 0)) {
    throw new ApiError(409, 'Exam rules and content are frozen after publication or the first attempt. Create a new exam version to make changes.');
  }

  if (status !== undefined && !['Draft', 'Published', 'Closed'].includes(status)) {
    throw new ApiError(400, 'Invalid exam status');
  }
  if (currentExam.status === 'Closed' && status !== undefined && status !== 'Closed') {
    throw new ApiError(409, 'A closed exam cannot be reopened. Create a new exam version instead.');
  }
  if (currentExam.status === 'Published' && status === 'Draft' && currentExam._count.attempts > 0) {
    throw new ApiError(409, 'An attempted exam cannot be unpublished. Close it or create a new version.');
  }

  if (status === 'Published') {
    const exam = await prisma.exam.findUnique({
      where: { id },
      include: { questions: { select: { marks: true } } },
    });
    if (!exam) throw new ApiError(404, 'Exam not found');

    const configuredTotalMarks = exam.questions.reduce((sum, question) => sum + question.marks, 0);
    const expectedTotalMarks = totalMarks !== undefined ? Number(totalMarks) : exam.totalMarks;
    if (exam.questions.length === 0) {
      throw new ApiError(400, 'Add questions before publishing this exam');
    }
    if (configuredTotalMarks !== expectedTotalMarks) {
      throw new ApiError(400, `Question marks total ${configuredTotalMarks}, but the exam total is ${expectedTotalMarks}. Add or update questions before publishing.`);
    }
  }

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
      publishedAt: status === 'Published' && !currentExam.publishedAt ? new Date() : undefined,
      closedAt: status === 'Closed' ? new Date() : undefined,
      shuffleQuestions,
      shuffleOptions,
      negativeMarking,
      maxViolations: maxViolations !== undefined ? Math.min(50, Math.max(1, Number(maxViolations) || 5)) : undefined,
      calculatorEnabled,
      isTestExam,
    },
    include: { _count: { select: { questions: true, mappings: true } } },
  });
  res.json(toPublic(exam));
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const exam = await prisma.exam.findFirst({
    where: { id, ...scopeWhere(req) },
    include: { _count: { select: { attempts: true } } },
  });
  if (!exam) throw new ApiError(404, 'Exam not found');
  if (exam.publishedAt || exam.status === 'Closed' || exam._count.attempts > 0) {
    throw new ApiError(409, 'Published or attempted exams cannot be deleted because their audit history is immutable.');
  }
  await prisma.exam.delete({ where: { id } });
  res.json({ success: true });
});

const preview = asyncHandler(async (req, res) => {
  const exam = await prisma.exam.findFirst({
    where: { id: req.params.id, ...scopeWhere(req) },
    include: { questions: { orderBy: { createdAt: 'asc' } }, _count: { select: { questions: true, mappings: true } } },
  });
  if (!exam) throw new ApiError(404, 'Exam not found');
  res.json({ ...toPublic(exam), questions: exam.questions.map(toPublicQuestion) });
});

const duplicate = asyncHandler(async (req, res) => {
  const source = await prisma.exam.findFirst({
    where: { id: req.params.id, ...scopeWhere(req) },
    include: { questions: true },
  });
  if (!source) throw new ApiError(404, 'Exam not found');
  const versionGroupId = source.versionGroupId || source.id;
  const latest = await prisma.exam.aggregate({ where: { versionGroupId }, _max: { version: true } });
  const copy = await prisma.exam.create({
    data: {
      title: req.body.title || `${source.title} v${(latest._max.version || source.version) + 1}`,
      subject: source.subject,
      description: source.description,
      duration: source.duration,
      totalMarks: source.totalMarks,
      passingMarks: source.passingMarks,
      status: 'Draft',
      version: (latest._max.version || source.version) + 1,
      versionGroupId,
      parentExamId: source.id,
      shuffleQuestions: source.shuffleQuestions,
      shuffleOptions: source.shuffleOptions,
      negativeMarking: source.negativeMarking,
      maxViolations: source.maxViolations,
      calculatorEnabled: source.calculatorEnabled,
      isTestExam: source.isTestExam,
      organizationId: source.organizationId,
      questions: {
        create: source.questions.map(({ text, subject, type, difficulty, marks, options, correctAnswer, explanation }) => ({
          text, subject, type, difficulty, marks, options: repairQuestionOptions(options).options, correctAnswer, explanation,
        })),
      },
    },
    include: { _count: { select: { questions: true, mappings: true } } },
  });
  res.status(201).json(toPublic(copy));
});

module.exports = { list, create, update, remove, preview, duplicate };
