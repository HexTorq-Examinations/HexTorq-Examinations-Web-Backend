const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const toPublic = (s) => ({ id: s.id, name: s.name, batchId: s.batchId, createdAt: s.createdAt });

const assertOwnedBatch = async (batchId, organizationId) => {
  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch || batch.organizationId !== organizationId) throw new ApiError(404, 'Batch not found');
  return batch;
};

const list = asyncHandler(async (req, res) => {
  const { batchId } = req.query;
  if (!batchId) throw new ApiError(400, 'batchId query param is required');
  await assertOwnedBatch(batchId, req.user.organizationId);

  const schools = await prisma.school.findMany({ where: { batchId }, orderBy: { createdAt: 'desc' } });
  res.json(schools.map(toPublic));
});

const create = asyncHandler(async (req, res) => {
  const { name, batchId } = req.body;
  if (!name || !batchId) throw new ApiError(400, 'name and batchId are required');
  await assertOwnedBatch(batchId, req.user.organizationId);

  const school = await prisma.school.create({ data: { name, batchId } });
  res.status(201).json(toPublic(school));
});

const assertOwnedSchool = async (id, organizationId) => {
  const school = await prisma.school.findUnique({ where: { id }, include: { batch: true } });
  if (!school || school.batch.organizationId !== organizationId) throw new ApiError(404, 'School not found');
  return school;
};

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  await assertOwnedSchool(id, req.user.organizationId);
  const school = await prisma.school.update({ where: { id }, data: { name } });
  res.json(toPublic(school));
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertOwnedSchool(id, req.user.organizationId);
  await prisma.school.delete({ where: { id } });
  res.json({ success: true });
});

module.exports = { list, create, update, remove };
