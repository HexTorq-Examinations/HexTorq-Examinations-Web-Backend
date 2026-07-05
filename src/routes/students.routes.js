const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadQuestionsFile } = require('../middleware/importUpload');
const ctrl = require('../controllers/students.controller');

const router = express.Router();

router.use(authenticate, authorize('SUPER_ADMIN', 'ADMIN'));

router.get('/', ctrl.list);
router.get('/template', ctrl.downloadTemplate);
router.post('/', ctrl.create);
router.post('/import', uploadQuestionsFile.single('file'), ctrl.importFromFile);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
