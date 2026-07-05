const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const toPublic = (c) => ({
  id: c.id,
  name: c.name,
  departmentId: c.departmentId,
  createdAt: c.createdAt,
  studentCount: c._count?.students,
});

const assertOwnedDepartment = async (departmentId, organizationId) => {
  const department = await prisma.department.findUnique({
    where: { id: departmentId },
    include: { school: { include: { batch: true } } },
  });
  if (!department || department.school.batch.organizationId !== organizationId) {
    throw new ApiError(404, 'Department not found');
  }
  return department;
};

const list = asyncHandler(async (req, res) => {
  const { departmentId } = req.query;
  if (!departmentId) throw new ApiError(400, 'departmentId query param is required');
  await assertOwnedDepartment(departmentId, req.user.organizationId);

  const classes = await prisma.class.findMany({
    where: { departmentId },
    include: { _count: { select: { students: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(classes.map(toPublic));
});

const create = asyncHandler(async (req, res) => {
  const { name, departmentId } = req.body;
  if (!name || !departmentId) throw new ApiError(400, 'name and departmentId are required');
  await assertOwnedDepartment(departmentId, req.user.organizationId);

  const cls = await prisma.class.create({ data: { name, departmentId }, include: { _count: { select: { students: true } } } });
  res.status(201).json(toPublic(cls));
});

const assertOwnedClass = async (id, organizationId) => {
  const cls = await prisma.class.findUnique({
    where: { id },
    include: { department: { include: { school: { include: { batch: true } } } } },
  });
  if (!cls || cls.department.school.batch.organizationId !== organizationId) {
    throw new ApiError(404, 'Class not found');
  }
  return cls;
};

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  await assertOwnedClass(id, req.user.organizationId);
  const cls = await prisma.class.update({ where: { id }, data: { name }, include: { _count: { select: { students: true } } } });
  res.json(toPublic(cls));
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertOwnedClass(id, req.user.organizationId);
  await prisma.class.delete({ where: { id } });
  res.json({ success: true });
});

module.exports = { list, create, update, remove, assertOwnedClass };
