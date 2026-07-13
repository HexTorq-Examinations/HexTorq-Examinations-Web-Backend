const jwt = require('jsonwebtoken');
const ApiError = require('../utils/ApiError');
const prisma = require('../lib/prisma');
const { getResolvedSettingsForUser } = require('../utils/platformSettings');
const { assertIpAllowed, assertSessionWithinTimeout } = require('../utils/runtimeSecurity');

const authenticate = async (req, res, next) => {
  let authenticatedUser = null;
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new ApiError(401, 'Authentication token missing');

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.sid) throw new ApiError(401, 'Session is no longer valid');
    const session = await prisma.refreshToken.findFirst({
      where: { id: payload.sid, userId: payload.sub, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (!session) throw new ApiError(401, 'Session is no longer valid');
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new ApiError(401, 'User no longer exists');
    authenticatedUser = user;
    if (user.status !== 'Active') throw new ApiError(403, 'Account is not active');
    if (['ADMIN', 'STUDENT'].includes(user.role) && !user.organizationId) {
      throw new ApiError(403, 'Account is not assigned to an organization');
    }
    const settings = await getResolvedSettingsForUser(user);
    assertSessionWithinTimeout({ user, settings });
    assertIpAllowed({ req, settings, user });

    req.user = user;
    next();
  } catch (err) {
    if (err instanceof ApiError && /Session timed out/i.test(err.message) && authenticatedUser?.id) {
      await prisma.refreshToken.updateMany({ where: { userId: authenticatedUser.id, revokedAt: null }, data: { revokedAt: new Date() } }).catch(() => {});
    }
    if (err instanceof ApiError) return next(err);
    next(new ApiError(401, 'Invalid or expired token'));
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new ApiError(403, 'You do not have permission to perform this action'));
  }
  next();
};

module.exports = { authenticate, authorize };
