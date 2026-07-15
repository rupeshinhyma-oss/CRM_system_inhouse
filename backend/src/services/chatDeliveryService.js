/**
 * ============================================================================
 * CHAT DELIVERY SERVICE
 * ============================================================================
 * This is the persistence + delivery-tracking core of the chat redesign.
 * It is deliberately kept separate from sockets/index.js: the socket layer
 * is just a *transport* — it should never be the only place a message's
 * fate is decided. Every function here works even if no socket is
 * connected, which is what makes offline delivery and reconnection sync
 * possible instead of accidental.
 *
 * DESIGN NOTES (why it's built this way):
 *
 * 1. MESSAGE PERSISTENCE HAPPENS BEFORE DELIVERY, ALWAYS.
 *    A message document is written to Mongo (status PENDING) before any
 *    socket.emit happens. If the process crashes between "saved" and
 *    "delivered", the message still exists and will be picked up by the
 *    next sync/drain — it never silently disappears. This is the "outbox"
 *    idea applied directly to the messages collection itself: we don't
 *    need a separate outbox table because `messages` + `messageDeliveries`
 *    already IS the outbox (every row that isn't fully delivered is,
 *    by definition, an outstanding outbox entry).
 *
 * 2. PER-RECIPIENT DELIVERY ROWS (messageDeliveries collection).
 *    A DIRECT conversation has exactly one recipient; a GROUP conversation
 *    can have many. A single `status` field on the message itself can't
 *    represent "delivered to Alice, still pending for Bob". So every
 *    message fans out into one `messageDeliveries` row per recipient,
 *    each independently tracking PENDING -> DELIVERED -> READ (or FAILED).
 *    The message's own `status` field is then a derived rollup:
 *      - SENT       -> persisted, fan-out rows created
 *      - DELIVERED  -> every recipient's row is DELIVERED or further
 *      - READ       -> every recipient's row is READ
 *      - FAILED     -> fan-out could not be created (rare; DB error)
 *
 * 3. IDEMPOTENCY.
 *    Every send carries a client-generated `clientMessageId` (uuid, made
 *    once per compose, survives retries). It's stored as a unique index
 *    alongside conversationId, so a dropped-ack retry from the client
 *    calling chat:send again with the same clientMessageId returns the
 *    ORIGINAL message instead of inserting a duplicate. This is the
 *    same idempotency-key pattern the additional recommendations asked
 *    for, applied specifically to message sends.
 *
 * 4. OFFLINE QUEUEING + RECONNECT SYNC.
 *    We don't need a separate "queue" data structure for offline
 *    recipients — a PENDING messageDeliveries row *is* the queue entry.
 *    `drainPendingDeliveriesForUser(uid)` is called the moment a user's
 *    socket (re)connects; it finds every PENDING row for them across all
 *    conversations and pushes the messages, marking each DELIVERED as it
 *    goes. `syncSince(uid, conversationId, sinceIso)` covers the case
 *    where the client reconnects and asks "what did I miss between my
 *    last known message and now" — this recovers missed events even if
 *    the socket connection itself never dropped from the server's point
 *    of view (e.g. a laptop sleep where the OS silently killed the
 *    socket without a clean disconnect).
 * ============================================================================
 */

const { v4: uuidv4 } = require('uuid');
const repo = require('../db');
const { nowIso } = require('../utils/time');

