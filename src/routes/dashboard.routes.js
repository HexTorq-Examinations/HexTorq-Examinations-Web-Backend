const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const ctrl = require('../controllers/dashboard.controller');

const router = express.Router();

router.use(authenticate);

router.get('/super-admin', authorize('SUPER_ADMIN'), ctrl.superAdminStats);
router.get('/admin', authorize('SUPER_ADMIN', 'ADMIN'), ctrl.adminStats);
router.get('/overview', authorize('SUPER_ADMIN', 'ADMIN'), ctrl.getOverview);

module.exports = router;
