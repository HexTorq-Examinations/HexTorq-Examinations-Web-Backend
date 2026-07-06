const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { canInitiateDirect, canAddToGroup } = require('../utils/messagingPermissions');

const loadUserWithProfile = (id) => prisma.user.findUnique({ where: { id }, include: { studentProfile: true } });

const userSummary = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  avatar: u.avatar || undefined,
});

// GET /api/messages/searchable-users?q=
// Only returns people the current user is allowed to START a direct conversation
// with (existing conversations can always be replied in regardless of this list).
const searchableUsers = asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  const me = await loadUserWithProfile(req.user.id);

  let candidateWhere = { id: { not: me.id } };
  if (me.role === 'SUPER_ADMIN') {
    // anyone
  } else if (me.role === 'ADMIN') {
    candidateWhere = {
      ...candidateWhere,
      OR: [
        { role: 'SUPER_ADMIN' },
        { role: { in: ['ADMIN', 'STUDENT'] }, organizationId: me.organizationId },
      ],
    };
  } else {
    // STUDENT: only classmates — same org, same Class
    if (!me.studentProfile) return res.json([]);
    candidateWhere = {
      ...candidateWhere,
      role: 'STUDENT',
      organizationId: me.organizationId,
      studentProfile: { classId: me.studentProfile.classId },
    };
  }

  if (q) {
    candidateWhere.AND = [{ OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] }];
  }

  const users = await prisma.user.findMany({ where: candidateWhere, take: 30, orderBy: { name: 'asc' } });
  res.json(users.map(userSummary));
});

// GET /api/messages/conversations
const listConversations = asyncHandler(async (req, res) => {
  const memberships = await prisma.conversationParticipant.findMany({
    where: { userId: req.user.id },
    include: {
      conversation: {
        include: {
          participants: { include: { user: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1, include: { sender: { select: { name: true } } } },
        },
      },
    },
  });

  const result = await Promise.all(memberships.map(async (m) => {
    const conv = m.conversation;
    const otherParticipants = conv.participants.filter((p) => p.userId !== req.user.id).map((p) => userSummary(p.user));
    const lastMessage = conv.messages[0] || null;
    const unreadCount = await prisma.message.count({
      where: {
        conversationId: conv.id,
        senderId: { not: req.user.id },
        createdAt: { gt: m.lastReadAt || new Date(0) },
      },
    });
    return {
      id: conv.id,
      type: conv.type,
      name: conv.type === 'GROUP' ? conv.name : otherParticipants[0]?.name || 'Unknown',
      participants: otherParticipants,
      lastMessage: lastMessage ? { text: lastMessage.text, createdAt: lastMessage.createdAt, senderName: lastMessage.sender.name, isMine: lastMessage.senderId === req.user.id } : null,
      unreadCount,
      joinedAt: m.joinedAt,
    };
  }));

  result.sort((a, b) => {
    const at = a.lastMessage?.createdAt || a.joinedAt;
    const bt = b.lastMessage?.createdAt || b.joinedAt;
    return new Date(bt) - new Date(at);
  });

  res.json(result);
});

// POST /api/messages/conversations
// Direct: { recipientUserId }
// Group (ADMIN/SUPER_ADMIN only): { type: 'GROUP', name, memberUserIds: [] }
const startConversation = asyncHandler(async (req, res) => {
  const { recipientUserId, type, name, memberUserIds } = req.body;
  const me = await loadUserWithProfile(req.user.id);

  if (type === 'GROUP') {
    if (me.role === 'STUDENT') throw new ApiError(403, 'Students cannot create groups');
    if (!name || !Array.isArray(memberUserIds) || memberUserIds.length === 0) {
      throw new ApiError(400, 'name and at least one memberUserIds are required for a group');
    }
    const members = await prisma.user.findMany({ where: { id: { in: memberUserIds } }, include: { studentProfile: true } });
    const invalid = members.find((m) => !canAddToGroup(me, m));
    if (invalid || members.length !== memberUserIds.length) {
      throw new ApiError(403, `You are not allowed to add ${invalid ? invalid.name : 'one of the selected users'} to a group`);
    }

    const conv = await prisma.conversation.create({
      data: {
        type: 'GROUP',
        name,
        createdById: me.id,
        participants: {
          create: [me.id, ...memberUserIds].map((userId) => ({ userId })),
        },
      },
      include: { participants: { include: { user: true } } },
    });
    return res.status(201).json({ id: conv.id, type: conv.type, name: conv.name });
  }

  if (!recipientUserId) throw new ApiError(400, 'recipientUserId is required');
  if (recipientUserId === me.id) throw new ApiError(400, 'You cannot message yourself');

  // Reuse an existing direct conversation between these two if one exists.
  const existing = await prisma.conversation.findFirst({
    where: {
      type: 'DIRECT',
      AND: [
        { participants: { some: { userId: me.id } } },
        { participants: { some: { userId: recipientUserId } } },
      ],
    },
  });
  if (existing) return res.status(200).json({ id: existing.id, type: existing.type });

  const recipient = await loadUserWithProfile(recipientUserId);
  if (!recipient) throw new ApiError(404, 'Recipient not found');
  if (!canInitiateDirect(me, recipient)) {
    throw new ApiError(403, 'You are not allowed to message this person');
  }

  const conv = await prisma.conversation.create({
    data: {
      type: 'DIRECT',
      createdById: me.id,
      participants: { create: [{ userId: me.id }, { userId: recipient.id }] },
    },
  });
  res.status(201).json({ id: conv.id, type: conv.type });
});

const assertParticipant = async (conversationId, userId) => {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!participant) throw new ApiError(403, 'You are not part of this conversation');
  return participant;
};

