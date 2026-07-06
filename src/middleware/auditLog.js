const prisma = require('../lib/prisma');

const SENSITIVE_KEYS = new Set(['password', 'newPassword', 'currentPassword', 'token', 'refreshToken', 'authorization']);

const sanitize = (value, depth = 0) => {
  if (depth > 4) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEYS.has(key) ? '[REDACTED]' : sanitize(item, depth + 1),
  ]));
};

const administrativeAudit = (req, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  res.on('finish', () => {
    if (!req.user || !['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) return;
    const details = sanitize(req.body || {});
    const serialized = JSON.stringify(details);
    prisma.auditLog.create({
      data: {
        actorId: req.user.id,
        actorEmail: req.user.email,
        actorRole: req.user.role,
        organizationId: req.user.organizationId || null,
        action: `${req.method} ${req.baseUrl || ''}${req.route?.path || req.path}`,
        path: req.originalUrl,
        statusCode: res.statusCode,
        targetId: req.params?.id || req.params?.examId || null,
        details: serialized.length <= 10_000 ? details : { truncated: true },
        ipAddress: req.ip,
        userAgent: req.get('user-agent') || null,
      },
    }).catch((error) => console.error('Failed to write administrative audit log', error));
  });
  next();
};

module.exports = { administrativeAudit };
