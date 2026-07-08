const { v4: uuidv4 } = require('uuid');
const { db, nowIso } = require('../db/db');
const { verifyAccessToken } = require('../middleware/tokens');

const onlineSockets = new Map(); // uid -> Set of socket ids

function conversationForUser(conv, uid) {
  return conv.type === 'DIRECT'
    ? conv.userAId === uid || conv.userBId === uid
    : db.get('groupMembers').find({ groupId: conv.groupId, userId: uid }).value() != null;
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
      const user = db.get('users').find({ id: payload.uid }).value();
      if (!user || !user.enabled) return next(new Error('Account not found or disabled'));
      socket.userId = payload.uid;
      socket.orgId = payload.orgId;
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const uid = socket.userId;

    if (!onlineSockets.has(uid)) onlineSockets.set(uid, new Set());
    onlineSockets.get(uid).add(socket.id);

    db.get('users').find({ id: uid }).assign({ status: 'ONLINE', lastSeenAt: nowIso() }).write();

    socket.join(`user:${uid}`);
    if (socket.orgId) socket.join(`org:${socket.orgId}`);
    db.get('conversations').value()
      .filter((c) => conversationForUser(c, uid))
      .forEach((c) => socket.join(`conversation:${c.id}`));

    // Presence broadcasts only within the user's own org room (never cross-tenant broadcast).
    if (socket.orgId) io.to(`org:${socket.orgId}`).emit('presence:update', { userId: uid, status: 'ONLINE' });

    socket.on('chat:send', (payload, ack) => {
      try {
        const { conversationId, content, replyToId } = payload || {};
        const conv = db.get('conversations').find({ id: conversationId }).value();
        if (!conv) return ack?.({ error: 'Conversation not found' });
        if (!conversationForUser(conv, uid)) return ack?.({ error: 'Not a member of this conversation' });
        if (!content || !content.trim()) return ack?.({ error: 'Message content is required' });

        const message = {
          id: uuidv4(), conversationId, senderId: uid, content: content.trim(),
          replyToId: replyToId || null, forwardedFromId: null, status: 'SENT',
          edited: false, deleted: false, pinned: false, starredBy: [], reactions: [],
          createdAt: nowIso(), editedAt: null,
        };
        db.get('messages').push(message).write();
        db.get('conversations').find({ id: conversationId }).assign({ lastMessageAt: message.createdAt }).write();

        const outgoing = { ...message, sender: publicUser(db.get('users').find({ id: uid }).value()) };
        io.to(`conversation:${conversationId}`).emit('chat:message', outgoing);
        ack?.({ ok: true, message: outgoing });
      } catch (err) {
        ack?.({ error: 'Failed to send message' });
      }
    });

    socket.on('chat:typing', ({ conversationId, isTyping }) => {
      const user = db.get('users').find({ id: uid }).value();
      socket.to(`conversation:${conversationId}`).emit('chat:typing', {
        conversationId, userId: uid, displayName: user?.displayName, isTyping: !!isTyping,
      });
    });

    socket.on('chat:read', ({ conversationId, messageId }) => {
      db.get('messages').find({ id: messageId }).assign({ status: 'READ' }).write();
      socket.to(`conversation:${conversationId}`).emit('chat:read', { conversationId, messageId, readBy: uid });
    });

    socket.on('chat:join', ({ conversationId }) => {
      const conv = db.get('conversations').find({ id: conversationId }).value();
      if (conv && conversationForUser(conv, uid)) socket.join(`conversation:${conversationId}`);
    });

    socket.on('disconnect', () => {
      const sockets = onlineSockets.get(uid);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineSockets.delete(uid);
          db.get('users').find({ id: uid }).assign({ status: 'OFFLINE', lastSeenAt: nowIso() }).write();
          if (socket.orgId) io.to(`org:${socket.orgId}`).emit('presence:update', { userId: uid, status: 'OFFLINE' });
        }
      }
    });
  });
}

module.exports = { registerSocketHandlers, onlineSockets };
