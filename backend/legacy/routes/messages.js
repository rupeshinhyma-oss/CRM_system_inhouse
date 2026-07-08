const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function conversationForUser(conv, uid) {
  return conv.type === 'DIRECT' ? conv.userAId === uid || conv.userBId === uid
    : db.get('groupMembers').find({ groupId: conv.groupId, userId: uid }).value() != null;
}

// GET /api/v1/conversations  -- all conversations the current user belongs to
router.get('/conversations', requireAuth, (req, res) => {
  const all = db.get('conversations').value();
  const mine = all.filter((c) => conversationForUser(c, req.user.uid));

  const enriched = mine.map((c) => {
    let title, avatarUrl;
    if (c.type === 'DIRECT') {
      const otherId = c.userAId === req.user.uid ? c.userBId : c.userAId;
      const other = db.get('users').find({ id: otherId }).value();
      title = other ? `@${other.username}` : 'Unknown user';
      avatarUrl = other?.avatarUrl || null;
    } else {
      const group = db.get('groups').find({ id: c.groupId }).value();
      title = group?.name || 'Group';
      avatarUrl = group?.avatarUrl || null;
    }
    const lastMessage = db.get('messages')
      .filter({ conversationId: c.id })
      .orderBy(['createdAt'], ['desc'])
      .head()
      .value();
    return { ...c, title, avatarUrl, lastMessage: lastMessage || null };
  });

  enriched.sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt));
  res.json(enriched);
});

// POST /api/v1/conversations/direct  { userId }  -- get-or-create a DM
router.post('/conversations/direct', requireAuth, (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (userId === req.user.uid) return res.status(400).json({ error: "Can't start a conversation with yourself" });

  const existing = db.get('conversations')
    .find((c) => c.type === 'DIRECT' &&
      ((c.userAId === req.user.uid && c.userBId === userId) || (c.userAId === userId && c.userBId === req.user.uid)))
    .value();
  if (existing) return res.json(existing);

  const conversation = {
    id: uuidv4(),
    type: 'DIRECT',
    groupId: null,
    userAId: req.user.uid,
    userBId: userId,
    lastMessageAt: null,
    createdAt: new Date().toISOString(),
  };
  db.get('conversations').push(conversation).write();
  res.status(201).json(conversation);
});

// GET /api/v1/conversations/:id/messages?before=<ISO>&limit=50
router.get('/conversations/:id/messages', requireAuth, (req, res) => {
  const conv = db.get('conversations').find({ id: req.params.id }).value();
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!conversationForUser(conv, req.user.uid)) return res.status(403).json({ error: 'Not a member of this conversation' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  let msgs = db.get('messages').filter({ conversationId: conv.id, deleted: false }).value();
  if (req.query.before) msgs = msgs.filter((m) => new Date(m.createdAt) < new Date(req.query.before));
  msgs = msgs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);

  const withSender = msgs.map((m) => ({ ...m, sender: publicSender(m.senderId) })).reverse();
  res.json(withSender);
});

// GET /api/v1/conversations/:id/search?q=budget
router.get('/conversations/:id/search', requireAuth, (req, res) => {
  const conv = db.get('conversations').find({ id: req.params.id }).value();
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!conversationForUser(conv, req.user.uid)) return res.status(403).json({ error: 'Not a member of this conversation' });

  const q = (req.query.q || '').toLowerCase();
  const results = db.get('messages')
    .filter((m) => m.conversationId === conv.id && !m.deleted && m.content.toLowerCase().includes(q))
    .value();
  res.json(results.map((m) => ({ ...m, sender: publicSender(m.senderId) })));
});

// POST /api/v1/messages/:id/star
router.post('/messages/:id/star', requireAuth, (req, res) => {
  const msg = db.get('messages').find({ id: req.params.id }).value();
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  msg.starredBy = msg.starredBy || [];
  if (!msg.starredBy.includes(req.user.uid)) msg.starredBy.push(req.user.uid);
  db.get('messages').find({ id: req.params.id }).assign(msg).write();
  res.json(msg);
});

// POST /api/v1/messages/:id/pin
router.post('/messages/:id/pin', requireAuth, (req, res) => {
  const updated = db.get('messages').find({ id: req.params.id }).assign({ pinned: true }).write();
  if (!updated) return res.status(404).json({ error: 'Message not found' });
  res.json(updated);
});

function publicSender(senderId) {
  const u = db.get('users').find({ id: senderId }).value();
  if (!u) return null;
  const { passwordHash, email, ...safe } = u;
  return safe;
}

module.exports = router;
