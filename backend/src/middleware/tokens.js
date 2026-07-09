const { v4: uuidv4 } = require('uuid');
const repo = require('../db');
const { nowIso } = require('../utils/time');
const { verifyAccessToken } = require('../middleware/tokens');

const onlineSockets = new Map(); // uid -> Set of socket ids

async function conversationForUser(conv, uid) {
  if (conv.type === 'DIRECT') return conv.userAId === uid || conv.userBId === uid;
  return !!(await repo.findOne('groupMembers', { groupId: conv.groupId, userId: uid }));
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

function registerSocketHandlers(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication token required'));
      const payload = verifyAccessToken(token);
      repo.findById('users', payload.uid).then((user) => {
        if (!user || !user.enabled) return next(new Error('Account not found or disabled'));
        socket.userId = payload.uid;
        socket.orgId = payload.orgId;
        next();
      }).catch(() => next(new Error('Invalid or expired token')));
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', async (socket) => {
    const uid = socket.userId;

    if (!onlineSockets.has(uid)) onlineSockets.set(uid, new Set());
    onlineSockets.get(uid).add(socket.id);

    await repo.updateById('users', uid, { status: 'ONLINE', lastSeenAt: nowIso() });

    socket.join(`user:${uid}`);
    if (socket.orgId) socket.join(`org:${socket.orgId}`);

    const allConversations = await repo.list('conversations');
    for (const c of allConversations) {
      if (await conversationForUser(c, uid)) socket.join(`conversation:${c.id}`);
    }

    if (socket.orgId) io.to(`org:${socket.orgId}`).emit('presence:update', { userId: uid, status: 'ONLINE' });

    socket.on('chat:send', async (payload, ack) => {
      try {
        const { conversationId, content, replyToId } = payload || {};
        const conv = await repo.findById('conversations', conversationId);
        if (!conv) return ack?.({ error: 'Conversation not found' });
        if (!(await conversationForUser(conv, uid))) return ack?.({ error: 'Not a member of this conversation' });
        if (!content || !content.trim()) return ack?.({ error: 'Message content is required' });

        const message = await repo.insert('messages', {
          id: uuidv4(), conversationId, senderId: uid, content: content.trim(),
          replyToId: replyToId || null, forwardedFromId: null, status: 'SENT',
          edited: false, deleted: false, pinned: false, starredBy: [], reactions: [],
          createdAt: nowIso(), editedAt: null,
        });
        await repo.updateById('conversations', conversationId, { lastMessageAt: message.createdAt });

        const sender = await repo.findById('users', uid);
        const outgoing = { ...message, sender: publicUser(sender) };
        io.to(`conversation:${conversationId}`).emit('chat:message', outgoing);
        ack?.({ ok: true, message: outgoing });
      } catch (err) {
        ack?.({ error: 'Failed to send message' });
      }
    });

    socket.on('chat:typing', async ({ conversationId, isTyping }) => {
      const user = await repo.findById('users', uid);
      socket.to(`conversation:${conversationId}`).emit('chat:typing', {
        conversationId, userId: uid, displayName: user?.displayName, isTyping: !!isTyping,
      });
    });

    socket.on('chat:read', async ({ conversationId, messageId }) => {
      await repo.updateById('messages', messageId, { status: 'READ' });
      socket.to(`conversation:${conversationId}`).emit('chat:read', { conversationId, messageId, readBy: uid });
    });

    socket.on('chat:join', async ({ conversationId }) => {
      const conv = await repo.findById('conversations', conversationId);
      if (conv && (await conversationForUser(conv, uid))) socket.join(`conversation:${conversationId}`);
    });

    socket.on('disconnect', async () => {
      const sockets = onlineSockets.get(uid);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineSockets.delete(uid);
          await repo.updateById('users', uid, { status: 'OFFLINE', lastSeenAt: nowIso() });
          if (socket.orgId) io.to(`org:${socket.orgId}`).emit('presence:update', { userId: uid, status: 'OFFLINE' });
        }
      }
    });
  });
}

module.exports = { registerSocketHandlers, onlineSockets };
