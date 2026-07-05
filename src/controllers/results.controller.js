const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

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

const list = asyncHandler(async (req, res) => {
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

module.exports = { list, publish };
