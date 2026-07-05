// Colorized console request logger: timestamp, method, path, status, response time.
// Uses raw ANSI escape codes (no dependency) so it works in any standard terminal.
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const METHOD_COLORS = {
  GET: COLORS.blue,
  POST: COLORS.magenta,
  PATCH: COLORS.yellow,
  PUT: COLORS.cyan,
  DELETE: COLORS.red,
};

const colorForStatus = (status) => {
  if (status >= 500) return COLORS.red;
  if (status >= 400) return COLORS.yellow;
  if (status >= 300) return COLORS.cyan;
  if (status >= 200) return COLORS.green;
  return COLORS.gray;
};

const colorForDuration = (ms) => {
  if (ms >= 1000) return COLORS.red;
  if (ms >= 300) return COLORS.yellow;
  return COLORS.green;
};

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  const timestamp = new Date().toISOString();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const methodColor = METHOD_COLORS[req.method] || COLORS.gray;
    const statusColor = colorForStatus(res.statusCode);
    const durationColor = colorForDuration(durationMs);

    console.log(
      `${COLORS.gray}[${timestamp}]${COLORS.reset} ` +
      `${methodColor}${COLORS.bold}${req.method.padEnd(6)}${COLORS.reset} ` +
      `${req.originalUrl} ` +
      `${statusColor}${COLORS.bold}${res.statusCode}${COLORS.reset} ` +
      `${COLORS.dim}-${COLORS.reset} ` +
      `${durationColor}${durationMs.toFixed(1)}ms${COLORS.reset}`
    );
  });

  next();
}

module.exports = requestLogger;
