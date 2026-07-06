const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

const colors = {
  reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m', gray: '\x1b[90m',
};
const paint = (color, value) => process.env.NO_COLOR ? String(value) : `${colors[color]}${value}${colors.reset}`;
const levelName = (level) => level >= 60 ? 'FATAL' : level >= 50 ? 'ERROR' : level >= 40 ? 'WARN' : level >= 30 ? 'INFO' : 'DEBUG';
const statusColor = (status) => status >= 500 ? 'red' : status >= 400 ? 'yellow' : status >= 300 ? 'cyan' : 'green';
const methodColor = (method) => ({ GET: 'cyan', POST: 'green', PUT: 'yellow', PATCH: 'yellow', DELETE: 'red' }[method] || 'magenta');

class ConsoleSummaryStream extends Writable {
  _write(chunk, encoding, callback) {
    try {
      const log = JSON.parse(chunk.toString());
      const time = new Date(log.time || Date.now()).toLocaleTimeString('en-GB', { hour12: false });
      if (log.req && log.res) {
        const method = log.req.method || 'HTTP';
        const requestPath = log.req.url || log.req.originalUrl || '-';
        const status = log.res.statusCode || 0;
        const duration = Number.isFinite(log.responseTime) ? `${log.responseTime}ms` : '-';
        process.stdout.write(`${paint('gray', time)} ${paint(methodColor(method), method.padEnd(6))} ${requestPath} ${paint(statusColor(status), status)} ${paint('dim', duration)}\n`);
      } else {
        const level = levelName(log.level || 30);
        const color = log.level >= 50 ? 'red' : log.level >= 40 ? 'yellow' : 'gray';
        process.stdout.write(`${paint('gray', time)} ${paint(color, level.padEnd(5))} ${log.msg || ''}\n`);
      }
      callback();
    } catch (error) {
      process.stdout.write(chunk);
      callback();
    }
  }
}

class DailyFileStream extends Writable {
  constructor(logDirectory) {
    super();
    this.logDirectory = logDirectory;
    this.currentDay = null;
    this.destination = null;
    fs.mkdirSync(logDirectory, { recursive: true });
  }

  destinationForToday() {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.currentDay) {
      this.destination?.end();
      this.currentDay = day;
      this.destination = fs.createWriteStream(path.join(this.logDirectory, `api-${day}.log`), { flags: 'a' });
    }
    return this.destination;
  }

  _write(chunk, encoding, callback) {
    const destination = this.destinationForToday();
    if (destination.write(chunk, encoding)) callback();
    else destination.once('drain', callback);
  }

  _final(callback) {
    if (!this.destination) return callback();
    this.destination.end(callback);
  }
}

module.exports = {
  consoleSummaryStream: new ConsoleSummaryStream(),
  dailyFileStream: new DailyFileStream(path.resolve(process.env.LOG_DIR || path.join(process.cwd(), 'logs'))),
};
