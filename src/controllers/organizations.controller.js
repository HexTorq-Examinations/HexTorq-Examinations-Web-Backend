const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const list = asyncHandler(async (req, res) => {
  const organizations = await prisma.organization.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { users: { where: { role: 'STUDENT' } } } } },
  });
  res.json(organizations.map((o) => ({
    id: o.id,
    name: o.name,
    code: o.code,
    domain: o.domain,
    adminEmail: o.adminEmail,
    status: o.status,
    plan: o.plan,
    studentsCount: o._count.users,
    createdAt: o.createdAt,
  })));
});

const create = asyncHandler(async (req, res) => {
  const { name, code, domain, adminEmail, status, plan } = req.body;
  if (!name || !code || !adminEmail) throw new ApiError(400, 'name, code and adminEmail are required');

  const org = await prisma.organization.create({
    data: { name, code, domain, adminEmail, status: status || 'Active', plan: plan || 'Basic' },
  });
  res.status(201).json(org);
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, code, domain, adminEmail, status, plan } = req.body;
  const org = await prisma.organization.update({
    where: { id },
    data: { name, code, domain, adminEmail, status, plan },
  });
  res.json(org);
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.organization.delete({ where: { id } });
  res.json({ success: true });
});

module.exports = { list, create, update, remove };
