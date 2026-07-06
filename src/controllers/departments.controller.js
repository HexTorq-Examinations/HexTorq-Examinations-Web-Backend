const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { deleteStudentsInClasses } = require('./classes.controller');

const toPublic = (d) => ({ id: d.id, name: d.name, schoolId: d.schoolId, createdAt: d.createdAt, classCount: d._count?.classes });

const assertOwnedSchool = async (schoolId, organizationId) => {
  const school = await prisma.school.findUnique({ where: { id: schoolId }, include: { batch: true } });
  if (!school || school.batch.organizationId !== organizationId) throw new ApiError(404, 'School not found');
  return school;
};

const list = asyncHandler(async (req, res) => {
  const { schoolId } = req.query;
  if (!schoolId) throw new ApiError(400, 'schoolId query param is required');
  await assertOwnedSchool(schoolId, req.user.organizationId);

  const departments = await prisma.department.findMany({
    where: { schoolId },
    include: { _count: { select: { classes: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(departments.map(toPublic));
});

const create = asyncHandler(async (req, res) => {
  const { name, schoolId } = req.body;
  if (!name || !schoolId) throw new ApiError(400, 'name and schoolId are required');
  await assertOwnedSchool(schoolId, req.user.organizationId);

  const department = await prisma.department.create({ data: { name, schoolId }, include: { _count: { select: { classes: true } } } });
  res.status(201).json(toPublic(department));
});

const assertOwnedDepartment = async (id, organizationId) => {
  const department = await prisma.department.findUnique({
    where: { id },
    include: { school: { include: { batch: true } } },
  });
  if (!department || department.school.batch.organizationId !== organizationId) {
    throw new ApiError(404, 'Department not found');
  }
  return department;
};

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  await assertOwnedDepartment(id, req.user.organizationId);
  const department = await prisma.department.update({ where: { id }, data: { name }, include: { _count: { select: { classes: true } } } });
  res.json(toPublic(department));
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertOwnedDepartment(id, req.user.organizationId);
  const classes = await prisma.class.findMany({ where: { departmentId: id }, select: { id: true } });
  await deleteStudentsInClasses(classes.map((c) => c.id));
  await prisma.department.delete({ where: { id } });
  res.json({ success: true });
});

module.exports = { list, create, update, remove };
