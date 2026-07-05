const express = require('express');
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/messaging.controller');

const router = express.Router();

router.use(authenticate);

router.get('/searchable-users', ctrl.searchableUsers);
router.get('/conversations', ctrl.listConversations);
router.post('/conversations', ctrl.startConversation);
router.get('/conversations/:id/messages', ctrl.getMessages);
router.post('/conversations/:id/messages', ctrl.sendMessage);
router.get('/unread-count', ctrl.unreadCount);
router.get('/notifications', ctrl.notifications);

module.exports = router;
