const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

const toPublicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  avatar: user.avatar,
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

  const token = signToken(user);
  res.json({ user: toPublicUser(user), token });
});

const logout = asyncHandler(async (req, res) => {
  res.json({ success: true });
});

const me = asyncHandler(async (req, res) => {
  res.json({ user: toPublicUser(req.user) });
});

module.exports = { login, logout, me, toPublicUser, signToken };
