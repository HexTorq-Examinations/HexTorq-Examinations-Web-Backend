const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { deleteStudentsInClasses } = require('./classes.controller');

const toPublic = (b) => ({ id: b.id, name: b.name, createdAt: b.createdAt, schoolCount: b._count?.schools });

const list = asyncHandler(async (req, res) => {
  const batches = await prisma.batch.findMany({
    where: { organizationId: req.user.organizationId },
    include: { _count: { select: { schools: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(batches.map(toPublic));
});

const create = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) throw new ApiError(400, 'name is required');
  if (!req.user.organizationId) throw new ApiError(400, 'Your account is not tied to an organization');

  const batch = await prisma.batch.create({
    data: { name, organizationId: req.user.organizationId },
    include: { _count: { select: { schools: true } } },
  });
  res.status(201).json(toPublic(batch));
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const existing = await prisma.batch.findUnique({ where: { id } });
  if (!existing || existing.organizationId !== req.user.organizationId) {
    throw new ApiError(404, 'Batch not found');
  }
  const batch = await prisma.batch.update({ where: { id }, data: { name }, include: { _count: { select: { schools: true } } } });
  res.json(toPublic(batch));
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.batch.findUnique({ where: { id } });
  if (!existing || existing.organizationId !== req.user.organizationId) {
    throw new ApiError(404, 'Batch not found');
  }
  const classes = await prisma.class.findMany({ where: { department: { school: { batchId: id } } }, select: { id: true } });
  await deleteStudentsInClasses(classes.map((c) => c.id));
  await prisma.batch.delete({ where: { id } });
  res.json({ success: true });
});

module.exports = { list, create, update, remove };
