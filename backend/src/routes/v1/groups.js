const express = require('express');
const { v4: uuidv4 } = require('uuid');
const repo = require('../../db');
const { nowIso } = require('../../utils/time');
const { requireAuth, requirePermission, belongsToSameOrg } = require('../../middleware/authGuards');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail, noContent } = require('../../utils/respond');

const router = express.Router();

// POST /api/v1/groups  { name, description, memberIds: [], kind: 'GROUP'|'DEPARTMENT'|'ANNOUNCEMENT', departmentId? }
router.post('/', requireAuth, requirePermission('chat.create_group'), async (req, res) => {
  const { name, description, memberIds = [], kind = 'GROUP', departmentId } = req.body || {};
  if (!name) return fail(res, 400, 'name is required');

  const group = await repo.insert('groups', {
    id: uuidv4(), orgId: req.user.orgId, name, description: description || '', avatarUrl: null,
    kind, departmentId: departmentId || null, createdBy: req.user.uid, archived: false, createdAt: nowIso(),
  });

  const conversation = await repo.insert('conversations', {
    id: uuidv4(), orgId: req.user.orgId, type: 'GROUP', groupId: group.id,
    userAId: null, userBId: null, crossOrgLinkId: null, lastMessageAt: null, createdAt: nowIso(),
  });

  const memberSet = new Set([req.user.uid, ...memberIds]);
  for (const uid of memberSet) {
    await repo.insert('groupMembers', {
      id: uuidv4(), groupId: group.id, userId: uid,
      role: uid === req.user.uid ? 'OWNER' : 'MEMBER', muted: false, pinned: false, joinedAt: nowIso(),
    });
  }

  await recordAudit(req, { action: 'chat.create_group', entityType: 'group', entityId: group.id, newValue: group });
  created(res, { group, conversationId: conversation.id });
});

// GET /api/v1/groups/mine
router.get('/mine', requireAuth, requirePermission('chat.view'), async (req, res) => {
  const myMemberships = await repo.list('groupMembers', { userId: req.user.uid });
  const groups = [];
  for (const m of myMemberships) {
    const g = await repo.findById('groups', m.groupId);
    if (g && g.orgId === req.user.orgId) groups.push(g);
  }
  ok(res, groups);
});

// POST /api/v1/groups/:id/members  { userId } — requires chat.manage
router.post('/:id/members', requireAuth, requirePermission('chat.manage'), async (req, res) => {
  const { userId } = req.body || {};
  const group = await repo.findById('groups', req.params.id);
  if (!group || !belongsToSameOrg(req, group.orgId)) return fail(res, 404, 'Group not found');

  const already = await repo.findOne('groupMembers', { groupId: group.id, userId });
  if (already) return fail(res, 409, 'User is already a member');

  await repo.insert('groupMembers', { id: uuidv4(), groupId: group.id, userId, role: 'MEMBER', muted: false, pinned: false, joinedAt: nowIso() });
  created(res, { ok: true });
});

// DELETE /api/v1/groups/:id/members/:userId — requires chat.manage
router.delete('/:id/members/:userId', requireAuth, requirePermission('chat.manage'), async (req, res) => {
  const group = await repo.findById('groups', req.params.id);
  if (!group || !belongsToSameOrg(req, group.orgId)) return fail(res, 404, 'Group not found');
  await repo.removeWhere('groupMembers', { groupId: req.params.id, userId: req.params.userId });
  noContent(res);
});

// GET /api/v1/groups/:id/members
router.get('/:id/members', requireAuth, requirePermission('chat.view'), async (req, res) => {
  const group = await repo.findById('groups', req.params.id);
  if (!group || !belongsToSameOrg(req, group.orgId)) return fail(res, 404, 'Group not found');
  const members = await repo.list('groupMembers', { groupId: req.params.id });
  const withUsers = [];
  for (const m of members) {
    const u = await repo.findById('users', m.userId);
    const safe = u ? (({ passwordHash, ...rest }) => rest)(u) : null;
    withUsers.push({ ...m, user: safe });
  }
  ok(res, withUsers);
});

module.exports = router;
