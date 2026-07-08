const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/v1/groups  { name, description, memberIds: [] }
router.post('/', requireAuth, (req, res) => {
  const { name, description, memberIds = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const group = {
    id: uuidv4(),
    name,
    description: description || '',
    avatarUrl: null,
    createdBy: req.user.uid,
    archived: false,
    createdAt: new Date().toISOString(),
  };
  db.get('groups').push(group).write();

  const conversation = {
    id: uuidv4(),
    type: 'GROUP',
    groupId: group.id,
    userAId: null,
    userBId: null,
    lastMessageAt: null,
    createdAt: new Date().toISOString(),
  };
  db.get('conversations').push(conversation).write();

  const memberSet = new Set([req.user.uid, ...memberIds]);
  memberSet.forEach((uid) => {
    db.get('groupMembers')
      .push({
        id: uuidv4(),
        groupId: group.id,
        userId: uid,
        role: uid === req.user.uid ? 'OWNER' : 'MEMBER',
        muted: false,
        pinned: false,
        joinedAt: new Date().toISOString(),
      })
      .write();
  });

  res.status(201).json({ group, conversationId: conversation.id });
});

// GET /api/v1/groups/mine
router.get('/mine', requireAuth, (req, res) => {
  const myMemberships = db.get('groupMembers').filter({ userId: req.user.uid }).value();
  const groups = myMemberships.map((m) => db.get('groups').find({ id: m.groupId }).value()).filter(Boolean);
  res.json(groups);
});

// POST /api/v1/groups/:id/members  { userId }
router.post('/:id/members', requireAuth, (req, res) => {
  const { userId } = req.body || {};
  const group = db.get('groups').find({ id: req.params.id }).value();
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const already = db.get('groupMembers').find({ groupId: group.id, userId }).value();
  if (already) return res.status(409).json({ error: 'User is already a member' });

  db.get('groupMembers')
    .push({ id: uuidv4(), groupId: group.id, userId, role: 'MEMBER', muted: false, pinned: false, joinedAt: new Date().toISOString() })
    .write();
  res.status(201).json({ ok: true });
});

// DELETE /api/v1/groups/:id/members/:userId
router.delete('/:id/members/:userId', requireAuth, (req, res) => {
  db.get('groupMembers').remove({ groupId: req.params.id, userId: req.params.userId }).write();
  res.status(204).send();
});

// GET /api/v1/groups/:id/members
router.get('/:id/members', requireAuth, (req, res) => {
  const members = db.get('groupMembers').filter({ groupId: req.params.id }).value();
  const withUsers = members.map((m) => ({
    ...m,
    user: (() => {
      const u = db.get('users').find({ id: m.userId }).value();
      if (!u) return null;
      const { passwordHash, email, ...safe } = u;
      return safe;
    })(),
  }));
  res.json(withUsers);
});

module.exports = router;
