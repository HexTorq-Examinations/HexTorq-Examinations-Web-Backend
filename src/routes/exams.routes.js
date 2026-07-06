const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const ctrl = require('../controllers/exams.controller');
const attemptCtrl = require('../controllers/examAttempts.controller');
const questionsRouter = require('./questions.routes');

const router = express.Router();

router.use(authenticate);

// Per-exam questions: /api/exams/:examId/questions/...
router.use('/:examId/questions', questionsRouter);

// Exam-taking flow (any authenticated user, primarily students)
router.get('/history/me', authorize('STUDENT'), attemptCtrl.myHistory);
router.get('/:id/take', authorize('STUDENT'), attemptCtrl.getExamForTaking);
router.get('/:id/my-attempt', authorize('STUDENT'), attemptCtrl.myAttemptStatus);
router.get('/:id/scorecard.pdf', authorize('STUDENT'), attemptCtrl.myScorecard);
router.post('/:id/start', authorize('STUDENT'), attemptCtrl.startAttempt);
router.post('/:id/answer', authorize('STUDENT'), attemptCtrl.saveAnswer);
router.post('/:id/violation', authorize('STUDENT'), attemptCtrl.recordViolation);
router.post('/:id/submit', authorize('STUDENT'), attemptCtrl.submitAttempt);

// Exam management (admin / super admin)
router.get('/', authorize('SUPER_ADMIN', 'ADMIN'), ctrl.list);
router.get('/:id/preview', authorize('SUPER_ADMIN', 'ADMIN'), ctrl.preview);
router.post('/', authorize('SUPER_ADMIN', 'ADMIN'), ctrl.create);
router.post('/:id/duplicate', authorize('SUPER_ADMIN', 'ADMIN'), ctrl.duplicate);
router.patch('/:id', authorize('SUPER_ADMIN', 'ADMIN'), ctrl.update);
router.delete('/:id', authorize('SUPER_ADMIN', 'ADMIN'), ctrl.remove);

module.exports = router;
