const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const PDFDocument = require('pdfkit');
const { buildJsonBuffer } = require('../utils/tabularFiles');
const { answersMatch } = require('../utils/scoring');

const REPORTS = new Set(['student-performance', 'attendance-activity', 'exam-analysis', 'question-analytics']);
const TITLES = {
  'student-performance': 'Student Performance',
  'attendance-activity': 'Attendance and Activity',
  'exam-analysis': 'Exam Analysis',
  'question-analytics': 'Question Analytics',
};
const daysFromRange = { '7d': 7, '30d': 30, quarter: 90, year: 365, all: 0 };
const dateWhere = (range) => {
  const days = daysFromRange[range] ?? 30;
  return days ? { gte: new Date(Date.now() - days * 86400000) } : undefined;
};
const orgId = (req) => req.user.role === 'ADMIN' ? req.user.organizationId : undefined;
const examScope = (req) => ({ ...(orgId(req) ? { organizationId: orgId(req) } : {}), isTestExam: false });
const studentScope = (req) => orgId(req) ? { organizationId: orgId(req) } : {};
const round = (value, digits = 1) => Number((Number(value) || 0).toFixed(digits));
const latestAttemptTime = (attempt) => new Date(attempt.endedAt || attempt.startedAt || 0).getTime();

const sameSubjectImprovement = (attempts) => {
  const bySubject = new Map();
  attempts.forEach((attempt) => {
    const subject = attempt.exam?.subject || 'Unknown';
    const bucket = bySubject.get(subject) || [];
    bucket.push(attempt);
    bySubject.set(subject, bucket);
  });

  const candidates = [...bySubject.values()]
    .map((subjectAttempts) => subjectAttempts.sort((a, b) => latestAttemptTime(a) - latestAttemptTime(b)))
    .filter((subjectAttempts) => subjectAttempts.length > 1);

  if (candidates.length === 0) return 0;

  candidates.sort((a, b) => {
    const latestDiff = latestAttemptTime(b.at(-1)) - latestAttemptTime(a.at(-1));
    if (latestDiff !== 0) return latestDiff;
    return b.length - a.length;
  });

  const chosen = candidates[0];
  const first = chosen[0];
  const last = chosen.at(-1);
  const firstPct = first.exam.totalMarks ? first.score / first.exam.totalMarks * 100 : 0;
  const lastPct = last.exam.totalMarks ? last.score / last.exam.totalMarks * 100 : 0;
  return round(lastPct - firstPct);
};

const performanceRows = async (req, range) => {
  const attempts = await prisma.examAttempt.findMany({
    where: { status: { in: ['COMPLETED', 'TERMINATED'] }, exam: examScope(req), ...(dateWhere(range) ? { endedAt: dateWhere(range) } : {}) },
    include: { exam: true, user: { include: { studentProfile: true } } }, orderBy: { endedAt: 'asc' },
  });
  const byStudent = new Map();
  attempts.forEach(a => {
    const item = byStudent.get(a.userId) || { user: a.user, scores: [], attempts: [] };
    item.scores.push(a.exam.totalMarks ? a.score / a.exam.totalMarks * 100 : 0);
    item.attempts.push(a);
    byStudent.set(a.userId, item);
  });
  const rows = [...byStudent.values()].map(({ user, scores, attempts: studentAttempts }) => ({
    'Register Number': user.studentProfile?.registerNumber || '', Student: user.name, Exams: scores.length,
    'Average %': round(scores.reduce((s, v) => s + v, 0) / scores.length), 'Best %': round(Math.max(...scores)),
    'Improvement %': sameSubjectImprovement(studentAttempts),
  })).sort((a, b) => b['Average %'] - a['Average %']);
  rows.forEach((row, index) => { row.Percentile = rows.length > 1 ? round((rows.length - index - 1) / (rows.length - 1) * 100) : 100; });
  return rows;
};

const attendanceRows = async (req, range) => {
  const mappingWindow = dateWhere(range);
  const students = await prisma.user.findMany({
    where: { role: 'STUDENT', ...studentScope(req), ...(dateWhere(range) ? { OR: [{ lastLoginAt: dateWhere(range) }, { examAttempts: { some: { startedAt: dateWhere(range) } } }] } : {}) },
    include: { studentProfile: true, examAttempts: { where: dateWhere(range) ? { startedAt: dateWhere(range) } : {}, select: { status: true } } },
    orderBy: { name: 'asc' },
  });
  const classIds = [...new Set(students.map((user) => user.studentProfile?.classId).filter(Boolean))];
  const mappings = classIds.length === 0 ? [] : await prisma.examMapping.findMany({
    where: {
      classId: { in: classIds },
      ...(mappingWindow ? { startAt: mappingWindow } : {}),
      exam: examScope(req),
    },
    select: { classId: true },
  });
  const assignedByClass = mappings.reduce((map, mapping) => map.set(mapping.classId, (map.get(mapping.classId) || 0) + 1), new Map());
  return students.map(user => {
    const assigned = user.studentProfile?.classId ? (assignedByClass.get(user.studentProfile.classId) || 0) : 0;
    const completed = user.examAttempts.filter(a => ['COMPLETED', 'TERMINATED'].includes(a.status)).length;
    return { 'Register Number': user.studentProfile?.registerNumber || '', Student: user.name, 'Last Login': user.lastLoginAt?.toISOString() || 'Never', 'Attempts Started': user.examAttempts.length, 'Exams Completed': completed, 'Assigned Exams': assigned, 'Completion Rate %': assigned ? round(completed / assigned * 100) : 0 };
  });
};

