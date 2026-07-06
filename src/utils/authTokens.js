const crypto = require('crypto');
const prisma = require('../lib/prisma');

const REFRESH_COOKIE = 'hextorq_refresh';
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const randomToken = () => crypto.randomBytes(48).toString('base64url');

const cookieOptions = () => {
  const secure = process.env.NODE_ENV === 'production' || process.env.REFRESH_COOKIE_SECURE === 'true';
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    path: '/api/auth',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
};

const readCookie = (req, name) => {
  const cookies = (req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
};

const issueRefreshToken = async (userId, res) => {
  const raw = randomToken();
  const stored = await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(raw),
      userId,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  res.cookie(REFRESH_COOKIE, raw, cookieOptions());
  return { raw, id: stored.id };
};

const clearRefreshCookie = (res) => res.clearCookie(REFRESH_COOKIE, cookieOptions());

const createPasswordResetToken = async (userId, requestedById = null) => {
  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
  const raw = randomToken();
  await prisma.passwordResetToken.create({
    data: {
      tokenHash: hashToken(raw),
      userId,
      requestedById,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return raw;
};

module.exports = {
  REFRESH_COOKIE, hashToken, readCookie, issueRefreshToken, clearRefreshCookie, createPasswordResetToken,
};
