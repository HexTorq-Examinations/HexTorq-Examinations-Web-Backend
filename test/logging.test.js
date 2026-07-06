const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('request logs use concise console and detailed daily file streams', () => {
  const logger = source('src/lib/logger.js');
  const streams = source('src/lib/logStreams.js');
  assert.match(logger, /pino\.multistream/);
  assert.match(streams, /ConsoleSummaryStream/);
  assert.match(streams, /DailyFileStream/);
  assert.match(streams, /api-\$\{day\}\.log/);
  assert.match(streams, /log\.req\.url/);
  assert.match(streams, /log\.responseTime/);
});

test('sensitive request credentials remain redacted', () => {
  const logger = source('src/lib/logger.js');
  assert.match(logger, /req\.headers\.authorization/);
  assert.match(logger, /req\.headers\.cookie/);
  assert.match(logger, /req\.body\.currentPassword/);
  assert.match(logger, /req\.body\.newPassword/);
});
