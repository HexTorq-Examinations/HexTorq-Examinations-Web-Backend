const express = require('express');
const cors = require('cors');
const path = require('path');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const requestLogger = require('./middleware/requestLogger');

const authRoutes = require('./routes/auth.routes');
const organizationRoutes = require('./routes/organizations.routes');
const adminRoutes = require('./routes/admins.routes');
const studentRoutes = require('./routes/students.routes');
const questionRoutes = require('./routes/questions.routes');
const examRoutes = require('./routes/exams.routes');
const scheduleRoutes = require('./routes/schedules.routes');
const resultRoutes = require('./routes/results.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const userRoutes = require('./routes/users.routes');

const app = express();

// CORS_ORIGIN="*"            -> allow any origin (testing only, see .env)
// CORS_ORIGIN="a.com,b.com"  -> allow only those origins (comma-separated)
const corsOriginSetting = process.env.CORS_ORIGIN || 'http://localhost:3000';
const corsOrigin = corsOriginSetting === '*'
  ? true
  : corsOriginSetting.split(',').map((o) => o.trim());

app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));
app.use(requestLogger);
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/admins', adminRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/exams', examRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/results', resultRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/users', userRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
