const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const ctrl = require('../controllers/system.controller');

const router = express.Router();
router.use(authenticate, authorize('SUPER_ADMIN', 'ADMIN'));
router.get('/health', ctrl.health);
router.get('/errors', ctrl.errors);
router.get('/deliveries', ctrl.deliveries);

module.exports = router;
