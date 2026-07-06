const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const pinoHttp = require('pino-http');
const logger = require('./lib/logger');
const { administrativeAudit } = require('./middleware/auditLog');

const authRoutes = require('./routes/auth.routes');
const organizationRoutes = require('./routes/organizations.routes');
const adminRoutes = require('./routes/admins.routes');
const studentRoutes = require('./routes/students.routes');
const examRoutes = require('./routes/exams.routes');
const examMappingRoutes = require('./routes/examMappings.routes');
const resultRoutes = require('./routes/results.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const userRoutes = require('./routes/users.routes');
const messagingRoutes = require('./routes/messaging.routes');
const batchRoutes = require('./routes/batches.routes');
const schoolRoutes = require('./routes/schools.routes');
const departmentRoutes = require('./routes/departments.routes');
const classRoutes = require('./routes/classes.routes');
const auditLogRoutes = require('./routes/auditLogs.routes');
const systemRoutes = require('./routes/system.routes');

const app = express();

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  strictTransportSecurity: process.env.NODE_ENV === 'production' ? undefined : false,
}));

// CORS_ORIGIN="*"            -> allow any origin (testing only, see .env)
// CORS_ORIGIN="a.com,b.com"  -> allow only those origins (comma-separated)
const defaultOrigins = [process.env.FRONTEND_URL, 'http://localhost:3000'].filter(Boolean).join(',');
const allowedOrigins = (process.env.CORS_ORIGIN || defaultOrigins)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
}));
app.use(pinoHttp({ logger, genReqId: (req, res) => req.headers['x-request-id'] || crypto.randomUUID() }));
app.use(express.json());
app.use(administrativeAudit);
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/time', (req, res) => res.json({ now: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/admins', adminRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/exams', examRoutes);
app.use('/api/exam-mappings', examMappingRoutes);
app.use('/api/results', resultRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/users', userRoutes);
app.use('/api/messages', messagingRoutes);
app.use('/api/batches', batchRoutes);
app.use('/api/schools', schoolRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/audit-logs', auditLogRoutes);
app.use('/api/system', systemRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
