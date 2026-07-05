const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const ctrl = require('../controllers/results.controller');

const router = express.Router();

router.use(authenticate, authorize('SUPER_ADMIN', 'ADMIN'));

router.get('/', ctrl.list);
router.get('/analytics', ctrl.analytics);
router.post('/:id/publish', ctrl.publish);

module.exports = router;
