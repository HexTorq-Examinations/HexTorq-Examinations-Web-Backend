require('dotenv').config();
const prisma = require('./lib/prisma');
const { startDeadlineWorker } = require('./workers/deadlineWorker');

const worker = startDeadlineWorker({
  pollIntervalMs: Number(process.env.DEADLINE_POLL_INTERVAL_MS) || 2000,
  batchSize: Number(process.env.DEADLINE_BATCH_SIZE) || 25,
});

console.log(`Deadline worker started: ${worker.workerId}`);

const shutdown = async () => {
  worker.stop();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
