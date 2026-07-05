const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const DEFAULT_PASSWORD = 'password123';

const toPublic = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone || '',
  status: u.status,
  createdAt: u.createdAt.toISOString(),
  registerNumber: u.studentProfile?.registerNumber || '',
  department: u.studentProfile?.department || '',
  semester: u.studentProfile?.semester || '',
});

const scopeWhere = (req) => {
  if (req.user.role === 'ADMIN' && req.user.organizationId) {
    return { role: 'STUDENT', organizationId: req.user.organizationId };
  }
  return { role: 'STUDENT' };
};

const list = asyncHandler(async (req, res) => {
  const students = await prisma.user.findMany({
    where: scopeWhere(req),
    include: { studentProfile: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(students.map(toPublic));
});

const create = asyncHandler(async (req, res) => {
  const { name, registerNumber, department, semester, email, phone, status } = req.body;
  if (!name || !registerNumber || !department || !semester || !email || !phone) {
    throw new ApiError(400, 'Missing required student fields');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ApiError(409, 'A user with this email already exists');

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  const student = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      status: status || 'Active',
      role: 'STUDENT',
      passwordHash,
      organizationId: req.user.organizationId || undefined,
      studentProfile: {
        create: { registerNumber, department, semester },
      },
    },
    include: { studentProfile: true },
  });
  res.status(201).json(toPublic(student));
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, registerNumber, department, semester, email, phone, status } = req.body;

  const student = await prisma.user.update({
    where: { id },
    data: {
      name,
      email,
      phone,
      status,
      studentProfile: {
        update: {
          ...(registerNumber !== undefined && { registerNumber }),
          ...(department !== undefined && { department }),
          ...(semester !== undefined && { semester }),
        },
      },
    },
    include: { studentProfile: true },
  });
  res.json(toPublic(student));
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.user.delete({ where: { id } });
  res.json({ success: true });
});

module.exports = { list, create, update, remove };
