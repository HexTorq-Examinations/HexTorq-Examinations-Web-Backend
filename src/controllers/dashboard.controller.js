const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');

// Students hang off Batch via Class -> Department -> School -> Batch; Exams have no
// direct batch link, so they're scoped by "has been mapped to a class in this batch"
// (ExamMapping -> Class -> Department -> School -> Batch). Both return {} (no-op
// filter) when no batchId is selected, so every query below works scoped or unscoped.
const studentBatchWhere = (batchId) => (
  batchId ? { studentProfile: { class: { department: { school: { batchId } } } } } : {}
);
const examBatchWhere = (batchId) => (
  batchId ? { mappings: { some: { class: { department: { school: { batchId } } } } } } : {}
);

const hierarchyCounts = async (orgFilter, batchId) => {
  const [totalBatches, totalSchools, totalDepartments, totalClasses] = await Promise.all([
    prisma.batch.count({ where: orgFilter.organizationId ? { organizationId: orgFilter.organizationId } : {} }),
    prisma.school.count({ where: batchId ? { batchId } : (orgFilter.organizationId ? { batch: { organizationId: orgFilter.organizationId } } : {}) }),
    prisma.department.count({ where: batchId ? { school: { batchId } } : (orgFilter.organizationId ? { school: { batch: { organizationId: orgFilter.organizationId } } } : {}) }),
    prisma.class.count({ where: batchId ? { department: { school: { batchId } } } : (orgFilter.organizationId ? { department: { school: { batch: { organizationId: orgFilter.organizationId } } } } : {}) }),
  ]);
  return { totalBatches, totalSchools, totalDepartments, totalClasses };
};

const superAdminStats = asyncHandler(async (req, res) => {
  const [totalOrganizations, totalStudents, totalAdmins, activeExams, totalExams, publishedResults] = await Promise.all([
    prisma.organization.count(),
    prisma.user.count({ where: { role: 'STUDENT' } }),
    prisma.user.count({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } }),
    prisma.exam.count({ where: { status: 'Active' } }),
    prisma.exam.count(),
    prisma.result.count({ where: { status: 'Published' } }),
  ]);
  res.json({ totalOrganizations, totalStudents, totalAdmins, activeExams, totalExams, publishedResults, ...(await hierarchyCounts({})) });
});

const adminStats = asyncHandler(async (req, res) => {
  const orgFilter = req.user.organizationId ? { organizationId: req.user.organizationId } : {};
  const { batchId } = req.query;
  const [totalStudents, activeExams, totalExams, publishedResults] = await Promise.all([
    prisma.user.count({ where: { role: 'STUDENT', ...orgFilter, ...studentBatchWhere(batchId) } }),
    prisma.exam.count({ where: { status: 'Active', ...orgFilter, ...examBatchWhere(batchId) } }),
    prisma.exam.count({ where: { ...orgFilter, ...examBatchWhere(batchId) } }),
    prisma.result.count({ where: { ...orgFilter, status: 'Published', exam: examBatchWhere(batchId) } }),
  ]);
  res.json({ totalStudents, activeExams, totalExams, publishedResults, ...(await hierarchyCounts(orgFilter, batchId)) });
});

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS_COLORS = {
  Completed: '#10b981',
  Active: '#3b82f6',
  Draft: '#94a3b8',
  Scheduled: '#8b5cf6',
};

