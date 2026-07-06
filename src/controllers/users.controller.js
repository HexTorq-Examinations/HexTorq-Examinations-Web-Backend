const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { toPublicUser } = require('./auth.controller');

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
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { name, phone },
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
  const avatarUrl = `/uploads/avatars/${req.file.filename}`;
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { avatar: avatarUrl },
  });
  res.json({ user: toPublicUser(user) });
});

module.exports = { getMyProfile, updateMe, changePassword, uploadAvatar };
