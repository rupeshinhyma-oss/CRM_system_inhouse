const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, nowIso } = require('../../db/db');
const { requireAuth, requirePermission, belongsToSameOrg } = require('../../middleware/authGuards');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail, noContent } = require('../../utils/respond');

const router = express.Router();

// POST /api/v1/groups  { name, description, memberIds: [], kind: 'GROUP'|'DEPARTMENT'|'ANNOUNCEMENT', departmentId? }
router.post('/', requireAuth, requirePermission('chat.create_group'), (req, res) => {
  const { name, description, memberIds = [], kind = 'GROUP', departmentId } = req.body || {};
  if (!name) return fail(res, 400, 'name is required');

  const group = {
    id: uuidv4(),
    orgId: req.user.orgId,
    name,
    description: description || '',
    avatarUrl: null,
    kind, // GROUP | DEPARTMENT | ANNOUNCEMENT
    departmentId: departmentId || null,
    createdBy: req.user.uid,
    archived: false,
    createdAt: nowIso(),
  };
  db.get('groups').push(group).write();

  const conversation = {
    id: uuidv4(),
    orgId: req.user.orgId,
    type: 'GROUP',
    groupId: group.id,
    userAId: null,
    userBId: null,
    crossOrgLinkId: null,
    lastMessageAt: null,
    createdAt: nowIso(),
  };
  db.get('conversations').push(conversation).write();

  const memberSet = new Set([req.user.uid, ...memberIds]);
  memberSet.forEach((uid) => {
    db.get('groupMembers').push({
      id: uuidv4(), groupId: group.id, userId: uid,
      role: uid === req.user.uid ? 'OWNER' : 'MEMBER', muted: false, pinned: false, joinedAt: nowIso(),
    }).write();
  });

  recordAudit(req, { action: 'chat.create_group', entityType: 'group', entityId: group.id, newValue: group });
  created(res, { group, conversationId: conversation.id });
});

// GET /api/v1/groups/mine
router.get('/mine', requireAuth, requirePermission('chat.view'), (req, res) => {
  const myMemberships = db.get('groupMembers').filter({ userId: req.user.uid }).value();
  const groups = myMemberships
    .map((m) => db.get('groups').find({ id: m.groupId }).value())
    .filter((g) => g && g.orgId === req.user.orgId);
  ok(res, groups);
});

// POST /api/v1/groups/:id/members  { userId } — requires chat.manage
router.post('/:id/members', requireAuth, requirePermission('chat.manage'), (req, res) => {
  const { userId } = req.body || {};
  const group = db.get('groups').find({ id: req.params.id }).value();
  if (!group || !belongsToSameOrg(req, group.orgId)) return fail(res, 404, 'Group not found');

  const already = db.get('groupMembers').find({ groupId: group.id, userId }).value();
  if (already) return fail(res, 409, 'User is already a member');

  db.get('groupMembers').push({ id: uuidv4(), groupId: group.id, userId, role: 'MEMBER', muted: false, pinned: false, joinedAt: nowIso() }).write();
  created(res, { ok: true });
});

// DELETE /api/v1/groups/:id/members/:userId — requires chat.manage
router.delete('/:id/members/:userId', requireAuth, requirePermission('chat.manage'), (req, res) => {
  const group = db.get('groups').find({ id: req.params.id }).value();
  if (!group || !belongsToSameOrg(req, group.orgId)) return fail(res, 404, 'Group not found');
  db.get('groupMembers').remove({ groupId: req.params.id, userId: req.params.userId }).write();
  noContent(res);
});

// GET /api/v1/groups/:id/members
router.get('/:id/members', requireAuth, requirePermission('chat.view'), (req, res) => {
  const group = db.get('groups').find({ id: req.params.id }).value();
  if (!group || !belongsToSameOrg(req, group.orgId)) return fail(res, 404, 'Group not found');
  const members = db.get('groupMembers').filter({ groupId: req.params.id }).value();
  const withUsers = members.map((m) => {
    const u = db.get('users').find({ id: m.userId }).value();
    const { passwordHash, ...safe } = u || {};
    return { ...m, user: u ? safe : null };
  });
  ok(res, withUsers);
});

module.exports = router;
