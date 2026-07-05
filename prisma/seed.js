const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();
const DEMO_PASSWORD = 'password123';

async function main() {
  console.log('Seeding database...');
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  // Organizations
  const techU = await prisma.organization.upsert({
    where: { code: 'TECH-U' },
    update: {},
    create: {
      name: 'Tech University',
      code: 'TECH-U',
      domain: 'techu.edu',
      adminEmail: 'admin@example.com',
      status: 'Active',
      plan: 'Enterprise',
    },
  });

  await prisma.organization.upsert({
    where: { code: 'GLOBAL' },
    update: {},
    create: {
      name: 'Global Institute',
      code: 'GLOBAL',
      domain: 'global.edu',
      adminEmail: 'it@global.edu',
      status: 'Active',
      plan: 'Pro',
    },
  });

  // Users: super admin, org admin, student
  const superAdmin = await prisma.user.upsert({
    where: { email: 'superadmin@example.com' },
    update: {},
    create: {
      name: 'Super Admin',
      email: 'superadmin@example.com',
      passwordHash,
      role: 'SUPER_ADMIN',
      employeeId: 'EMP-001',
      avatar: 'https://github.com/shadcn.png',
    },
  });

  const orgAdmin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      name: 'Org Admin',
      email: 'admin@example.com',
      passwordHash,
      role: 'ADMIN',
      employeeId: 'EMP-002',
      organizationId: techU.id,
      avatar: 'https://github.com/shadcn.png',
    },
  });

  const student1 = await prisma.user.upsert({
    where: { email: 'student@example.com' },
    update: {},
    create: {
      name: 'Test Student',
      email: 'student@example.com',
      passwordHash,
      role: 'STUDENT',
      organizationId: techU.id,
      avatar: 'https://github.com/shadcn.png',
      studentProfile: {
        create: { registerNumber: 'ENR-2026-001', department: 'Computer Science', semester: 'Semester 5' },
      },
    },
  });

  await prisma.user.upsert({
    where: { email: 'bob@example.com' },
    update: {},
    create: {
      name: 'Bob Smith',
      email: 'bob@example.com',
      passwordHash,
      role: 'STUDENT',
      organizationId: techU.id,
      phone: '555-5678',
      studentProfile: {
        create: { registerNumber: 'ENR-2026-002', department: 'Mathematics', semester: 'Semester 3' },
      },
    },
  });

  await prisma.user.upsert({
    where: { email: 'charlie@example.com' },
    update: {},
    create: {
      name: 'Charlie Davis',
      email: 'charlie@example.com',
      passwordHash,
      role: 'STUDENT',
      organizationId: techU.id,
      phone: '555-9012',
      status: 'Inactive',
      studentProfile: {
        create: { registerNumber: 'ENR-2026-003', department: 'Physics', semester: 'Semester 1' },
      },
    },
  });

  // Questions
  const q1 = await prisma.question.create({
    data: {
      text: 'What is the time complexity of a binary search tree lookup in the worst case?',
      subject: 'Data Structures',
      type: 'Multiple Choice',
      difficulty: 'Medium',
      marks: 5,
      options: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'],
      correctAnswer: 2,
      organizationId: techU.id,
    },
  });

  const q2 = await prisma.question.create({
    data: {
      text: 'Which of the following is NOT a valid HTTP method?',
      subject: 'Web Development',
      type: 'Multiple Choice',
      difficulty: 'Easy',
      marks: 2,
      options: ['GET', 'POST', 'PUSH', 'DELETE'],
      correctAnswer: 2,
      organizationId: techU.id,
    },
  });

  // Exams
  const exam1 = await prisma.exam.create({
    data: {
      title: 'Data Structures Final',
      subject: 'Computer Science',
      duration: 120,
      totalMarks: 100,
      passingMarks: 40,
      status: 'Active',
      startDate: new Date('2026-10-25T14:00:00Z'),
      endDate: new Date('2026-10-25T16:00:00Z'),
      shuffleQuestions: true,
      negativeMarking: false,
      organizationId: techU.id,
      examQuestions: { create: [{ questionId: q1.id }] },
    },
  });

  const exam2 = await prisma.exam.create({
    data: {
      title: 'React Fundamentals',
      subject: 'Web Development',
      duration: 60,
      totalMarks: 50,
      passingMarks: 25,
      status: 'Draft',
      startDate: new Date('2026-11-01T10:00:00Z'),
      endDate: new Date('2026-11-01T11:00:00Z'),
      shuffleQuestions: false,
      negativeMarking: false,
      organizationId: techU.id,
      examQuestions: { create: [{ questionId: q2.id }] },
    },
  });

  // Schedule
  await prisma.schedule.create({
    data: {
      examId: exam1.id,
      batch: '2024-2028',
      department: 'Computer Science',
      date: new Date('2026-10-25'),
      startTime: '14:00',
      endTime: '16:00',
      hall: 'Virtual Hall A',
      status: 'Scheduled',
      organizationId: techU.id,
    },
  });

  // Result
  await prisma.result.create({
    data: {
      examId: exam1.id,
      totalStudents: 120,
      status: 'Pending Evaluation',
      organizationId: techU.id,
    },
  });

  console.log('Seed complete. Demo accounts (password: %s):', DEMO_PASSWORD);
  console.log('  Super Admin: superadmin@example.com');
  console.log('  Admin:       admin@example.com');
  console.log('  Student:     student@example.com');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
