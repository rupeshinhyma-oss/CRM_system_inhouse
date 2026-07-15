/**
 * ============================================================================
 * CHAT SOCKET LAYER — enterprise-grade redesign
 * ============================================================================
 * Responsibilities kept deliberately narrow: this file is TRANSPORT only.
 * All persistence, delivery-status tracking, and idempotency logic lives in
 * services/chatDeliveryService.js, so a message's fate never depends on a
 * socket being connected when it's sent. See that file's header comment for
 * the full design rationale.
 *
 * What this file adds on top of the transport:
 *
 *  - RECONNECTION CATCH-UP: on every connection (fresh or reconnect), we
 *    drain that user's pending (offline-queued) deliveries AND run a
 *    conversation-level sync for any conversation the client says it has
 *    stale data for. Both paths are idempotent to call repeatedly.
 *
 *  - PRESENCE: ONLINE / OFFLINE / AWAY, tracked per-user (not per-socket)
 *    since one user can have multiple tabs/devices open. AWAY is a
 *    client-reported state (tab hidden / idle), not inferred here.
 *
 *  - DUPLICATE / RACE PROTECTION: chat:send requires a clientMessageId;
 *    sendMessage() in the delivery service is idempotent on it, so a
 *    dropped ack + client retry never creates two messages. Delivery and
 *    read receipts use findOne+update (not insert), so they're naturally
 *    idempotent too — marking something DELIVERED twice is a no-op.
 * ============================================================================
 */

const repo = require('../db');
const { nowIso } = require('../utils/time');
const { verifyAccessToken } = require('../middleware/tokens');
const chat = require('../services/chatDeliveryService');

// uid -> Set of socket ids. A user counts as ONLINE if this set is non-empty.
const onlineSockets = new Map();
// uid -> 'ONLINE' | 'AWAY' (OFFLINE is represented by absence from onlineSockets)
const presenceOverride = new Map();

function currentPresence(uid) {
  if (!onlineSockets.has(uid) || onlineSockets.get(uid).size === 0) return 'OFFLINE';
  return presenceOverride.get(uid) || 'ONLINE';
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

    const wasOffline = onlineSockets.get(uid).size === 1; // this is the first socket for this user
    await repo.updateById('users', uid, { status: 'ONLINE', lastSeenAt: nowIso() });

    socket.join(`user:${uid}`);
    if (socket.orgId) socket.join(`org:${socket.orgId}`);

    const allConversations = await repo.list('conversations');
    const myConversations = [];
    for (const c of allConversations) {
      if (await chat.conversationForUser(c, uid)) {
        socket.join(`conversation:${c.id}`);
        myConversations.push(c);
      }
    }

    if (wasOffline && socket.orgId) {
      io.to(`org:${socket.orgId}`).emit('presence:update', { userId: uid, status: 'ONLINE' });
    }

    // --- RECONNECTION CATCH-UP #1: drain anything queued while this user was offline ---
    try {
      const delivered = await chat.drainPendingDeliveriesForUser(uid);
      if (delivered.length) {
        socket.emit('chat:sync', { reason: 'offline-queue', messages: delivered });
      }
    } catch (err) {
      // Never let a sync failure prevent the connection itself from completing.
      socket.emit('chat:sync-error', { reason: 'offline-queue', error: 'Failed to sync queued messages' });
    }

    // --- RECONNECTION CATCH-UP #2: client-driven "what did I miss since X" ---
    // The client tracks the createdAt of the last message it rendered per
    // conversation and replays this on every (re)connect. Covers silent
    // disconnects (e.g. laptop sleep) that never queued a delivery because
    // the server didn't know the socket was gone yet.
    socket.on('chat:sync_request', async ({ cursors } = {}, ack) => {
      try {
        const results = {};
        for (const [conversationId, sinceIso] of Object.entries(cursors || {})) {
          results[conversationId] = await chat.syncSince(conversationId, uid, sinceIso);
        }
        ack?.({ ok: true, results });
      } catch (err) {
        ack?.({ error: err.message || 'Sync failed' });
      }
    });

    socket.on('chat:send', async (payload, ack) => {
      try {
        const { conversationId, content, replyToId, clientMessageId, attachments } = payload || {};
        const { message, deliveries, isDuplicate } = await chat.sendMessage({
          conversationId, senderId: uid, content, replyToId, clientMessageId, attachments,
        });

        const sender = await repo.findById('users', uid);
        const outgoing = { ...message, sender: chat.publicSender(sender) };

        if (!isDuplicate) {
          // Fan out to everyone in the room. For recipients with an active
          // socket in this room, mark their delivery DELIVERED immediately
          // (they'll actually receive the emit below in the same tick).
          io.to(`conversation:${conversationId}`).emit('chat:message', outgoing);
          for (const d of deliveries) {
            if (currentPresence(d.userId) !== 'OFFLINE') {
              await chat.markDelivered(message.id, d.userId);
            }
            // else: stays PENDING, will be drained on their next connect.
          }
        }
        ack?.({ ok: true, message: outgoing, duplicate: isDuplicate });
      } catch (err) {
        ack?.({ error: err.message || 'Failed to send message' });
      }
    });

    socket.on('chat:typing', async ({ conversationId, isTyping }) => {
      const user = await repo.findById('users', uid);
      socket.to(`conversation:${conversationId}`).emit('chat:typing', {
        conversationId, userId: uid, displayName: user?.displayName, isTyping: !!isTyping,
      });
    });

    socket.on('chat:delivered', async ({ messageId }) => {
      const updated = await chat.markDelivered(messageId, uid);
      if (updated) {
        const msg = await repo.findById('messages', updated.messageId);
        io.to(`conversation:${msg.conversationId}`).emit('chat:delivered', { messageId, userId: uid });
      }
    });

    socket.on('chat:read', async ({ conversationId, messageId }) => {
      const updated = await chat.markRead(messageId, uid);
      if (updated) {
        socket.to(`conversation:${conversationId}`).emit('chat:read', { conversationId, messageId, readBy: uid });
      }
    });

    socket.on('chat:join', async ({ conversationId }) => {
      const conv = await repo.findById('conversations', conversationId);
      if (conv && (await chat.conversationForUser(conv, uid))) socket.join(`conversation:${conversationId}`);
    });

    // Client reports tab hidden / user idle. Distinct from OFFLINE, which is
    // only ever inferred from every socket disconnecting.
    socket.on('presence:set', ({ status }) => {
      if (!['ONLINE', 'AWAY', 'BUSY', 'INVISIBLE'].includes(status)) return;
      presenceOverride.set(uid, status);
      if (socket.orgId) {
        io.to(`org:${socket.orgId}`).emit('presence:update', { userId: uid, status: currentPresence(uid) });
      }
    });

    socket.on('disconnect', async () => {
      const sockets = onlineSockets.get(uid);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineSockets.delete(uid);
          presenceOverride.delete(uid);
          await repo.updateById('users', uid, { status: 'OFFLINE', lastSeenAt: nowIso() });
          if (socket.orgId) io.to(`org:${socket.orgId}`).emit('presence:update', { userId: uid, status: 'OFFLINE' });
        }
      }
    });
  });
}

module.exports = { registerSocketHandlers, onlineSockets, currentPresence };
