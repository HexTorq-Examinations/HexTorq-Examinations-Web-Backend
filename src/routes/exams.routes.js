const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const ctrl = require('../controllers/exams.controller');
const attemptCtrl = require('../controllers/examAttempts.controller');

const router = express.Router();

router.use(authenticate);

// Exam-taking flow (any authenticated user, primarily students)
router.get('/history/me', attemptCtrl.myHistory);
router.get('/:id/take', attemptCtrl.getExamForTaking);
router.post('/:id/start', attemptCtrl.startAttempt);
router.post('/:id/answer', attemptCtrl.saveAnswer);
router.post('/:id/violation', attemptCtrl.recordViolation);
router.post('/:id/submit', attemptCtrl.submitAttempt);

// Exam management (admin / super admin)
router.get('/', authorize('SUPER_ADMIN', 'ADMIN'), ctrl.list);
router.post('/', authorize('SUPER_ADMIN', 'ADMIN'), ctrl.create);
router.patch('/:id', authorize('SUPER_ADMIN', 'ADMIN'), ctrl.update);
router.delete('/:id', authorize('SUPER_ADMIN', 'ADMIN'), ctrl.remove);

module.exports = router;
