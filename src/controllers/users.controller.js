const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { toPublicUser } = require('./auth.controller');
const fs = require('fs/promises');
const path = require('path');

const uploadsRoot = path.resolve(__dirname, '..', '..', 'uploads', 'avatars');
const imageExtension = (buffer) => {
  if (buffer?.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buffer?.[0] === 0xff && buffer?.[1] === 0xd8 && buffer?.[2] === 0xff) return '.jpg';
  if (buffer?.subarray(0, 4).toString() === 'RIFF' && buffer?.subarray(8, 12).toString() === 'WEBP') return '.webp';
  if (['GIF87a', 'GIF89a'].includes(buffer?.subarray(0, 6).toString())) return '.gif';
  return null;
};

const getMyProfile = asyncHandler(async (req, res) => {
  const now = new Date();
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { studentProfile: { include: { class: { include: { department: { include: { school: { include: { batch: true } } } } } } } } },
  });
  if (!user) throw new ApiError(404, 'User not found');
  const profile = user.studentProfile;
  const [completedExams, upcomingExams, activeExams] = profile ? await Promise.all([
    prisma.examAttempt.count({ where: { userId: user.id, status: { in: ['COMPLETED', 'TERMINATED'] } } }),
    prisma.examMapping.count({ where: { classId: profile.classId, startAt: { gt: now }, status: { not: 'Cancelled' }, exam: { status: 'Published' } } }),
    prisma.examMapping.count({ where: { classId: profile.classId, startAt: { lte: now }, endAt: { gte: now }, status: { not: 'Cancelled' }, exam: { status: 'Published' } } }),
  ]) : [0, 0, 0];
  res.json({
    user: toPublicUser(user),
    student: profile ? {
      registerNumber: profile.registerNumber,
      className: profile.class.name,
      departmentName: profile.class.department.name,
      schoolName: profile.class.department.school.name,
      batchName: profile.class.department.school.batch.name,
      joinedAt: user.createdAt.toISOString(),
      extraTimeMinutes: profile.extraTimeMinutes,
      accessibilityNotes: profile.accessibilityNotes,
      completedExams, upcomingExams, activeExams,
    } : null,
  });
});

const updateMe = asyncHandler(async (req, res) => {
  const { name, phone } = req.body;
  if (name !== undefined && String(name).trim().length < 2) throw new ApiError(400, 'Name must be at least 2 characters');
  if (phone !== undefined && String(phone).length > 30) throw new ApiError(400, 'Phone number is too long');
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { name: name !== undefined ? String(name).trim() : undefined, phone: phone !== undefined ? String(phone).trim() : undefined },
  });
  res.json({ user: toPublicUser(user) });
});

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) throw new ApiError(400, 'currentPassword and newPassword are required');
  if (newPassword.length < 6) throw new ApiError(400, 'New password must be at least 6 characters');

  const valid = await bcrypt.compare(currentPassword, req.user.passwordHash);
  if (!valid) throw new ApiError(401, 'Current password is incorrect');

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.$transaction([
    prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({ where: { userId: req.user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  res.json({ success: true });
});

const uploadAvatar = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, 'No file uploaded');
  const extension = imageExtension(req.file.buffer);
  if (!extension) throw new ApiError(400, 'The uploaded file content is not a supported PNG, JPEG, WebP, or GIF image');
  const current = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { studentProfile: { include: { class: { include: { department: { include: { school: { include: { batch: true } } } } } } } } },
  });
  if (!current) throw new ApiError(404, 'User not found');
  const profile = current.studentProfile;
  const hierarchy = profile
    ? [`org-${current.organizationId}`, `batch-${profile.class.department.school.batchId}`, `school-${profile.class.department.schoolId}`, `department-${profile.class.departmentId}`, `class-${profile.classId}`]
    : [current.organizationId ? `org-${current.organizationId}` : 'global', current.role === 'SUPER_ADMIN' ? 'super-admins' : 'admins'];
  const relativeDirectory = path.join(...hierarchy, `user-${current.id}`);
  const directory = path.join(uploadsRoot, relativeDirectory);
  await fs.mkdir(directory, { recursive: true });
  const filename = `avatar-${Date.now()}${extension}`;
  await fs.writeFile(path.join(directory, filename), req.file.buffer, { flag: 'wx' });
  const relativePath = path.join(relativeDirectory, filename).replaceAll('\\', '/');
  const avatarUrl = `/uploads/avatars/${relativePath}`;
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { avatar: avatarUrl },
  });
  if (current.avatar?.startsWith('/uploads/avatars/')) {
    const oldPath = path.resolve(uploadsRoot, current.avatar.slice('/uploads/avatars/'.length));
    if (oldPath.startsWith(uploadsRoot)) await fs.unlink(oldPath).catch(() => {});
  }
  res.json({ user: toPublicUser(user) });
});

module.exports = { getMyProfile, updateMe, changePassword, uploadAvatar };
