const express = require('express');
const repo = require('../../db');
const { requireAuth, requirePermission } = require('../../middleware/authGuards');
const { ok, fail } = require('../../utils/respond');
const chat = require('../../services/chatDeliveryService');

const router = express.Router();

function publicSender(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

// GET /api/v1/conversations — every conversation the current user belongs to, within their org
router.get('/conversations', requireAuth, requirePermission('chat.view'), async (req, res) => {
  const all = await repo.list('conversations');
  const candidates = all.filter((c) => c.orgId === req.user.orgId || c.crossOrgLinkId);
  const mine = [];
  for (const c of candidates) if (await chat.conversationForUser(c, req.user.uid)) mine.push(c);

  const enriched = [];
  for (const c of mine) {
    let title, avatarUrl;
    if (c.type === 'DIRECT') {
      const otherId = c.userAId === req.user.uid ? c.userBId : c.userAId;
      const other = await repo.findById('users', otherId);
      title = other ? other.displayName : 'Unknown user';
      avatarUrl = other?.avatarUrl || null;
    } else {
      const group = await repo.findById('groups', c.groupId);
      title = group?.name || 'Group';
      avatarUrl = group?.avatarUrl || null;
    }
    const msgs = await repo.list('messages', { conversationId: c.id });
    const lastMessage = msgs.length ? msgs.reduce((a, b) => (new Date(a.createdAt) > new Date(b.createdAt) ? a : b)) : null;

    // Unread count: messages not sent by me whose delivery row for me isn't READ yet.
    const myDeliveries = await repo.list('messageDeliveries', { conversationId: c.id, userId: req.user.uid });
    const unreadCount = myDeliveries.filter((d) => d.status !== 'READ').length;

    enriched.push({ ...c, title, avatarUrl, lastMessage, unreadCount });
  }

  enriched.sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt));
  ok(res, enriched);
});

// POST /api/v1/conversations/direct  { userId } — get-or-create a DM (same org only)
router.post('/conversations/direct', requireAuth, requirePermission('chat.send'), async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return fail(res, 400, 'userId is required');
  if (userId === req.user.uid) return fail(res, 400, "Can't start a conversation with yourself");

  const otherUser = await repo.findById('users', userId);
  if (!otherUser || otherUser.orgId !== req.user.orgId) return fail(res, 403, 'Can only DM users within your own organization');

  const allDirect = await repo.list('conversations', { type: 'DIRECT' });
  const existing = allDirect.find((c) =>
    (c.userAId === req.user.uid && c.userBId === userId) || (c.userAId === userId && c.userBId === req.user.uid));
  if (existing) return ok(res, existing);

  const { v4: uuidv4 } = require('uuid');
  const { nowIso } = require('../../utils/time');
  const conversation = await repo.insert('conversations', {
    id: uuidv4(), orgId: req.user.orgId, type: 'DIRECT', groupId: null,
    userAId: req.user.uid, userBId: userId, crossOrgLinkId: null, lastMessageAt: null, createdAt: nowIso(),
  });
  res.status(201).json({ data: conversation });
});

// GET /api/v1/conversations/:id/messages?before=&limit=
router.get('/conversations/:id/messages', requireAuth, requirePermission('chat.view'), async (req, res) => {
  const conv = await repo.findById('conversations', req.params.id);
  if (!conv) return fail(res, 404, 'Conversation not found');
  if (!(await chat.conversationForUser(conv, req.user.uid))) return fail(res, 403, 'Not a member of this conversation');

  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  let msgs = (await repo.list('messages', { conversationId: conv.id })).filter((m) => !m.deleted);
  if (req.query.before) msgs = msgs.filter((m) => new Date(m.createdAt) < new Date(req.query.before));
  msgs = msgs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);

  const withSenders = [];
  for (const m of msgs.reverse()) {
    const deliveries = await repo.list('messageDeliveries', { messageId: m.id });
    withSenders.push({ ...m, sender: publicSender(await repo.findById('users', m.senderId)), deliveries });
    // Viewing the conversation implicitly marks messages from others as delivered to me.
    if (m.senderId !== req.user.uid) await chat.markDelivered(m.id, req.user.uid);
  }
  ok(res, withSenders);
});

// GET /api/v1/conversations/:id/sync?since=ISO_TIMESTAMP
// REST fallback for reconnection catch-up (mirrors the socket 'chat:sync_request'
// event) — useful for a client that reconnects to a fresh page load rather than
// a live socket, or as a periodic safety-net poll independent of the socket.
router.get('/conversations/:id/sync', requireAuth, requirePermission('chat.view'), async (req, res) => {
  try {
    const messages = await chat.syncSince(req.params.id, req.user.uid, req.query.since || null);
    ok(res, messages);
  } catch (err) {
    fail(res, err.status || 500, err.message || 'Sync failed');
  }
});

// GET /api/v1/conversations/:id/search?q=
router.get('/conversations/:id/search', requireAuth, requirePermission('chat.view'), async (req, res) => {
  const conv = await repo.findById('conversations', req.params.id);
  if (!conv) return fail(res, 404, 'Conversation not found');
  if (!(await chat.conversationForUser(conv, req.user.uid))) return fail(res, 403, 'Not a member of this conversation');

  const q = (req.query.q || '').toLowerCase();
  const msgs = (await repo.list('messages', { conversationId: conv.id })).filter((m) => !m.deleted && m.content.toLowerCase().includes(q));
  const withSenders = [];
  for (const m of msgs) withSenders.push({ ...m, sender: publicSender(await repo.findById('users', m.senderId)) });
  ok(res, withSenders);
});

// POST /api/v1/messages/:id/star
router.post('/messages/:id/star', requireAuth, requirePermission('chat.view'), async (req, res) => {
  const msg = await repo.findById('messages', req.params.id);
  if (!msg) return fail(res, 404, 'Message not found');
  const starredBy = new Set(msg.starredBy || []);
  starredBy.add(req.user.uid);
  const updated = await repo.updateById('messages', req.params.id, { starredBy: [...starredBy] });
  ok(res, updated);
});

// POST /api/v1/messages/:id/pin — requires chat.manage
router.post('/messages/:id/pin', requireAuth, requirePermission('chat.manage'), async (req, res) => {
  const updated = await repo.updateById('messages', req.params.id, { pinned: true });
  if (!updated) return fail(res, 404, 'Message not found');
  ok(res, updated);
});

// DELETE /api/v1/messages/:id — requires chat.delete
router.delete('/messages/:id', requireAuth, requirePermission('chat.delete'), async (req, res) => {
  const updated = await repo.updateById('messages', req.params.id, { deleted: true, content: '[deleted]' });
  if (!updated) return fail(res, 404, 'Message not found');
  ok(res, updated);
});

module.exports = router;