// GET /api/messages/conversations/:id/messages
const getMessages = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertParticipant(id, req.user.id);

  const messages = await prisma.message.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: { sender: { select: { id: true, name: true } } },
  });

  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId: id, userId: req.user.id } },
    data: { lastReadAt: new Date() },
  });

  res.json(messages.map((m) => ({
    id: m.id,
    text: m.text,
    createdAt: m.createdAt,
    senderId: m.senderId,
    senderName: m.sender.name,
    isMine: m.senderId === req.user.id,
  })));
});

// POST /api/messages/conversations/:id/messages  { text }
const sendMessage = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  if (!text || !text.trim()) throw new ApiError(400, 'text is required');

  await assertParticipant(id, req.user.id);

  const message = await prisma.message.create({
    data: { conversationId: id, senderId: req.user.id, text: text.trim() },
  });

  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId: id, userId: req.user.id } },
    data: { lastReadAt: message.createdAt },
  });

  res.status(201).json({ id: message.id, text: message.text, createdAt: message.createdAt, senderId: message.senderId, isMine: true });
});

// GET /api/messages/unread-count
const unreadCount = asyncHandler(async (req, res) => {
  const memberships = await prisma.conversationParticipant.findMany({ where: { userId: req.user.id } });
  const counts = await Promise.all(memberships.map((m) => prisma.message.count({
    where: { conversationId: m.conversationId, senderId: { not: req.user.id }, createdAt: { gt: m.lastReadAt || new Date(0) } },
  })));
  res.json({ count: counts.reduce((sum, c) => sum + c, 0) });
});

// GET /api/messages/notifications — recent unread messages, shaped for a notification feed
const notifications = asyncHandler(async (req, res) => {
  const memberships = await prisma.conversationParticipant.findMany({
    where: { userId: req.user.id },
    include: { conversation: true },
  });

  const items = (await Promise.all(memberships.map(async (m) => {
    const messages = await prisma.message.findMany({
      where: { conversationId: m.conversationId, senderId: { not: req.user.id }, createdAt: { gt: m.lastReadAt || new Date(0) } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { sender: { select: { name: true } } },
    });
    return messages.map((msg) => ({
      id: msg.id,
      title: m.conversation.type === 'GROUP' ? `New message in "${m.conversation.name}"` : `New message from ${msg.sender.name}`,
      description: msg.text,
      time: msg.createdAt,
      unread: true,
      conversationId: m.conversationId,
    }));
  }))).flat();

  items.sort((a, b) => new Date(b.time) - new Date(a.time));
  res.json(items.slice(0, 30));
});

// Get-or-create the auto-managed announcement group for a Class, syncing
// membership (adding any students not yet in it) and returning its id. Used by
// Exam Mapping to notify a class's students when an exam is scheduled for them.
async function ensureClassGroupConversation(classId, creatorUserId, db = prisma) {
  const cls = await db.class.findUnique({ where: { id: classId } });
  if (!cls) throw new ApiError(404, 'Class not found');

  let conversation = await db.conversation.findUnique({ where: { classId } });
  if (!conversation) {
    conversation = await db.conversation.create({
      data: {
        type: 'GROUP',
        name: `${cls.name} Announcements`,
        classId,
        createdById: creatorUserId,
        participants: { create: [{ userId: creatorUserId }] },
      },
    });
  }

  const students = await db.user.findMany({
    where: { role: 'STUDENT', studentProfile: { classId } },
    select: { id: true },
  });
  const existingParticipants = await db.conversationParticipant.findMany({
    where: { conversationId: conversation.id },
    select: { userId: true },
  });
  const existingIds = new Set(existingParticipants.map((p) => p.userId));
  // Keep every current student in the class subscribed. Also add the admin who is
  // posting this announcement; an existing class group may have been created by a
  // different admin, and postSystemMessage marks the sender's copy as read.
  const requiredParticipants = [{ id: creatorUserId }, ...students];
  const missing = requiredParticipants.filter((participant) => !existingIds.has(participant.id));
  if (missing.length > 0) {
    await db.conversationParticipant.createMany({
      data: missing.map((s) => ({ conversationId: conversation.id, userId: s.id })),
      skipDuplicates: true,
    });
  }

  return conversation.id;
}

async function postSystemMessage(conversationId, senderId, text, db = prisma) {
  const message = await db.message.create({ data: { conversationId, senderId, text } });
  await db.conversationParticipant.updateMany({
    where: { conversationId, userId: senderId },
    data: { lastReadAt: message.createdAt },
  });
  return message;
}

module.exports = {
  searchableUsers, listConversations, startConversation, getMessages, sendMessage, unreadCount, notifications,
  ensureClassGroupConversation, postSystemMessage,
};