function publicSender(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

/** All userIds who should receive a message in this conversation, excluding the sender. */
async function recipientsFor(conv, senderId) {
  if (conv.type === 'DIRECT') {
    const other = conv.userAId === senderId ? conv.userBId : conv.userAId;
    return other ? [other] : [];
  }
  const members = await repo.list('groupMembers', { groupId: conv.groupId });
  return members.map((m) => m.userId).filter((uid) => uid !== senderId);
}

async function conversationForUser(conv, uid) {
  if (conv.type === 'DIRECT') return conv.userAId === uid || conv.userBId === uid;
  return !!(await repo.findOne('groupMembers', { groupId: conv.groupId, userId: uid }));
}

/**
 * Persists a message + its per-recipient delivery fan-out. Idempotent on
 * (conversationId, clientMessageId) — a retried call with the same pair
 * returns the original message untouched instead of creating a duplicate.
 *
 * Returns { message, deliveries, isDuplicate }.
 */
async function sendMessage({ conversationId, senderId, content, replyToId, clientMessageId, attachments }) {
  if (!clientMessageId) throw Object.assign(new Error('clientMessageId is required for idempotent sends'), { status: 400 });

  // Idempotency check FIRST, before any write, so a retry is a pure read.
  const existing = await repo.findOne('messages', { conversationId, clientMessageId });
  if (existing) {
    const deliveries = await repo.list('messageDeliveries', { messageId: existing.id });
    return { message: existing, deliveries, isDuplicate: true };
  }

  const conv = await repo.findById('conversations', conversationId);
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  if (!(await conversationForUser(conv, senderId))) {
    throw Object.assign(new Error('Not a member of this conversation'), { status: 403 });
  }
  if (!content || !content.trim()) throw Object.assign(new Error('Message content is required'), { status: 400 });

  const now = nowIso();
  const message = await repo.insert('messages', {
    id: uuidv4(),
    conversationId,
    senderId,
    content: content.trim(),
    replyToId: replyToId || null,
    forwardedFromId: null,
    clientMessageId,
    status: 'PENDING', // rolled up from deliveries once fan-out is created below
    edited: false,
    deleted: false,
    pinned: false,
    starredBy: [],
    reactions: [],
    attachments: attachments || [],
    createdAt: now,
    editedAt: null,
  });

  const recipients = await recipientsFor(conv, senderId);
  const deliveries = [];
  for (const userId of recipients) {
    deliveries.push(await repo.insert('messageDeliveries', {
      id: uuidv4(),
      messageId: message.id,
      conversationId,
      userId,
      status: 'PENDING', // -> DELIVERED -> READ, or FAILED
      deliveredAt: null,
      readAt: null,
      createdAt: now,
    }));
  }

  // Recipients present (e.g. sole participant already left) still counts as SENT,
  // not FAILED — nobody to deliver to isn't a delivery failure.
  const rolledUpStatus = recipients.length === 0 ? 'SENT' : 'SENT';
  const updated = await repo.updateById('messages', message.id, { status: rolledUpStatus });
  await repo.updateById('conversations', conversationId, { lastMessageAt: now });

  return { message: updated, deliveries, isDuplicate: false };
}

/** Marks one recipient's delivery row DELIVERED, and rolls up the parent message's status. */
async function markDelivered(messageId, userId) {
  const row = await repo.findOne('messageDeliveries', { messageId, userId });
  if (!row) return null;
  if (row.status === 'READ' || row.status === 'DELIVERED') return row; // already further along, don't regress
  const updated = await repo.updateById('messageDeliveries', row.id, { status: 'DELIVERED', deliveredAt: nowIso() });
  await rollUpMessageStatus(messageId);
  return updated;
}

/** Marks one recipient's delivery row READ, and rolls up the parent message's status. */
async function markRead(messageId, userId) {
  const row = await repo.findOne('messageDeliveries', { messageId, userId });
  if (!row) return null;
  const updated = await repo.updateById('messageDeliveries', row.id, {
    status: 'READ',
    deliveredAt: row.deliveredAt || nowIso(),
    readAt: nowIso(),
  });
  await rollUpMessageStatus(messageId);
  return updated;
}

/** Recomputes message.status from its deliveries: DELIVERED/READ only once EVERY recipient reaches that stage. */
async function rollUpMessageStatus(messageId) {
  const deliveries = await repo.list('messageDeliveries', { messageId });
  if (deliveries.length === 0) return;
  const allRead = deliveries.every((d) => d.status === 'READ');
  const allDeliveredOrBeyond = deliveries.every((d) => d.status === 'READ' || d.status === 'DELIVERED');
  let status = 'SENT';
  if (allDeliveredOrBeyond) status = 'DELIVERED';
  if (allRead) status = 'READ';
  await repo.updateById('messages', messageId, { status });
}

/**
 * Called when a user's socket (re)connects. Finds every PENDING delivery
 * row for them (their offline queue) and returns the full messages so the
 * caller (sockets/index.js) can push them down the fresh connection and
 * mark each DELIVERED. This is what makes offline recipients catch up
 * automatically instead of losing messages sent while they were away.
 */
async function drainPendingDeliveriesForUser(userId) {
  const pending = await repo.list('messageDeliveries', { userId, status: 'PENDING' });
  const results = [];
  for (const delivery of pending) {
    const message = await repo.findById('messages', delivery.messageId);
    if (!message || message.deleted) {
      // Message was deleted before it could ever be delivered — clear the
      // stuck queue entry rather than leaving a dangling PENDING row forever.
      await repo.updateById('messageDeliveries', delivery.id, { status: 'DELIVERED', deliveredAt: nowIso() });
      continue;
    }
    const sender = await repo.findById('users', message.senderId);
    results.push({ ...message, sender: publicSender(sender) });
    await markDelivered(message.id, userId);
  }
  return results;
}

/**
 * Reconnection / catch-up sync: everything in a conversation created after
 * `sinceIso` that the user hasn't necessarily seen, regardless of whether a
 * messageDeliveries row was ever pending (covers the "socket died silently,
 * server never saw a disconnect" case, not just the "recipient was fully
 * offline" case).
 */
async function syncSince(conversationId, uid, sinceIso) {
  const conv = await repo.findById('conversations', conversationId);
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  if (!(await conversationForUser(conv, uid))) {
    throw Object.assign(new Error('Not a member of this conversation'), { status: 403 });
  }
  let msgs = (await repo.list('messages', { conversationId })).filter((m) => !m.deleted);
  if (sinceIso) msgs = msgs.filter((m) => new Date(m.createdAt) > new Date(sinceIso));
  msgs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const withSenders = [];
  for (const m of msgs) {
    withSenders.push({ ...m, sender: publicSender(await repo.findById('users', m.senderId)) });
    // Any message the sync surfaces to this user, mark delivered for them.
    if (m.senderId !== uid) await markDelivered(m.id, uid);
  }
  return withSenders;
}

module.exports = {
  recipientsFor,
  conversationForUser,
  sendMessage,
  markDelivered,
  markRead,
  rollUpMessageStatus,
  drainPendingDeliveriesForUser,
  syncSince,
  publicSender,
};
