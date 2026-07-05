const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');

const scopeWhere = (req) => {
  if (req.user.role === 'ADMIN' && req.user.organizationId) {
    return { organizationId: req.user.organizationId };
  }
  return {};
};

const toPublic = (r) => ({
  id: r.id,
  examId: r.examId,
  examName: r.exam?.title,
  totalStudents: r.totalStudents,
  publishedDate: r.publishedDate ? r.publishedDate.toISOString().split('T')[0] : '',
  status: r.status,
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
    where: { status: { in: ['COMPLETED', 'TERMINATED'] }, exam: examOrgFilter },
    _count: { _all: true },
  });

  for (const row of finishedByExam) {
    const existing = await prisma.result.findFirst({ where: { examId: row.examId } });
    if (existing) {
      if (existing.totalStudents !== row._count._all) {
        await prisma.result.update({ where: { id: existing.id }, data: { totalStudents: row._count._all } });
      }
    } else {
      const exam = await prisma.exam.findUnique({ where: { id: row.examId } });
      await prisma.result.create({
        data: {
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
    where: scopeWhere(req),
    include: { exam: true },
    orderBy: { id: 'desc' },
  });
  res.json(results.map(toPublic));
});

const publish = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await prisma.result.update({
    where: { id },
    data: { status: 'Published', publishedDate: new Date() },
    include: { exam: true },
  });
  res.json(toPublic(result));
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
    where: { status: { in: ['COMPLETED', 'TERMINATED'] }, exam: examOrgFilter },
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

module.exports = { list, publish, analytics };
