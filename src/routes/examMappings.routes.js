const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const ctrl = require('../controllers/examMappings.controller');

const router = express.Router();

router.use(authenticate);

router.get('/mine', ctrl.mine); // any authenticated student

router.get('/', authorize('ADMIN'), ctrl.list);
router.post('/', authorize('ADMIN'), ctrl.create);
router.patch('/:id', authorize('ADMIN'), ctrl.update);
router.delete('/:id', authorize('ADMIN'), ctrl.remove);

module.exports = router;
