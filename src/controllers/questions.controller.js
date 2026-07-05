const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { parseQuestionsWorkbook, generateTemplateBuffer } = require('../utils/questionImport');

const toPublic = (q) => ({
  id: q.id,
  text: q.text,
  subject: q.subject,
  type: q.type,
  difficulty: q.difficulty,
  marks: q.marks,
  options: q.options,
  correctAnswer: q.correctAnswer,
  explanation: q.explanation || undefined,
  examId: q.examId,
});

// Questions now belong directly to one Exam (no shared bank). Every route here
// is nested under /api/exams/:examId/questions, so req.params.examId is always
// present; we still verify the exam belongs to the requesting admin's org.
const assertOwnedExam = async (examId, organizationId) => {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam || (organizationId && exam.organizationId !== organizationId)) {
    throw new ApiError(404, 'Exam not found');
  }
  return exam;
};

const buildData = (body, examId) => ({
  text: body.text,
  subject: body.subject,
  type: body.type || 'Multiple Choice',
  difficulty: body.difficulty || 'Medium',
  marks: Number(body.marks) || 1,
  options: body.options || [],
  correctAnswer: Number(body.correctAnswer) || 0,
  explanation: body.explanation,
  examId,
});

const list = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  await assertOwnedExam(examId, req.user.organizationId);
  const questions = await prisma.question.findMany({ where: { examId }, orderBy: { createdAt: 'desc' } });
  res.json(questions.map(toPublic));
});

const create = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { text, subject, options } = req.body;
  if (!text || !subject || !Array.isArray(options) || options.length < 2) {
    throw new ApiError(400, 'text, subject, and at least 2 options are required');
  }
  await assertOwnedExam(examId, req.user.organizationId);
  const question = await prisma.question.create({ data: buildData(req.body, examId) });
  res.status(201).json(toPublic(question));
});

const bulkCreate = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { questions } = req.body;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ApiError(400, 'questions must be a non-empty array');
  }
  await assertOwnedExam(examId, req.user.organizationId);
  const created = await prisma.$transaction(
    questions.map((q) => prisma.question.create({ data: buildData(q, examId) }))
  );
  res.status(201).json(created.map(toPublic));
});

const update = asyncHandler(async (req, res) => {
  const { examId, id } = req.params;
  const { text, subject, type, difficulty, marks, options, correctAnswer, explanation } = req.body;
  await assertOwnedExam(examId, req.user.organizationId);

  const question = await prisma.question.update({
    where: { id },
    data: {
      text,
      subject,
      type,
      difficulty,
      marks: marks !== undefined ? Number(marks) : undefined,
      options,
      correctAnswer: correctAnswer !== undefined ? Number(correctAnswer) : undefined,
      explanation,
    },
  });
  res.json(toPublic(question));
});

const remove = asyncHandler(async (req, res) => {
  const { examId, id } = req.params;
  await assertOwnedExam(examId, req.user.organizationId);
  await prisma.question.delete({ where: { id } });
  res.json({ success: true });
});

const importFromFile = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  if (!req.file) throw new ApiError(400, 'No file uploaded');
  const exam = await assertOwnedExam(examId, req.user.organizationId);
  const { marks, difficulty, type } = req.body;

  const defaults = {
    subject: exam.subject,
    marks: Number(marks) || 1,
    difficulty: difficulty || 'Medium',
    type: type || 'Multiple Choice',
  };

  const { questions, errors } = parseQuestionsWorkbook(req.file.buffer, defaults);

  if (errors.length > 0) {
    return res.status(400).json({ message: 'The file has errors and was not imported.', errors });
  }
  if (questions.length === 0) {
    throw new ApiError(400, 'No valid questions were found in the file.');
  }

  const created = await prisma.$transaction(
    questions.map((q) => prisma.question.create({ data: buildData(q, examId) }))
  );
  res.status(201).json(created.map(toPublic));
});

const downloadTemplate = asyncHandler(async (req, res) => {
  const format = (req.query.format || 'xlsx').toLowerCase();
  const mimeTypes = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv',
  };
  if (!mimeTypes[format]) throw new ApiError(400, 'format must be one of: xlsx, xls, csv');

  const buffer = generateTemplateBuffer(format);
  res.setHeader('Content-Type', mimeTypes[format]);
  res.setHeader('Content-Disposition', `attachment; filename="question-import-template.${format}"`);
  res.send(buffer);
});

module.exports = { list, create, bulkCreate, update, remove, importFromFile, downloadTemplate };