const examRows = async (req, range) => {
  const exams = await prisma.exam.findMany({
    where: examScope(req), include: { questions: { select: { difficulty: true } }, attempts: { where: { status: { in: ['COMPLETED', 'TERMINATED'] }, ...(dateWhere(range) ? { endedAt: dateWhere(range) } : {}) } } }, orderBy: { title: 'asc' },
  });
  return exams.map(exam => {
    const completed = exam.attempts.filter(a => a.status === 'COMPLETED');
    const passed = completed.filter(a => a.score >= exam.passingMarks).length;
    const times = completed.filter(a => a.endedAt).map(a => (a.endedAt - a.startedAt) / 60000);
    const difficulties = exam.questions.reduce((out, q) => ({ ...out, [q.difficulty]: (out[q.difficulty] || 0) + 1 }), {});
    return { Exam: exam.title, Subject: exam.subject, Attempts: exam.attempts.length, Completed: completed.length, Terminated: exam.attempts.length - completed.length, 'Success Rate %': completed.length ? round(passed / completed.length * 100) : 0, 'Average Time (min)': times.length ? round(times.reduce((s, v) => s + v, 0) / times.length) : 0, Easy: difficulties.Easy || 0, Medium: difficulties.Medium || 0, Hard: difficulties.Hard || 0 };
  });
};

const questionRows = async (req, range) => {
  const attempts = await prisma.examAttempt.findMany({
    where: { status: { in: ['COMPLETED', 'TERMINATED'] }, exam: examScope(req), ...(dateWhere(range) ? { endedAt: dateWhere(range) } : {}) },
    include: { exam: true, answerRecords: true },
  });
  const questions = new Map();
  attempts.forEach(attempt => {
    const answers = new Map(attempt.answerRecords.map(a => [a.questionId, a.selectedAnswer]));
    (Array.isArray(attempt.questionSnapshot) ? attempt.questionSnapshot : []).forEach(q => {
      const key = `${attempt.examId}:${q.id}`; const item = questions.get(key) || { Exam: attempt.exam.title, Subject: attempt.exam.subject, Question: q.text, Attempts: 0, Correct: 0, Incorrect: 0, Unanswered: 0 };
      item.Attempts += 1; const answer = answers.get(q.id) ?? attempt.answers?.[q.id];
      if (!answer) item.Unanswered += 1; else if (answersMatch(answer, q.correctAnswer)) item.Correct += 1; else item.Incorrect += 1;
      questions.set(key, item);
    });
  });
  return [...questions.values()].map(item => ({ ...item, 'Failure Rate %': item.Attempts ? round((item.Incorrect + item.Unanswered) / item.Attempts * 100) : 0 })).sort((a, b) => b['Failure Rate %'] - a['Failure Rate %']);
};

const loadReport = async (type, req, range) => {
  if (type === 'student-performance') return performanceRows(req, range);
  if (type === 'attendance-activity') return attendanceRows(req, range);
  if (type === 'exam-analysis') return examRows(req, range);
  return questionRows(req, range);
};

const sendPdf = (res, title, rows, filename) => {
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  const doc = new PDFDocument({ margin: 36, layout: 'landscape', size: 'A4' }); doc.pipe(res);
  doc.fontSize(18).text(`HexTorq - ${title}`).fontSize(9).text(`Generated: ${new Date().toISOString()}  |  Records: ${rows.length}`).moveDown();
  rows.forEach((row, i) => { doc.fontSize(8).fillColor('#111827').text(`${i + 1}. ${Object.entries(row).map(([k, v]) => `${k}: ${v}`).join('  |  ')}`, { paragraphGap: 5 }); if (doc.y > 530) doc.addPage(); });
  if (!rows.length) doc.text('No records found for the selected period.'); doc.end();
};

const generate = asyncHandler(async (req, res) => {
  const { type } = req.params; if (!REPORTS.has(type)) throw new ApiError(400, 'Unknown report type');
  const range = req.query.range || '30d'; const format = req.query.format || 'json'; const rows = await loadReport(type, req, range);
  const filename = `${type}-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'json') return res.json({ title: TITLES[type], range, generatedAt: new Date().toISOString(), rows });
  if (format === 'pdf') return sendPdf(res, TITLES[type], rows, filename);
  if (format === 'xlsx') {
    const buffer = await buildJsonBuffer(rows, 'Report', 'xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`); return res.send(buffer);
  }
  if (format !== 'csv') throw new ApiError(400, 'format must be json, pdf, csv, or xlsx');
  const csv = await buildJsonBuffer(rows, 'Report', 'csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`); res.send(csv);
});

module.exports = { generate };
