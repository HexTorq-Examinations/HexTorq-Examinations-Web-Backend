require('dotenv').config();
const app = require('./app');
const { startDeadlineWorker } = require('./workers/deadlineWorker');
const { startBackupWorker } = require('./workers/backupWorker');
const { startLiveMonitorSocket } = require('./realtime/liveMonitorSocket');

const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, () => {
  console.log(`HexTorq Examinations API listening on http://localhost:${PORT}`);
});
const liveMonitorSocket = startLiveMonitorSocket(server);

// Embedded mode is convenient for one persistent API process. In multi-instance
// or serverless deployments, set DEADLINE_WORKER_MODE=external and run
// `npm run worker:deadlines` as a separate continuously-running worker service.
const deadlineWorker = process.env.DEADLINE_WORKER_MODE === 'external'
  ? null
  : startDeadlineWorker({
      pollIntervalMs: Number(process.env.DEADLINE_POLL_INTERVAL_MS) || 2000,
      batchSize: Number(process.env.DEADLINE_BATCH_SIZE) || 25,
    });
const backupWorker = process.env.BACKUP_WORKER_MODE === 'external'
  ? null
  : startBackupWorker({
      pollIntervalMs: Number(process.env.BACKUP_POLL_INTERVAL_MS) || 15 * 60 * 1000,
    });

const shutdown = () => {
  liveMonitorSocket?.close();
  deadlineWorker?.stop();
  backupWorker?.stop();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
