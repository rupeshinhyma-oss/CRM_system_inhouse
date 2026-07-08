const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, nowIso } = require('../../db/db');
const { requireAuth, requirePermission } = require('../../middleware/authGuards');
const { ok, created, fail } = require('../../utils/respond');

const router = express.Router();

function conversationForUser(conv, uid) {
  return conv.type === 'DIRECT'
    ? conv.userAId === uid || conv.userBId === uid
    : db.get('groupMembers').find({ groupId: conv.groupId, userId: uid }).value() != null;
}

function publicSender(senderId) {
  const u = db.get('users').find({ id: senderId }).value();
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

// GET /api/v1/conversations — every conversation the current user belongs to, within their org
// (cross-org shared conversations carry crossOrgLinkId and are included regardless of orgId match).
router.get('/conversations', requireAuth, requirePermission('chat.view'), (req, res) => {
  const all = db.get('conversations').value();
  const mine = all.filter((c) => (c.orgId === req.user.orgId || c.crossOrgLinkId) && conversationForUser(c, req.user.uid));

  const enriched = mine.map((c) => {
    let title, avatarUrl;
    if (c.type === 'DIRECT') {
      const otherId = c.userAId === req.user.uid ? c.userBId : c.userAId;
      const other = db.get('users').find({ id: otherId }).value();
      title = other ? other.displayName : 'Unknown user';
      avatarUrl = other?.avatarUrl || null;
    } else {
      const group = db.get('groups').find({ id: c.groupId }).value();
      title = group?.name || 'Group';
      avatarUrl = group?.avatarUrl || null;
    }
    const lastMessage = db.get('messages').filter({ conversationId: c.id }).orderBy(['createdAt'], ['desc']).head().value();
    return { ...c, title, avatarUrl, lastMessage: lastMessage || null };
  });

  enriched.sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt));
  ok(res, enriched);
});

// POST /api/v1/conversations/direct  { userId } — get-or-create a DM (same org only; cross-org DMs go through sharing grants)
router.post('/conversations/direct', requireAuth, requirePermission('chat.send'), (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return fail(res, 400, 'userId is required');
  if (userId === req.user.uid) return fail(res, 400, "Can't start a conversation with yourself");

  const otherUser = db.get('users').find({ id: userId }).value();
  if (!otherUser || otherUser.orgId !== req.user.orgId) return fail(res, 403, 'Can only DM users within your own organization');

  const existing = db.get('conversations')
    .find((c) => c.type === 'DIRECT' &&
      ((c.userAId === req.user.uid && c.userBId === userId) || (c.userAId === userId && c.userBId === req.user.uid)))
    .value();
  if (existing) return ok(res, existing);

  const conversation = {
    id: uuidv4(), orgId: req.user.orgId, type: 'DIRECT', groupId: null,
    userAId: req.user.uid, userBId: userId, crossOrgLinkId: null, lastMessageAt: null, createdAt: nowIso(),
  };
  db.get('conversations').push(conversation).write();
  created(res, conversation);
});

// GET /api/v1/conversations/:id/messages?before=&limit=
router.get('/conversations/:id/messages', requireAuth, requirePermission('chat.view'), (req, res) => {
  const conv = db.get('conversations').find({ id: req.params.id }).value();
  if (!conv) return fail(res, 404, 'Conversation not found');
  if (!conversationForUser(conv, req.user.uid)) return fail(res, 403, 'Not a member of this conversation');

  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  let msgs = db.get('messages').filter({ conversationId: conv.id, deleted: false }).value();
  if (req.query.before) msgs = msgs.filter((m) => new Date(m.createdAt) < new Date(req.query.before));
  msgs = msgs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);

  ok(res, msgs.map((m) => ({ ...m, sender: publicSender(m.senderId) })).reverse());
});

// GET /api/v1/conversations/:id/search?q=
router.get('/conversations/:id/search', requireAuth, requirePermission('chat.view'), (req, res) => {
  const conv = db.get('conversations').find({ id: req.params.id }).value();
  if (!conv) return fail(res, 404, 'Conversation not found');
  if (!conversationForUser(conv, req.user.uid)) return fail(res, 403, 'Not a member of this conversation');

  const q = (req.query.q || '').toLowerCase();
  const results = db.get('messages').filter((m) => m.conversationId === conv.id && !m.deleted && m.content.toLowerCase().includes(q)).value();
  ok(res, results.map((m) => ({ ...m, sender: publicSender(m.senderId) })));
});

// POST /api/v1/messages/:id/star
router.post('/messages/:id/star', requireAuth, requirePermission('chat.view'), (req, res) => {
  const msg = db.get('messages').find({ id: req.params.id }).value();
  if (!msg) return fail(res, 404, 'Message not found');
  const starredBy = new Set(msg.starredBy || []);
  starredBy.add(req.user.uid);
  const updated = db.get('messages').find({ id: req.params.id }).assign({ starredBy: [...starredBy] }).write();
  ok(res, updated);
});

// POST /api/v1/messages/:id/pin — requires chat.manage
router.post('/messages/:id/pin', requireAuth, requirePermission('chat.manage'), (req, res) => {
  const updated = db.get('messages').find({ id: req.params.id }).assign({ pinned: true }).write();
  if (!updated) return fail(res, 404, 'Message not found');
  ok(res, updated);
});

// DELETE /api/v1/messages/:id — requires chat.delete
router.delete('/messages/:id', requireAuth, requirePermission('chat.delete'), (req, res) => {
  const updated = db.get('messages').find({ id: req.params.id }).assign({ deleted: true, content: '[deleted]' }).write();
  if (!updated) return fail(res, 404, 'Message not found');
  ok(res, updated);
});

module.exports = router;
