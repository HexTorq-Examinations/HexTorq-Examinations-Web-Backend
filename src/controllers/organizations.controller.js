const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendAdminActivationEmail } = require('../utils/mailer');
const { DateTime } = require('luxon');

const validateTimezone = (timezone) => {
  const value = timezone || 'Asia/Kolkata';
  if (!DateTime.now().setZone(value).isValid) throw new ApiError(400, 'Invalid IANA timezone');
  return value;
};

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
    timezone: o.timezone,
    studentsCount: o._count.users,
    createdAt: o.createdAt,
  })));
});

const create = asyncHandler(async (req, res) => {
  const { name, code, domain, adminEmail, status, plan, timezone, frontendUrl } = req.body;
  if (!name || !code || !adminEmail) {
    throw new ApiError(400, 'name, code, and adminEmail are required');
  }
  const existingUser = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existingUser) throw new ApiError(409, 'A user with this admin email already exists');

  const passwordHash = await bcrypt.hash('password123', 10);
  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const org = await prisma.$transaction(async (tx) => {
    const newOrg = await tx.organization.create({
      data: { name, code, domain, adminEmail, status: status || 'Active', plan: plan || 'Basic', timezone: validateTimezone(timezone) },
    });

    await tx.user.create({
      data: {
        name: `Admin - ${name}`,
        email: adminEmail,
        passwordHash,
        role: 'ADMIN',
        status: 'Pending',
        resetToken,
        resetTokenExpiry,
        organizationId: newOrg.id,
      },
    });

    return newOrg;
  });

  try {
    const url = frontendUrl || process.env.FRONTEND_URL || 'http://localhost:3000';
    await sendAdminActivationEmail(adminEmail, `Admin - ${name}`, resetToken, url);
  } catch (error) {
    console.error('Failed to send activation email:', error);
  }

  res.status(201).json(org);
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, code, domain, adminEmail, status, plan, timezone } = req.body;
  const org = await prisma.organization.update({
    where: { id },
    data: { name, code, domain, adminEmail, status, plan, timezone: timezone !== undefined ? validateTimezone(timezone) : undefined },
  });
  res.json(org);
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.organization.delete({ where: { id } });
  res.json({ success: true });
});

module.exports = { list, create, update, remove };
