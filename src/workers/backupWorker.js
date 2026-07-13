const os = require('os');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { getResolvedSettings } = require('../utils/platformSettings');
const { backupFiles, createDatabaseBackup } = require('../utils/backupService');

const createWorkerId = () => `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;

const dueThresholdMs = (frequency) => {
  if (frequency === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  if (frequency === 'monthly') return 30 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
};

const startBackupWorker = ({ pollIntervalMs = 15 * 60 * 1000 } = {}) => {
  const workerId = createWorkerId();
  let stopped = false;
  let timer = null;
  let running = false;

  const heartbeat = (data = {}) => prisma.workerHeartbeat.upsert({
    where: { id: workerId },
    update: { status: 'RUNNING', lastSeenAt: new Date(), stoppedAt: null, ...data },
    create: { id: workerId, workerType: 'BACKUP', hostname: os.hostname(), processId: process.pid, ...data },
  });

  const poll = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await heartbeat();
      const settings = await getResolvedSettings({ includeGlobal: true });
      const latest = backupFiles()[0];
      const ageMs = latest ? Date.now() - new Date(latest.createdAt).getTime() : Number.POSITIVE_INFINITY;
      if (ageMs >= dueThresholdMs(settings.backupFrequency)) {
        const backup = await createDatabaseBackup({
          includeMedia: settings.includeMedia,
          trigger: `scheduled:${settings.backupFrequency}`,
        });
        await heartbeat({ lastJobAt: new Date(), jobsProcessed: { increment: 1 }, lastError: null });
        logger.info({ workerId, backup: backup.name, includeMedia: backup.includeMedia }, 'scheduled backup completed');
      }
    } catch (error) {
      logger.error({ err: error, workerId }, 'backup worker poll failed');
      await heartbeat({ lastError: error instanceof Error ? error.message.slice(0, 2000) : String(error) }).catch(() => {});
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(poll, pollIntervalMs);
    }
  };

  poll();

  return {
    workerId,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      prisma.workerHeartbeat.updateMany({
        where: { id: workerId },
        data: { status: 'STOPPED', stoppedAt: new Date(), lastSeenAt: new Date() },
      }).catch(() => {});
    },
  };
};

module.exports = { startBackupWorker };
