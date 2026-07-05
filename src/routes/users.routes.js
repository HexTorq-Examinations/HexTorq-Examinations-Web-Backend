const express = require('express');
const { authenticate } = require('../middleware/auth');
const { uploadAvatar } = require('../middleware/upload');
const ctrl = require('../controllers/users.controller');

const router = express.Router();

router.use(authenticate);

router.patch('/me', ctrl.updateMe);
router.post('/me/password', ctrl.changePassword);
router.post('/me/avatar', uploadAvatar.single('avatar'), ctrl.uploadAvatar);

module.exports = router;
