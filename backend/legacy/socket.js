const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const { verifyToken } = require('./middleware/auth');

// uid -> Set of socket ids (a user can have multiple tabs/devices open)
const onlineSockets = new Map();

function conversationForUser(conv, uid) {
  return conv.type === 'DIRECT'
    ? conv.userAId === uid || conv.userBId === uid
    : db.get('groupMembers').find({ groupId: conv.groupId, userId: uid }).value() != null;
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, email, ...safe } = u;
  return safe;
}

function registerSocketHandlers(io) {
  // Auth handshake: client connects with `auth: { token }`
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication token required'));
      const payload = verifyToken(token);
      socket.userId = payload.uid;
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const uid = socket.userId;

    // --- presence: mark online, join a personal room + every conversation room ---
    if (!onlineSockets.has(uid)) onlineSockets.set(uid, new Set());
    onlineSockets.get(uid).add(socket.id);

    db.get('users').find({ id: uid }).assign({ status: 'ONLINE', lastSeenAt: new Date().toISOString() }).write();

    socket.join(`user:${uid}`);
    db.get('conversations').value()
      .filter((c) => conversationForUser(c, uid))
      .forEach((c) => socket.join(`conversation:${c.id}`));

    io.emit('presence:update', { userId: uid, status: 'ONLINE' });

    // --- chat.send: { conversationId, content, replyToId? } ---
    socket.on('chat:send', (payload, ack) => {
      try {
        const { conversationId, content, replyToId } = payload || {};
        const conv = db.get('conversations').find({ id: conversationId }).value();
        if (!conv) return ack?.({ error: 'Conversation not found' });
        if (!conversationForUser(conv, uid)) return ack?.({ error: 'Not a member of this conversation' });
        if (!content || !content.trim()) return ack?.({ error: 'Message content is required' });

        const message = {
          id: uuidv4(),
          conversationId,
          senderId: uid,
          content: content.trim(),
          replyToId: replyToId || null,
          forwardedFromId: null,
          status: 'SENT',
          edited: false,
          deleted: false,
          pinned: false,
          starredBy: [],
          reactions: [],
          createdAt: new Date().toISOString(),
          editedAt: null,
        };
        db.get('messages').push(message).write();
        db.get('conversations').find({ id: conversationId }).assign({ lastMessageAt: message.createdAt }).write();

        const outgoing = { ...message, sender: publicUser(db.get('users').find({ id: uid }).value()) };
        io.to(`conversation:${conversationId}`).emit('chat:message', outgoing);

        // Notify offline-of-this-conversation members (mentions/new DM) via personal room too
        ack?.({ ok: true, message: outgoing });
      } catch (err) {
        ack?.({ error: 'Failed to send message' });
      }
    });

    // --- chat.typing: { conversationId, isTyping } ---
    socket.on('chat:typing', ({ conversationId, isTyping }) => {
      const user = db.get('users').find({ id: uid }).value();
      socket.to(`conversation:${conversationId}`).emit('chat:typing', {
        conversationId,
        userId: uid,
        username: user?.username,
        isTyping: !!isTyping,
      });
    });

    // --- chat.read: { conversationId, messageId } ---
    socket.on('chat:read', ({ conversationId, messageId }) => {
      db.get('messages').find({ id: messageId }).assign({ status: 'READ' }).write();
      socket.to(`conversation:${conversationId}`).emit('chat:read', { conversationId, messageId, readBy: uid });
    });

    // --- chat.join: join a newly-created conversation room without reconnecting ---
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
          db.get('users').find({ id: uid }).assign({ status: 'OFFLINE', lastSeenAt: new Date().toISOString() }).write();
          io.emit('presence:update', { userId: uid, status: 'OFFLINE' });
        }
      }
    });
  });
}

module.exports = { registerSocketHandlers, onlineSockets };
