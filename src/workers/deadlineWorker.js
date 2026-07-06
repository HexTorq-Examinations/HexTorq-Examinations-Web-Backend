const os = require('os');
const crypto = require('crypto');
const { processDeadlineJobs } = require('../controllers/examAttempts.controller');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');

const createWorkerId = () => `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;

const startDeadlineWorker = ({ pollIntervalMs = 2000, batchSize = 25 } = {}) => {
  const workerId = createWorkerId();
  let stopped = false;
  let timer = null;

  const heartbeat = (data = {}) => prisma.workerHeartbeat.upsert({
    where: { id: workerId },
    update: { status: 'RUNNING', lastSeenAt: new Date(), stoppedAt: null, ...data },
    create: { id: workerId, workerType: 'DEADLINE', hostname: os.hostname(), processId: process.pid, ...data },
  });

  const poll = async () => {
    if (stopped) return;
    try {
      await heartbeat();
      let claimed;
      let processed = 0;
      do {
        claimed = await processDeadlineJobs(workerId, batchSize);
        processed += claimed;
      } while (!stopped && claimed === batchSize);
      await heartbeat(processed > 0 ? { lastJobAt: new Date(), jobsProcessed: { increment: processed }, lastError: null } : {});
    } catch (error) {
      logger.error({ err: error, workerId }, 'deadline worker poll failed');
      await heartbeat({ lastError: error instanceof Error ? error.message.slice(0, 2000) : String(error) }).catch(() => {});
    } finally {
      if (!stopped) timer = setTimeout(poll, pollIntervalMs);
    }
  };

  poll();

  return {
    workerId,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      prisma.workerHeartbeat.updateMany({ where: { id: workerId }, data: { status: 'STOPPED', stoppedAt: new Date(), lastSeenAt: new Date() } }).catch(() => {});
    },
  };
};

module.exports = { startDeadlineWorker };
