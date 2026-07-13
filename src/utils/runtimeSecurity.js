const ApiError = require('./ApiError');
const logger = require('../lib/logger');

const normalizeIp = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/^::ffff:/, '').split('%')[0];
};

const extractRequestIp = (req) => {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0];
  return normalizeIp(forwarded || req.ip || req.socket?.remoteAddress || '');
};

const configuredWhitelist = () => String(process.env.IP_WHITELIST || '')
  .split(',')
  .map((value) => normalizeIp(value))
  .filter(Boolean);

const isIpAllowed = (ip, allowlist) => allowlist.includes('*') || allowlist.includes(normalizeIp(ip));

const assertIpAllowed = ({ req, settings, user }) => {
  if (!settings?.ipWhitelistEnabled) return;
  const allowlist = configuredWhitelist();
  if (allowlist.length === 0) {
    logger.warn({ userId: user?.id, role: user?.role }, 'ip whitelist enabled without IP_WHITELIST entries');
    throw new ApiError(503, 'IP whitelist is enabled but no allowed IPs are configured');
  }
  const ip = extractRequestIp(req);
  if (!isIpAllowed(ip, allowlist)) {
    throw new ApiError(403, 'Access from this network is not allowed');
  }
};

const assertSessionWithinTimeout = ({ user, settings }) => {
  const timeoutMinutes = Number(settings?.sessionTimeoutMinutes) || 30;
  const loginAt = user?.lastLoginAt ? new Date(user.lastLoginAt) : null;
  if (!loginAt || Number.isNaN(loginAt.getTime())) return;
  const timeoutAt = loginAt.getTime() + timeoutMinutes * 60 * 1000;
  if (Date.now() > timeoutAt) {
    throw new ApiError(401, 'Session timed out. Please sign in again');
  }
};

module.exports = {
  normalizeIp,
  extractRequestIp,
  configuredWhitelist,
  isIpAllowed,
  assertIpAllowed,
  assertSessionWithinTimeout,
};