// Everything below is derived from real rows (exams, attempts, students, results,
// questions, exam mappings) — there is no separate "activity log" table, so the
// activity feed and "student growth" numbers are computed from existing
// timestamped records rather than a purpose-built audit trail. When the Admin has
// selected a batch in the navbar (req.query.batchId), every metric below is
// re-scoped to that batch via studentBatchWhere/examBatchWhere.
const getOverview = asyncHandler(async (req, res) => {
  const isScoped = req.user.role === 'ADMIN' && req.user.organizationId;
  const orgFilter = isScoped ? { organizationId: req.user.organizationId } : {};
  const { batchId } = req.query;
  const examOrgFilter = { ...orgFilter, ...examBatchWhere(batchId) };
  const studentOrgFilter = { ...orgFilter, ...studentBatchWhere(batchId) };
  const attemptUserFilter = batchId ? { user: studentBatchWhere(batchId) } : {};

  const now = new Date();

  // ---- Exam trends: exams created vs. attempts completed, per month, last 7 months ----
  const monthWindows = [];
  for (let i = 6; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    monthWindows.push({ name: MONTH_NAMES[start.getMonth()], start, end });
  }
  const examTrends = await Promise.all(monthWindows.map(async ({ name, start, end }) => {
    const [created, completed] = await Promise.all([
      prisma.exam.count({ where: { ...examOrgFilter, createdAt: { gte: start, lt: end } } }),
      prisma.examAttempt.count({
        where: { exam: orgFilter, ...attemptUserFilter, status: 'COMPLETED', endedAt: { gte: start, lt: end } },
      }),
    ]);
    return { name, created, completed };
  }));

  // ---- Exam status distribution (real counts by current status) ----
  const statusGroups = await prisma.exam.groupBy({
    by: ['status'],
    where: examOrgFilter,
    _count: { status: true },
  });
  const examStatusDistribution = Object.keys(STATUS_COLORS).map((status) => ({
    name: status,
    value: statusGroups.find((g) => g.status === status)?._count.status || 0,
    color: STATUS_COLORS[status],
  }));

  // ---- Student growth: registrations per quarter of the current year, plus a running total ----
  const quarterWindows = [0, 1, 2, 3].map((q) => ({
    name: `Q${q + 1}`,
    start: new Date(now.getFullYear(), q * 3, 1),
    end: new Date(now.getFullYear(), q * 3 + 3, 1),
  }));
  let runningTotal = await prisma.user.count({
    where: { role: 'STUDENT', ...studentOrgFilter, createdAt: { lt: quarterWindows[0].start } },
  });
  const newPerQuarter = await Promise.all(quarterWindows.map(({ start, end }) => prisma.user.count({
    where: { role: 'STUDENT', ...studentOrgFilter, createdAt: { gte: start, lt: end } },
  })));
  const studentGrowth = quarterWindows.map(({ name }, i) => {
    runningTotal += newPerQuarter[i];
    return { name, active: runningTotal, new: newPerQuarter[i] };
  });

  // ---- Students per department (for the Reports chart) ----
  const departmentWhere = {
    school: {
      batch: {
        ...(isScoped ? { organizationId: req.user.organizationId } : {}),
        ...(batchId ? { id: batchId } : {}),
      },
    },
  };
  const departments = await prisma.department.findMany({
    where: departmentWhere,
    select: {
      name: true,
      classes: { select: { _count: { select: { students: true } } } },
    },
  });
  const studentsByDepartment = departments
    .map((d) => ({ name: d.name, students: d.classes.reduce((sum, c) => sum + c._count.students, 0) }))
    .filter((d) => d.students > 0)
    .sort((a, b) => b.students - a.students)
    .slice(0, 10);

  // ---- Recent activity: merge the last few real events across a handful of tables ----
  const [recentExams, recentResults, recentStudents, recentQuestions] = await Promise.all([
    prisma.exam.findMany({ where: examOrgFilter, orderBy: { createdAt: 'desc' }, take: 5, select: { title: true, createdAt: true } }),
    prisma.result.findMany({ where: { ...orgFilter, status: 'Published', exam: examBatchWhere(batchId) }, orderBy: { publishedDate: 'desc' }, take: 5, include: { exam: { select: { title: true } } } }),
    prisma.user.findMany({ where: { role: 'STUDENT', ...studentOrgFilter }, orderBy: { createdAt: 'desc' }, take: 5, select: { name: true, createdAt: true } }),
    prisma.question.findMany({ where: { exam: examOrgFilter }, orderBy: { createdAt: 'desc' }, take: 5, select: { subject: true, createdAt: true } }),
  ]);
  const activity = [
    ...recentExams.map((e) => ({ title: 'New Exam Created', desc: `"${e.title}" was created`, time: e.createdAt, type: 'create' })),
    ...recentResults.map((r) => ({ title: 'Results Published', desc: `${r.exam.title} results are live`, time: r.publishedDate, type: 'publish' })),
    ...recentStudents.map((s) => ({ title: 'Student Registered', desc: `${s.name} joined the platform`, time: s.createdAt, type: 'user' })),
    ...recentQuestions.map((q) => ({ title: 'Question Added', desc: `New question added to ${q.subject}`, time: q.createdAt, type: 'alert' })),
  ]
    .filter((a) => a.time)
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 6)
    .map((a) => ({ ...a, time: a.time.toISOString() }));

  // ---- Upcoming exams: real, scoped, next 3, sourced from Exam Mappings ----
  const upcomingMappings = await prisma.examMapping.findMany({
    where: {
      date: { gt: now },
      ...(isScoped ? { exam: { organizationId: req.user.organizationId } } : {}),
      ...(batchId ? { class: { department: { school: { batchId } } } } : {}),
    },
    include: { exam: true, class: { include: { _count: { select: { students: true } } } } },
    orderBy: { date: 'asc' },
    take: 3,
  });
  const upcomingExams = upcomingMappings.map((m) => ({
    name: `${m.exam.title} (${m.class.name})`,
    time: m.date.toISOString(),
    enrolled: m.class._count.students,
  }));

  // ---- Pending tasks: real, actionable, computed from current state ----
  const [draftExamsNoQuestions, pendingResults, pendingAdmins] = await Promise.all([
    prisma.exam.count({ where: { ...examOrgFilter, status: 'Draft', questions: { none: {} } } }),
    prisma.result.count({ where: { ...orgFilter, status: 'Pending Evaluation', exam: examBatchWhere(batchId) } }),
    isScoped ? 0 : prisma.user.count({ where: { role: 'ADMIN', status: 'Pending' } }),
  ]);
  const pendingTasks = [
    ...(pendingAdmins > 0 ? [{ task: `Approve ${pendingAdmins} pending admin activation${pendingAdmins > 1 ? 's' : ''}`, status: 'High Priority' }] : []),
    ...(draftExamsNoQuestions > 0 ? [{ task: `${draftExamsNoQuestions} draft exam${draftExamsNoQuestions > 1 ? 's have' : ' has'} no questions added`, status: 'Medium' }] : []),
    ...(pendingResults > 0 ? [{ task: `${pendingResults} result${pendingResults > 1 ? 's' : ''} awaiting evaluation`, status: 'Routine' }] : []),
  ];

  res.json({
    examTrends,
    examStatusDistribution,
    studentGrowth,
    studentsByDepartment,
    recentActivity: activity,
    upcomingExams,
    pendingTasks,
    ...(await hierarchyCounts(orgFilter, batchId)),
  });
});

module.exports = { superAdminStats, adminStats, getOverview };
