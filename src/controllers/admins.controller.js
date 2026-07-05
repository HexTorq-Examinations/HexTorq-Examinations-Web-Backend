const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const DEFAULT_PASSWORD = 'password123';

const roleToDb = (role) => (role === 'Super Admin' ? 'SUPER_ADMIN' : 'ADMIN');
const roleFromDb = (role) => (role === 'SUPER_ADMIN' ? 'Super Admin' : 'Admin');

const toPublic = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone || '',
  employeeId: u.employeeId || '',
  role: roleFromDb(u.role),
  status: u.status,
  lastLogin: u.lastLoginAt ? u.lastLoginAt.toISOString() : 'Never',
  organizationId: u.organizationId || undefined,
  organizationName: u.organization?.name,
});

const list = asyncHandler(async (req, res) => {
  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    include: { organization: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(admins.map(toPublic));
});

const create = asyncHandler(async (req, res) => {
  const { name, email, phone, empId, employeeId, role, status, organizationId } = req.body;
  if (!name || !email) throw new ApiError(400, 'name and email are required');

  const dbRole = roleToDb(role);
  if (dbRole === 'ADMIN' && !organizationId) {
    throw new ApiError(400, 'organizationId is required for an Admin (Super Admins are not tied to an organization)');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ApiError(409, 'A user with this email already exists');

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  const admin = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      employeeId: employeeId || empId,
      role: dbRole,
      status: status || 'Active',
      passwordHash,
      organizationId: dbRole === 'ADMIN' ? organizationId : undefined,
    },
    include: { organization: true },
  });
  res.status(201).json(toPublic(admin));
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, empId, employeeId, role, status, organizationId } = req.body;
  const dbRole = role ? roleToDb(role) : undefined;
  const admin = await prisma.user.update({
    where: { id },
    data: {
      name,
      email,
      phone,
      employeeId: employeeId || empId,
      role: dbRole,
      status,
      organizationId: dbRole === 'SUPER_ADMIN' ? null : organizationId,
    },
    include: { organization: true },
  });
  res.json(toPublic(admin));
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.user.delete({ where: { id } });
  res.json({ success: true });
});

module.exports = { list, create, update, remove };
