const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { parseStudentsWorkbook, generateTemplateBuffer } = require('../utils/studentImport');
const { assertOwnedClass } = require('./classes.controller');

const DEFAULT_PASSWORD = 'password123';

const toPublic = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone || '',
  status: u.status,
  createdAt: u.createdAt.toISOString(),
  registerNumber: u.studentProfile?.registerNumber || '',
  classId: u.studentProfile?.classId || '',
});

const list = asyncHandler(async (req, res) => {
  const { classId } = req.query;
  if (!classId) throw new ApiError(400, 'classId query param is required');
  await assertOwnedClass(classId, req.user.organizationId);

  const students = await prisma.user.findMany({
    where: { role: 'STUDENT', studentProfile: { classId } },
    include: { studentProfile: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(students.map(toPublic));
});

const create = asyncHandler(async (req, res) => {
  const { name, registerNumber, classId, email, phone, status, password } = req.body;
  if (!name || !registerNumber || !classId || !phone) {
    throw new ApiError(400, 'Missing required student fields');
  }
  await assertOwnedClass(classId, req.user.organizationId);

  const finalEmail = email || `${registerNumber.toLowerCase().replace(/[^a-z0-9]/g, '')}@student.hextorq.internal`;

  const existing = await prisma.user.findUnique({ where: { email: finalEmail } });
  if (existing) throw new ApiError(409, 'A user with this email already exists');

  const passwordHash = await bcrypt.hash(password || DEFAULT_PASSWORD, 10);
  const student = await prisma.user.create({
    data: {
      name,
      email: finalEmail,
      phone,
      status: status || 'Active',
      role: 'STUDENT',
      passwordHash,
      organizationId: req.user.organizationId || undefined,
      studentProfile: {
        create: { registerNumber, classId },
      },
    },
    include: { studentProfile: true },
  });
  res.status(201).json(toPublic(student));
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, registerNumber, classId, email, phone, status } = req.body;

  if (classId !== undefined) {
    await assertOwnedClass(classId, req.user.organizationId);
  }

  const student = await prisma.user.update({
    where: { id },
    data: {
      name,
      ...(email && { email }),
      phone,
      status,
      studentProfile: {
        update: {
          ...(registerNumber !== undefined && { registerNumber }),
          ...(classId !== undefined && { classId }),
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

const importFromFile = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, 'No file uploaded');
  const { classId } = req.body;
  if (!classId) throw new ApiError(400, 'classId is required');
  await assertOwnedClass(classId, req.user.organizationId);

  const { students, errors } = parseStudentsWorkbook(req.file.buffer);

  if (errors.length > 0) {
    return res.status(400).json({ message: 'The file has errors and was not imported.', errors });
  }
  if (students.length === 0) {
    throw new ApiError(400, 'No valid students were found in the file.');
  }

  // Emails must be unique across the whole system, not just within this file.
  const emails = students.map((s) => s.email);
  const existingUsers = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { email: true },
  });
  if (existingUsers.length > 0) {
    const dupeEmails = new Set(existingUsers.map((u) => u.email.toLowerCase()));
    const dupeErrors = students
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => dupeEmails.has(s.email.toLowerCase()))
      .map(({ s, i }) => ({ row: i + 2, error: `A user with email "${s.email}" already exists.` }));
    return res.status(400).json({ message: 'The file has errors and was not imported.', errors: dupeErrors });
  }

  const operations = await Promise.all(
    students.map(async (s) => {
      const hash = await bcrypt.hash(s.password || DEFAULT_PASSWORD, 10);
      return prisma.user.create({
        data: {
          name: s.name,
          email: s.email,
          phone: s.phone,
          status: s.status,
          role: 'STUDENT',
          passwordHash: hash,
          organizationId: req.user.organizationId || undefined,
          studentProfile: {
            create: { registerNumber: s.registerNumber, classId },
          },
        },
        include: { studentProfile: true },
      });
    })
  );

  const created = await prisma.$transaction(operations);

  res.status(201).json(created.map(toPublic));
});

const downloadTemplate = asyncHandler(async (req, res) => {
  const format = (req.query.format || 'xlsx').toLowerCase();
  const mimeTypes = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv',
  };
  if (!mimeTypes[format]) throw new ApiError(400, 'format must be one of: xlsx, xls, csv');

  const buffer = generateTemplateBuffer(format);
  res.setHeader('Content-Type', mimeTypes[format]);
  res.setHeader('Content-Disposition', `attachment; filename="student-import-template.${format}"`);
  res.send(buffer);
});

module.exports = { list, create, update, remove, importFromFile, downloadTemplate };
