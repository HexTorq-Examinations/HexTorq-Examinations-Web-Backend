const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { sendPasswordResetEmail } = require('../utils/mailer');
const {
  REFRESH_COOKIE, hashToken, readCookie, issueRefreshToken, clearRefreshCookie, createPasswordResetToken,
} = require('../utils/authTokens');

const signToken = (user, sessionId) =>
  jwt.sign({ sub: user.id, role: user.role, sid: sessionId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });

const toPublicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  avatar: user.avatar,
  phone: user.phone,
  lastLoginAt: user.lastLoginAt,
  organizationId: user.organizationId || undefined,
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new ApiError(400, 'Identifier and password are required');

  let user = await prisma.user.findUnique({ where: { email } });
  
  if (!user) {
    const studentProfile = await prisma.studentProfile.findFirst({
      where: { registerNumber: email },
      include: { user: true }
    });
    if (studentProfile) user = studentProfile.user;
  }

  if (!user) throw new ApiError(401, 'Invalid credentials');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new ApiError(401, 'Invalid credentials');

  if (user.status !== 'Active') throw new ApiError(403, 'Your account has been deactivated');

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const session = await issueRefreshToken(user.id, res);
  const token = signToken(user, session.id);
  res.json({ user: toPublicUser(user), token });
});

const logout = asyncHandler(async (req, res) => {
  const raw = readCookie(req, REFRESH_COOKIE);
  if (raw) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(raw), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  clearRefreshCookie(res);
  res.json({ success: true });
});

const refresh = asyncHandler(async (req, res) => {
  const raw = readCookie(req, REFRESH_COOKIE);
  if (!raw) throw new ApiError(401, 'Refresh session missing');
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { user: true },
  });
  if (!stored || stored.revokedAt || stored.expiresAt <= new Date()) {
    clearRefreshCookie(res);
    throw new ApiError(401, 'Refresh session expired');
  }
  if (stored.user.status !== 'Active') throw new ApiError(403, 'Account is not active');
  if (['ADMIN', 'STUDENT'].includes(stored.user.role) && !stored.user.organizationId) {
    throw new ApiError(403, 'Account is not assigned to an organization');
  }

  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
  const session = await issueRefreshToken(stored.user.id, res);
  res.json({ user: toPublicUser(stored.user), token: signToken(stored.user, session.id) });
});

const findUserByIdentifier = async (identifier) => {
  const byEmail = await prisma.user.findUnique({ where: { email: identifier } });
  if (byEmail) return byEmail;
  const profile = await prisma.studentProfile.findFirst({
    where: { registerNumber: identifier },
    include: { user: true },
  });
  return profile?.user || null;
};

const forgotPassword = asyncHandler(async (req, res) => {
  const identifier = String(req.body.identifier || '').trim();
  if (!identifier) throw new ApiError(400, 'Email or Student ID is required');
  const user = await findUserByIdentifier(identifier);
  if (user?.email) {
    try {
      const resetToken = await createPasswordResetToken(user.id);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      await sendPasswordResetEmail(user.email, user.name, resetToken, frontendUrl);
    } catch (error) {
      console.error('Failed to send password reset email', error);
    }
  }
  // Deliberately identical response for existing and unknown accounts.
  res.json({ message: 'If the account exists, a password reset link has been emailed.' });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) throw new ApiError(400, 'token and newPassword are required');
  if (newPassword.length < 8) throw new ApiError(400, 'Password must be at least 8 characters');
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!stored || stored.usedAt || stored.expiresAt <= new Date()) {
    throw new ApiError(400, 'Invalid or expired password reset link');
  }
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: stored.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
    prisma.refreshToken.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  clearRefreshCookie(res);
  res.json({ success: true, message: 'Password reset successfully. Please sign in again.' });
});

const me = asyncHandler(async (req, res) => {
  res.json({ user: toPublicUser(req.user) });
});

module.exports = { login, logout, refresh, forgotPassword, resetPassword, me, toPublicUser, signToken };
