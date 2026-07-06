const crypto = require('crypto');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');

const sendAlert = async (payload) => {
  if (!process.env.ALERT_WEBHOOK_URL) return;
  const response = await fetch(process.env.ALERT_WEBHOOK_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Alert webhook returned ${response.status}`);
};

const trackError = async (error, req, statusCode) => {
  const path = req.originalUrl || req.path || 'unknown';
  const fingerprint = crypto.createHash('sha256').update(`${error.name}:${error.message}`).digest('hex').slice(0, 32);
  try {
    const tracked = await prisma.systemError.upsert({
      where: { fingerprint_path: { fingerprint, path } },
      update: { occurrences: { increment: 1 }, lastSeenAt: new Date(), stack: error.stack },
      create: {
        fingerprint, path, message: error.message || 'Unknown error', stack: error.stack,
        method: req.method, statusCode, userId: req.user?.id, organizationId: req.user?.organizationId,
      },
    });
    if (statusCode >= 500) {
      sendAlert({ type: 'api_error', severity: 'error', fingerprint, message: tracked.message, path, occurrences: tracked.occurrences })
        .catch((alertError) => logger.error({ err: alertError, fingerprint }, 'failed to send alert'));
    }
  } catch (trackingError) {
    logger.error({ err: trackingError, originalError: error.message }, 'failed to persist system error');
  }
};

module.exports = { trackError, sendAlert };
