const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');

const superAdminStats = asyncHandler(async (req, res) => {
  const [totalOrganizations, totalStudents, totalAdmins, activeExams] = await Promise.all([
    prisma.organization.count(),
    prisma.user.count({ where: { role: 'STUDENT' } }),
    prisma.user.count({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } }),
    prisma.exam.count({ where: { status: 'Active' } }),
  ]);
  res.json({ totalOrganizations, totalStudents, totalAdmins, activeExams });
});

const adminStats = asyncHandler(async (req, res) => {
  const orgFilter = req.user.organizationId ? { organizationId: req.user.organizationId } : {};
  const [totalStudents, activeExams, totalExams] = await Promise.all([
    prisma.user.count({ where: { role: 'STUDENT', ...orgFilter } }),
    prisma.exam.count({ where: { status: 'Active', ...orgFilter } }),
    prisma.exam.count({ where: orgFilter }),
  ]);
  res.json({ totalStudents, activeExams, totalExams });
});

module.exports = { superAdminStats, adminStats };
