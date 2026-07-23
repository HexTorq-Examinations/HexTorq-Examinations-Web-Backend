const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const ctrl = require('../controllers/results.controller');
const reportsCtrl = require('../controllers/reports.controller');

const router = express.Router();

router.use(authenticate, authorize('SUPER_ADMIN', 'ADMIN'));

router.get('/', ctrl.list);
router.get('/analytics', ctrl.analytics);
router.get('/reports/:type', reportsCtrl.generate);
router.get('/export/all.csv', ctrl.exportAllCsv);
router.get('/export/mapping/:mappingId.csv', ctrl.exportMappingCsv);
router.get('/live', ctrl.liveMonitor);
router.get('/live-logins', ctrl.liveLogins);
router.get('/attempts', ctrl.listAttempts);
router.get('/attempts/:id', ctrl.attemptDetail);
router.get('/attempts/:id/scorecard.pdf', ctrl.attemptPdf);
router.get('/attempts/:id/response.pdf', ctrl.attemptResponsePdf);
router.patch('/attempts/:id/evaluate', ctrl.manualEvaluate);
router.post('/attempts/:id/regrade', ctrl.regrade);
router.post('/attempts/:id/extend', ctrl.extendAttempt);
router.post('/attempts/:id/reset', ctrl.resetAttempt);
router.get('/:id/export.csv', ctrl.exportCsv);
router.get('/:id/export-detailed.csv', ctrl.exportDetailedCsv);
router.post('/:id/publish', ctrl.publish);

module.exports = router;
