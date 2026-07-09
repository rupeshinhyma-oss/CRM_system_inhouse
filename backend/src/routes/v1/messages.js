const express = require('express');
const { v4: uuidv4 } = require('uuid');
const repo = require('../../db');
const { nowIso } = require('../../utils/time');
const { requireAuth, requirePermission } = require('../../middleware/authGuards');
const { ok, created, fail } = require('../../utils/respond');

const router = express.Router();

async function conversationForUser(conv, uid) {
  if (conv.type === 'DIRECT') return conv.userAId === uid || conv.userBId === uid;
  return !!(await repo.findOne('groupMembers', { groupId: conv.groupId, userId: uid }));
}

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
  for (const c of candidates) if (await conversationForUser(c, req.user.uid)) mine.push(c);

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
    enriched.push({ ...c, title, avatarUrl, lastMessage });
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

  const conversation = await repo.insert('conversations', {
    id: uuidv4(), orgId: req.user.orgId, type: 'DIRECT', groupId: null,
    userAId: req.user.uid, userBId: userId, crossOrgLinkId: null, lastMessageAt: null, createdAt: nowIso(),
  });
  created(res, conversation);
});

// GET /api/v1/conversations/:id/messages?before=&limit=
router.get('/conversations/:id/messages', requireAuth, requirePermission('chat.view'), async (req, res) => {
  const conv = await repo.findById('conversations', req.params.id);
  if (!conv) return fail(res, 404, 'Conversation not found');
  if (!(await conversationForUser(conv, req.user.uid))) return fail(res, 403, 'Not a member of this conversation');

  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  let msgs = (await repo.list('messages', { conversationId: conv.id })).filter((m) => !m.deleted);
  if (req.query.before) msgs = msgs.filter((m) => new Date(m.createdAt) < new Date(req.query.before));
  msgs = msgs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);

  const withSenders = [];
  for (const m of msgs.reverse()) withSenders.push({ ...m, sender: publicSender(await repo.findById('users', m.senderId)) });
  ok(res, withSenders);
});

// GET /api/v1/conversations/:id/search?q=
router.get('/conversations/:id/search', requireAuth, requirePermission('chat.view'), async (req, res) => {
  const conv = await repo.findById('conversations', req.params.id);
  if (!conv) return fail(res, 404, 'Conversation not found');
  if (!(await conversationForUser(conv, req.user.uid))) return fail(res, 403, 'Not a member of this conversation');

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
