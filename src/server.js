require('dotenv').config();
const app = require('./app');
const { finalizeExpiredAttempts } = require('./controllers/examAttempts.controller');

const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, () => {
  console.log(`HexTorq Examinations API listening on http://localhost:${PORT}`);
});

// Server-authoritative exam expiry. This continues to finalize and score attempts
// when every student browser is backgrounded, offline, closed, or shut down.
const sweepExpiredAttempts = () => {
  finalizeExpiredAttempts().catch((error) => {
    console.error('Failed to finalize expired exam attempts', error);
  });
};
sweepExpiredAttempts();
const expiryTimer = setInterval(sweepExpiredAttempts, 5000);
expiryTimer.unref();

const shutdown = () => {
  clearInterval(expiryTimer);
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
