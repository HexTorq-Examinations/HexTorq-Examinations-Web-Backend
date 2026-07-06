require('dotenv').config();
const app = require('./app');
const { startDeadlineWorker } = require('./workers/deadlineWorker');

const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, () => {
  console.log(`HexTorq Examinations API listening on http://localhost:${PORT}`);
});

// Embedded mode is convenient for one persistent API process. In multi-instance
// or serverless deployments, set DEADLINE_WORKER_MODE=external and run
// `npm run worker:deadlines` as a separate continuously-running worker service.
const deadlineWorker = process.env.DEADLINE_WORKER_MODE === 'external'
  ? null
  : startDeadlineWorker({
      pollIntervalMs: Number(process.env.DEADLINE_POLL_INTERVAL_MS) || 2000,
      batchSize: Number(process.env.DEADLINE_BATCH_SIZE) || 25,
    });

const shutdown = () => {
  deadlineWorker?.stop();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
