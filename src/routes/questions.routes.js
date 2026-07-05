const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadQuestionsFile } = require('../middleware/importUpload');
const ctrl = require('../controllers/questions.controller');

// Mounted at /api/exams/:examId/questions (mergeParams so :examId is visible here)
const router = express.Router({ mergeParams: true });

router.use(authenticate, authorize('SUPER_ADMIN', 'ADMIN'));

router.get('/', ctrl.list);
router.get('/template', ctrl.downloadTemplate);
router.post('/', ctrl.create);
router.post('/bulk', ctrl.bulkCreate);
router.post('/import', uploadQuestionsFile.single('file'), ctrl.importFromFile);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
