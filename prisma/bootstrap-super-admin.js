// Creates exactly one Super Admin account and nothing else — no demo orgs,
// students, questions, or exams. Use this for a real/production database
// instead of prisma/seed.js (which is full of throwaway demo data).
//
// Usage:
//   SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD=change-me node prisma/bootstrap-super-admin.js
//
// If SUPER_ADMIN_EMAIL/PASSWORD are omitted, it falls back to
// superadmin@example.com / password123 — change the password immediately
// after logging in if you rely on the default.
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL || 'superadmin@example.com';
  const password = process.env.SUPER_ADMIN_PASSWORD || 'password123';
  const name = process.env.SUPER_ADMIN_NAME || 'Super Admin';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`A user with email ${email} already exists (role: ${existing.role}). Nothing to do.`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role: 'SUPER_ADMIN', employeeId: 'EMP-001' },
  });

  console.log('Super Admin created:');
  console.log(`  Email:    ${user.email}`);
  console.log(`  Password: ${password}`);
  console.log('Log in and change this password immediately if you used the default.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
