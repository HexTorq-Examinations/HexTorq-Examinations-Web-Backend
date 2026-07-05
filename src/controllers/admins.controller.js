const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendAdminActivationEmail } = require('../utils/mailer');

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
  const { name, email, phone, empId, employeeId, role, status, organizationId, frontendUrl } = req.body;
  if (!name || !email) throw new ApiError(400, 'name and email are required');

  const dbRole = roleToDb(role);
  if (dbRole === 'ADMIN' && !organizationId) {
    throw new ApiError(400, 'organizationId is required for an Admin (Super Admins are not tied to an organization)');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ApiError(409, 'A user with this email already exists');

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  
  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  
  const admin = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      employeeId: employeeId || empId,
      role: dbRole,
      status: 'Pending',
      passwordHash,
      resetToken,
      resetTokenExpiry,
      organizationId: dbRole === 'ADMIN' ? organizationId : undefined,
    },
    include: { organization: true },
  });

  // Attempt to send email, but don't fail the request if email sending fails
  try {
    const url = frontendUrl || process.env.FRONTEND_URL || 'http://localhost:3000';
    await sendAdminActivationEmail(admin.email, admin.name, resetToken, url);
  } catch (error) {
    console.error('Failed to send activation email:', error);
  }

  res.status(201).json(toPublic(admin));
});

const setPassword = asyncHandler(async (req, res) => {
  const { email, token, newPassword } = req.body;
  
  if (!email || !token || !newPassword) {
    throw new ApiError(400, 'email, token, and newPassword are required');
  }

  const user = await prisma.user.findFirst({
    where: { 
      email,
      resetToken: token,
      resetTokenExpiry: { gt: new Date() } // Token must not be expired
    }
  });

  if (!user) {
    throw new ApiError(400, 'Invalid or expired activation link');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      status: 'Active',
      resetToken: null,
      resetTokenExpiry: null,
    }
  });

  res.json({ success: true, message: 'Password set successfully' });
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

module.exports = { list, create, update, remove, setPassword };
