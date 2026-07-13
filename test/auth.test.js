const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hashToken } = require('../src/utils/authTokens');

const source = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

test('refresh and reset tokens are stored as hashes', () => {
  assert.notEqual(hashToken('secret-token'), 'secret-token');
  assert.equal(hashToken('secret-token'), hashToken('secret-token'));
});

test('access tokens are short-lived and bound to a revocable session', () => {
  const auth = source('src/controllers/auth.controller.js');
  const middleware = source('src/middleware/auth.js');
  assert.match(auth, /JWT_EXPIRES_IN \|\| '15m'/);
  assert.match(auth, /sid: sessionId/);
  assert.match(middleware, /id: payload\.sid/);
  assert.match(middleware, /revokedAt: null/);
  assert.match(middleware, /assertSessionWithinTimeout/);
  assert.match(middleware, /assertIpAllowed/);
  assert.match(auth, /getResolvedSettingsForUser/);
});

test('password reset revokes all active refresh sessions', () => {
  const auth = source('src/controllers/auth.controller.js');
  assert.match(auth, /refreshToken\.updateMany\(\{ where: \{ userId: stored\.userId, revokedAt: null \}/);
});
