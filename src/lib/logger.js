const pino = require('pino');

module.exports = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'hextorq-examinations-api', environment: process.env.NODE_ENV || 'development' },
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'], censor: '[REDACTED]' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
