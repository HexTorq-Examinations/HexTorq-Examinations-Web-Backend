const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');

const health = asyncHandler(async (req, res) => {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 30_000);
  const [workers, pendingJobs, overdueJobs, unresolvedErrors, failedDeliveries] = await Promise.all([
    prisma.workerHeartbeat.findMany({ orderBy: { lastSeenAt: 'desc' } }),
    prisma.attemptDeadlineJob.count({ where: { status: 'PENDING' } }),
    prisma.attemptDeadlineJob.count({ where: { status: 'PENDING', runAt: { lt: now } } }),
    prisma.systemError.count({ where: { resolvedAt: null } }),
    prisma.notificationDelivery.count({ where: { status: 'FAILED' } }),
  ]);
  res.json({
    status: overdueJobs === 0 && workers.some((worker) => worker.status === 'RUNNING' && worker.lastSeenAt >= staleBefore) ? 'healthy' : 'degraded',
    workers: workers.map((worker) => ({ ...worker, stale: worker.lastSeenAt < staleBefore })),
    deadlineQueue: { pending: pendingJobs, overdue: overdueJobs },
    unresolvedErrors,
    failedDeliveries,
    checkedAt: now,
  });
});

const errors = asyncHandler(async (req, res) => {
  const where = req.user.role === 'ADMIN' ? { organizationId: req.user.organizationId } : {};
  res.json(await prisma.systemError.findMany({ where, orderBy: { lastSeenAt: 'desc' }, take: 100 }));
});

const deliveries = asyncHandler(async (req, res) => {
  const where = req.user.role === 'ADMIN' ? { organizationId: req.user.organizationId } : {};
  res.json(await prisma.notificationDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 }));
});

module.exports = { health, errors, deliveries };
