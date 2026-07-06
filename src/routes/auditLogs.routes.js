const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const ctrl = require('../controllers/auditLogs.controller');

const router = express.Router();
router.use(authenticate, authorize('SUPER_ADMIN', 'ADMIN'));
router.get('/', ctrl.list);

module.exports = router;
