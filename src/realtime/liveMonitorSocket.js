const jwt = require('jsonwebtoken');
const { WebSocket, WebSocketServer } = require('ws');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const ApiError = require('../utils/ApiError');
const { getResolvedSettingsForUser } = require('../utils/platformSettings');
const { assertSessionWithinTimeout } = require('../utils/runtimeSecurity');
const { buildLiveLoginsPayload, buildLiveMonitorPayload } = require('../controllers/results.controller');

const parseAllowedOrigins = () => {
  const defaultOrigins = [process.env.FRONTEND_URL, 'http://localhost:3000'].filter(Boolean).join(',');
  return (process.env.CORS_ORIGIN || defaultOrigins)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
};

const authenticateSocket = async (request) => {
  const url = new URL(request.url, 'http://localhost');
  const token = url.searchParams.get('token');
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
  if (!['SUPER_ADMIN', 'ADMIN'].includes(user.role)) throw new ApiError(403, 'You do not have permission to monitor live exams');
  if (user.status !== 'Active') throw new ApiError(403, 'Account is not active');
  if (user.role === 'ADMIN' && !user.organizationId) throw new ApiError(403, 'Account is not assigned to an organization');

  const settings = await getResolvedSettingsForUser(user);
  assertSessionWithinTimeout({ user, settings });
  return user;
};

const sendJson = (socket, payload) => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
};

const startLiveMonitorSocket = (server) => {
  const allowedOrigins = parseAllowedOrigins();
  const wss = new WebSocketServer({
    noServer: true,
    path: '/ws/live-monitor',
  });

  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/ws/live-monitor') return;

    const origin = request.headers.origin;
    if (origin && !allowedOrigins.includes('*') && !allowedOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      const user = await authenticateSocket(request);
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.user = user;
        wss.emit('connection', ws, request);
      });
    } catch (error) {
      const statusCode = error.statusCode || 401;
      socket.write(`HTTP/1.1 ${statusCode} Unauthorized\r\n\r\n`);
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    let mode = 'both';
    let interval = null;

    const publish = async () => {
      try {
        const includeExams = mode === 'both' || mode === 'exams';
        const includeLogins = mode === 'both' || mode === 'logins';
        const [live, logins] = await Promise.all([
          includeExams ? buildLiveMonitorPayload(ws.user) : Promise.resolve(undefined),
          includeLogins ? buildLiveLoginsPayload(ws.user) : Promise.resolve(undefined),
        ]);
        sendJson(ws, {
          type: 'live-monitor:update',
          serverNow: new Date().toISOString(),
          ...(live ? { live } : {}),
          ...(logins ? { logins } : {}),
        });
      } catch (error) {
        logger.warn({ err: error, userId: ws.user?.id }, 'live monitor websocket publish failed');
        sendJson(ws, { type: 'live-monitor:error', message: 'Unable to refresh live monitor data' });
      }
    };

    const schedule = () => {
      clearInterval(interval);
      interval = setInterval(publish, Number(process.env.LIVE_MONITOR_WS_INTERVAL_MS) || 2000);
    };

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message?.type === 'live-monitor:subscribe') {
          mode = ['exams', 'logins', 'both'].includes(message.mode) ? message.mode : 'both';
          publish();
        }
      } catch {
        // Ignore malformed client messages; the scheduled stream continues.
      }
    });

    ws.on('close', () => clearInterval(interval));
    sendJson(ws, { type: 'live-monitor:connected', serverNow: new Date().toISOString() });
    publish();
    schedule();
  });

  return {
    close: () => wss.close(),
  };
};

module.exports = { startLiveMonitorSocket };
