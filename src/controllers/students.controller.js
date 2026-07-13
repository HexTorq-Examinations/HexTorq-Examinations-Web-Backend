const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { parseStudentsWorkbook, generateTemplateBuffer } = require('../utils/studentImport');
const { assertOwnedClass } = require('./classes.controller');
const { createPasswordResetToken } = require('../utils/authTokens');
const { sendPasswordResetEmail } = require('../utils/mailer');

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
  extraTimeMinutes: u.studentProfile?.extraTimeMinutes || 0,
  accessibilityNotes: u.studentProfile?.accessibilityNotes || '',
});

const classOrganizationId = (cls) => cls.department.school.batch.organizationId;

const assertOwnedStudent = async (id, req) => {
  const student = await prisma.user.findFirst({
    where: {
      id,
      role: 'STUDENT',
      ...(req.user.role === 'ADMIN' ? { organizationId: req.user.organizationId } : {}),
    },
    include: { studentProfile: true },
  });
  if (!student) throw new ApiError(404, 'Student not found');
  return student;
};

const list = asyncHandler(async (req, res) => {
  const { classId } = req.query;
  if (!classId) throw new ApiError(400, 'classId query param is required');
  const cls = await assertOwnedClass(classId, req.user.organizationId);

  const students = await prisma.user.findMany({
    where: { role: 'STUDENT', studentProfile: { classId } },
    include: { studentProfile: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(students.map(toPublic));
});

const create = asyncHandler(async (req, res) => {
  const { name, registerNumber, classId, email, phone, status, password, extraTimeMinutes, accessibilityNotes } = req.body;
  if (!name || !registerNumber || !classId || !phone) {
    throw new ApiError(400, 'Missing required student fields');
  }
  const cls = await assertOwnedClass(classId, req.user.organizationId);

  const finalEmail = email || `${registerNumber.toLowerCase().replace(/[^a-z0-9]/g, '')}@student.hextorq.internal`;

  const existing = await prisma.user.findUnique({ where: { email: finalEmail } });
  if (existing) throw new ApiError(409, 'A user with this email already exists');

  // registerNumber doubles as a login identifier (see auth.controller's login
  // fallback), so a duplicate isn't just a data-quality issue — it makes one of
  // the two students unable to reliably log in with their own ID.
  const existingRegisterNumber = await prisma.studentProfile.findFirst({ where: { registerNumber } });
  if (existingRegisterNumber) throw new ApiError(409, `A student with register number "${registerNumber}" already exists`);

  const passwordHash = await bcrypt.hash(password || DEFAULT_PASSWORD, 10);
  const student = await prisma.user.create({
    data: {
      name,
      email: finalEmail,
      phone,
      status: status || 'Active',
      role: 'STUDENT',
      passwordHash,
      organizationId: classOrganizationId(cls),
      studentProfile: {
        create: { registerNumber, classId, extraTimeMinutes: Math.max(0, Number(extraTimeMinutes) || 0), accessibilityNotes: accessibilityNotes?.trim() || null },
      },
    },
    include: { studentProfile: true },
  });
  res.status(201).json(toPublic(student));
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, registerNumber, classId, email, phone, status, extraTimeMinutes, accessibilityNotes } = req.body;

  const current = await assertOwnedStudent(id, req);
  const targetClass = classId !== undefined
    ? await assertOwnedClass(classId, req.user.organizationId)
    : null;

  if (registerNumber !== undefined && registerNumber !== current.studentProfile?.registerNumber) {
    const clash = await prisma.studentProfile.findFirst({ where: { registerNumber, userId: { not: id } } });
    if (clash) throw new ApiError(409, `A student with register number "${registerNumber}" already exists`);
  }

  const student = await prisma.user.update({
    where: { id },
    data: {
      name,
      ...(email && { email }),
      phone,
      status,
      ...(targetClass ? { organizationId: classOrganizationId(targetClass) } : {}),
      studentProfile: {
        update: {
          ...(registerNumber !== undefined && { registerNumber }),
          ...(classId !== undefined && { classId }),
          ...(extraTimeMinutes !== undefined && { extraTimeMinutes: Math.max(0, Number(extraTimeMinutes) || 0) }),
          ...(accessibilityNotes !== undefined && { accessibilityNotes: accessibilityNotes?.trim() || null }),
        },
      },
    },
    include: { studentProfile: true },
  });
  res.json(toPublic(student));
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertOwnedStudent(id, req);
  await prisma.user.delete({ where: { id } });
  res.json({ success: true });
});

const sendPasswordReset = asyncHandler(async (req, res) => {
  const student = await assertOwnedStudent(req.params.id, req);
  if (!student.email || student.email.endsWith('@student.hextorq.internal')) {
    throw new ApiError(400, 'Add a valid student email address before sending a password reset');
  }
  const token = await createPasswordResetToken(student.id, req.user.id);
  await sendPasswordResetEmail(
    student.email,
    student.name,
    token,
    process.env.FRONTEND_URL || 'http://localhost:3000'
  );
  res.json({ success: true, message: `Password reset link sent to ${student.email}` });
});

const importFromFile = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, 'No file uploaded');
  const { classId } = req.body;
  if (!classId) throw new ApiError(400, 'classId is required');
  const cls = await assertOwnedClass(classId, req.user.organizationId);

  const { students, errors } = await parseStudentsWorkbook(req.file.buffer, req.file.originalname);

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
  const dupeEmails = new Set(existingUsers.map((u) => u.email.toLowerCase()));

  // registerNumber doubles as a login identifier (see auth.controller's login
  // fallback) — a duplicate leaves one of the colliding students unable to
  // reliably log in with their own ID, so it's checked with the same rigor as
  // email, both against existing students and duplicates within this file.
  const registerNumbers = students.map((s) => s.registerNumber);
  const existingProfiles = await prisma.studentProfile.findMany({
    where: { registerNumber: { in: registerNumbers } },
    select: { registerNumber: true },
  });
  const dupeRegisterNumbers = new Set(existingProfiles.map((p) => p.registerNumber));
  const seenInFile = new Set();

  // A single pass so a registerNumber is always recorded as "seen" even when the
  // row is rejected for a different reason (e.g. duplicate email) — otherwise a
  // later row repeating that same registerNumber would slip through unflagged.
  const dupeErrors = [];
  const validStudents = [];
  students.forEach((s, i) => {
    const emailDupe = dupeEmails.has(s.email.toLowerCase());
    const registerNumberDupe = dupeRegisterNumbers.has(s.registerNumber) || seenInFile.has(s.registerNumber);
    seenInFile.add(s.registerNumber);

    if (emailDupe || registerNumberDupe) {
      dupeErrors.push({
        row: i + 2,
        error: emailDupe
          ? `A user with email "${s.email}" already exists.`
          : `A student with register number "${s.registerNumber}" already exists.`,
      });
    } else {
      validStudents.push(s);
    }
  });

  if (validStudents.length === 0 && dupeErrors.length > 0) {
    return res.status(400).json({ message: 'All students in the file already exist.', errors: dupeErrors });
  }

  // Hash passwords first (async) so the $transaction array below holds un-awaited
  // Prisma Client promises only — awaiting them here would make $transaction reject
  // with "All elements of the array need to be Prisma Client promises".
  const hashes = await Promise.all(
    validStudents.map((s) => bcrypt.hash(s.password || DEFAULT_PASSWORD, 10))
  );

  const operations = validStudents.map((s, i) => prisma.user.create({
    data: {
      name: s.name,
      email: s.email,
      phone: s.phone,
      status: s.status,
      role: 'STUDENT',
      passwordHash: hashes[i],
      organizationId: classOrganizationId(cls),
      studentProfile: {
        create: { registerNumber: s.registerNumber, classId },
      },
    },
    include: { studentProfile: true },
  }));

  const created = await prisma.$transaction(operations);

  res.status(201).json({
    students: created.map(toPublic),
    errors: dupeErrors,
  });
});

const downloadTemplate = asyncHandler(async (req, res) => {
  const format = (req.query.format || 'xlsx').toLowerCase();
  const mimeTypes = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
  };
  if (!mimeTypes[format]) throw new ApiError(400, 'format must be one of: xlsx, csv');

  const buffer = await generateTemplateBuffer(format);
  res.setHeader('Content-Type', mimeTypes[format]);
  res.setHeader('Content-Disposition', `attachment; filename="student-import-template.${format}"`);
  res.send(buffer);
});

module.exports = { list, create, update, remove, sendPasswordReset, importFromFile, downloadTemplate };
