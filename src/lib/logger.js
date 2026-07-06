const pino = require('pino');
const { consoleSummaryStream, dailyFileStream } = require('./logStreams');

const options = {
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'hextorq-examinations-api', environment: process.env.NODE_ENV || 'development' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.currentPassword', 'req.body.newPassword', 'req.body.token', '*.password', '*.token'],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

module.exports = pino(options, pino.multistream([
  { level: options.level, stream: consoleSummaryStream },
  { level: options.level, stream: dailyFileStream },
]));
