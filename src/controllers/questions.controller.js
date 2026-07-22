const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { parseQuestionsWorkbook, generateTemplateBuffer } = require('../utils/questionImport');
const { repairQuestionOptions } = require('../utils/questionOptionRepair');

const toPublic = (q) => ({
  id: q.id,
  text: q.text,
  subject: q.subject,
  type: q.type,
  difficulty: q.difficulty,
  marks: q.marks,
  options: repairQuestionOptions(q.options).options,
  correctAnswer: q.correctAnswer,
  explanation: q.explanation || undefined,
  examId: q.examId,
});

// Questions now belong directly to one Exam (no shared bank). Every route here
// is nested under /api/exams/:examId/questions, so req.params.examId is always
// present; we still verify the exam belongs to the requesting admin's org.
const assertOwnedExam = async (examId, organizationId) => {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: { _count: { select: { attempts: true } } },
  });
  if (!exam || (organizationId && exam.organizationId !== organizationId)) {
    throw new ApiError(404, 'Exam not found');
  }
  return exam;
};

const assertExamEditable = (exam) => {
  if (exam.publishedAt || exam.status === 'Closed' || exam._count.attempts > 0) {
    throw new ApiError(409, 'Questions are frozen after an exam is published or attempted. Create a new exam version to make changes.');
  }
};

const validateQuestion = (body) => {
  const type = body.type || 'Multiple Choice';
  const allowedTypes = ['Multiple Choice', 'True/False'];
  if (!allowedTypes.includes(type)) throw new ApiError(400, `Unsupported question type: ${type}`);
  if (!body.text?.trim() || !body.subject?.trim()) throw new ApiError(400, 'Question text and subject are required');
  const marks = Number(body.marks ?? 1);
  if (!Number.isInteger(marks) || marks <= 0) throw new ApiError(400, 'Question marks must be a positive whole number');
  if (!Array.isArray(body.options)) throw new ApiError(400, 'Question options are required');
  const options = body.options.map((option) => String(option).trim());
  if (options.some((option) => !option)) throw new ApiError(400, 'Question options cannot be empty');
  if (new Set(options.map((option) => option.toLocaleLowerCase())).size !== options.length) {
    throw new ApiError(400, 'Question options must be unique');
  }
  if (type === 'Multiple Choice' && options.length < 2) throw new ApiError(400, 'Multiple Choice questions require at least 2 options');
  if (type === 'True/False' && (options.length !== 2 || options[0].toLowerCase() !== 'true' || options[1].toLowerCase() !== 'false')) {
    throw new ApiError(400, 'True/False options must be exactly True and False');
  }
  const correctAnswer = Number(body.correctAnswer);
  if (!Number.isInteger(correctAnswer) || correctAnswer < 0 || correctAnswer >= options.length) {
    throw new ApiError(400, 'Correct answer index is outside the available options');
  }
  return { ...body, text: body.text.trim(), subject: body.subject.trim(), type, marks, options, correctAnswer };
};

const buildData = (body, examId) => ({
  text: body.text,
  subject: body.subject,
  type: body.type || 'Multiple Choice',
  difficulty: body.difficulty || 'Medium',
  marks: Number(body.marks) || 1,
  options: body.options || [],
  correctAnswer: Number(body.correctAnswer),
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
  const validated = validateQuestion(req.body);
  const exam = await assertOwnedExam(examId, req.user.organizationId);
  assertExamEditable(exam);
  const question = await prisma.question.create({ data: buildData(validated, examId) });
  res.status(201).json(toPublic(question));
});

const bulkCreate = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { questions } = req.body;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ApiError(400, 'questions must be a non-empty array');
  }
  const exam = await assertOwnedExam(examId, req.user.organizationId);
  assertExamEditable(exam);
  const validated = questions.map((question, index) => {
    try { return validateQuestion(question); } catch (error) { throw new ApiError(400, `Question ${index + 1}: ${error.message}`); }
  });
  const created = await prisma.$transaction(
    validated.map((q) => prisma.question.create({ data: buildData(q, examId) }))
  );
  res.status(201).json(created.map(toPublic));
});

const update = asyncHandler(async (req, res) => {
  const { examId, id } = req.params;
  const { text, subject, type, difficulty, marks, options, correctAnswer, explanation } = req.body;
  const exam = await assertOwnedExam(examId, req.user.organizationId);
  assertExamEditable(exam);

  const existing = await prisma.question.findFirst({ where: { id, examId } });
  if (!existing) throw new ApiError(404, 'Question not found');
  const validated = validateQuestion({ ...existing, ...req.body });

  const question = await prisma.question.update({
    where: { id },
    data: {
      text: validated.text,
      subject: validated.subject,
      type: validated.type,
      difficulty: validated.difficulty,
      marks: validated.marks,
      options: validated.options,
      correctAnswer: validated.correctAnswer,
      explanation: validated.explanation,
    },
  });
  res.json(toPublic(question));
});

const remove = asyncHandler(async (req, res) => {
  const { examId, id } = req.params;
  const exam = await assertOwnedExam(examId, req.user.organizationId);
  assertExamEditable(exam);
  const deleted = await prisma.question.deleteMany({ where: { id, examId } });
  if (deleted.count === 0) throw new ApiError(404, 'Question not found');
  res.json({ success: true });
});

const importFromFile = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  if (!req.file) throw new ApiError(400, 'No file uploaded');
  const exam = await assertOwnedExam(examId, req.user.organizationId);
  assertExamEditable(exam);
  const { marks, difficulty, type } = req.body;

  const defaults = {
    subject: exam.subject,
    marks: Number(marks) || 1,
    difficulty: difficulty || 'Medium',
    type: type || 'Multiple Choice',
  };

  const { questions, errors } = await parseQuestionsWorkbook(req.file.buffer, req.file.originalname, defaults);

  if (errors.length > 0) {
    return res.status(400).json({ message: 'The file has errors and was not imported.', errors });
  }
  if (questions.length === 0) {
    throw new ApiError(400, 'No valid questions were found in the file.');
  }

  const validated = questions.map((question, index) => {
    try { return validateQuestion(question); } catch (error) { throw new ApiError(400, `Imported question ${index + 1}: ${error.message}`); }
  });
  const created = await prisma.$transaction(
    validated.map((q) => prisma.question.create({ data: buildData(q, examId) }))
  );
  res.status(201).json(created.map(toPublic));
});

const downloadTemplate = asyncHandler(async (req, res) => {
  const format = (req.query.format || 'xlsx').toLowerCase();
  const mimeTypes = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
  };
  if (!mimeTypes[format]) throw new ApiError(400, 'format must be one of: xlsx, csv');

  const buffer = await generateTemplateBuffer(format);
  res.setHeader('Content-Type', mimeTypes[format]);
  res.setHeader('Content-Disposition', `attachment; filename="question-import-template.${format}"`);
  res.send(buffer);
});

module.exports = { list, create, bulkCreate, update, remove, importFromFile, downloadTemplate, validateQuestion };
