const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const repo = require('../../db');
const { nowIso } = require('../../utils/time');
const { requireAuth, requirePermission, belongsToSameOrg } = require('../../middleware/authGuards');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail, paginate } = require('../../utils/respond');

const router = express.Router();

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

router.get('/', requireAuth, requirePermission('user.view'), async (req, res) => {
  const { search, departmentId, status, page, pageSize } = req.query;
  let users = await repo.list('users', { orgId: req.user.orgId });

  if (search) {
    const q = search.toLowerCase();
    users = users.filter((u) => u.displayName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }
  if (departmentId) users = users.filter((u) => u.departmentId === departmentId);
  if (status) users = users.filter((u) => u.status === status);

  const { items, meta } = paginate(users, { page, pageSize });
  ok(res, items.map(publicUser), meta);
});

router.post('/invite', requireAuth, requirePermission('user.create'), async (req, res) => {
  const { email, displayName, roleId, departmentId } = req.body || {};
  if (!email || !displayName || !roleId) return fail(res, 400, 'email, displayName and roleId are required');

  const emailLower = email.toLowerCase().trim();
  if (await repo.findOne('users', { email: emailLower })) return fail(res, 409, 'An account with this email already exists');

  const role = await repo.findById('roles', roleId);
  if (!role || role.orgId !== req.user.orgId) return fail(res, 400, 'roleId does not belong to your organization');

  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const employeeCount = await repo.count('users', { orgId: req.user.orgId });

  const user = await repo.insert('users', {
    id: uuidv4(),
    orgId: req.user.orgId,
    email: emailLower,
    passwordHash: bcrypt.hashSync(tempPassword, 10),
    displayName,
    avatarUrl: null,
    designation: null,
    phone: null,
    departmentId: departmentId || null,
    managerId: null,
    employeeId: `EMP-${String(employeeCount + 1).padStart(4, '0')}`,
    timezone: 'UTC',
    language: 'en',
    isSuperAdmin: false,
    roleId,
    status: 'OFFLINE',
    enabled: true,
    lastLoginAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  await recordAudit(req, { action: 'user.invite', entityType: 'user', entityId: user.id, newValue: publicUser(user) });
  // Production: email `tempPassword` via a secure invite link instead of returning it in the API response.
  created(res, { user: publicUser(user), temporaryPassword: tempPassword });
});

router.get('/:id', requireAuth, requirePermission('user.view'), async (req, res) => {
  const user = await repo.findById('users', req.params.id);
  if (!user || !belongsToSameOrg(req, user.orgId)) return fail(res, 404, 'User not found');
  ok(res, publicUser(user));
});

router.patch('/me/profile', requireAuth, async (req, res) => {
  const allowed = ['displayName', 'avatarUrl', 'designation', 'phone', 'timezone', 'language'];
  const updates = {};
  for (const key of allowed) if (key in req.body) updates[key] = req.body[key];
  updates.updatedAt = nowIso();
  const updated = await repo.updateById('users', req.user.uid, updates);
  ok(res, publicUser(updated));
});

router.patch('/:id', requireAuth, requirePermission('user.edit'), async (req, res) => {
  const user = await repo.findById('users', req.params.id);
  if (!user || !belongsToSameOrg(req, user.orgId)) return fail(res, 404, 'User not found');

  const allowed = ['displayName', 'designation', 'phone', 'departmentId', 'managerId', 'roleId', 'timezone', 'language'];
  const updates = {};
  for (const key of allowed) if (key in req.body) updates[key] = req.body[key];
  updates.updatedAt = nowIso();

  const oldValue = publicUser(user);
  const updated = await repo.updateById('users', user.id, updates);
  await recordAudit(req, { action: 'user.update', entityType: 'user', entityId: user.id, oldValue, newValue: publicUser(updated) });
  ok(res, publicUser(updated));
});

for (const [path, enabled] of [['disable', false], ['enable', true]]) {
  router.post(`/:id/${path}`, requireAuth, requirePermission('user.disable'), async (req, res) => {
    const user = await repo.findById('users', req.params.id);
    if (!user || !belongsToSameOrg(req, user.orgId)) return fail(res, 404, 'User not found');
    const updated = await repo.updateById('users', user.id, { enabled, updatedAt: nowIso() });
    await recordAudit(req, { action: `user.${path}`, entityType: 'user', entityId: user.id });
    ok(res, publicUser(updated));
  });
}

router.delete('/:id', requireAuth, requirePermission('user.delete'), async (req, res) => {
  const user = await repo.findById('users', req.params.id);
  if (!user || !belongsToSameOrg(req, user.orgId)) return fail(res, 404, 'User not found');
  await repo.removeById('users', user.id);
  await recordAudit(req, { action: 'user.delete', entityType: 'user', entityId: user.id });
  res.status(204).send();
});

router.get('/:id/permissions', requireAuth, requirePermission('user.permissions'), async (req, res) => {
  const user = await repo.findById('users', req.params.id);
  if (!user || !belongsToSameOrg(req, user.orgId)) return fail(res, 404, 'User not found');
  const rolePerms = user.roleId ? (await repo.list('rolePermissions', { roleId: user.roleId })).map((r) => r.permission) : [];
  const overrides = await repo.list('userPermissionOverrides', { userId: user.id });
  ok(res, { rolePermissions: rolePerms, overrides });
});

router.post('/:id/permissions', requireAuth, requirePermission('user.permissions'), async (req, res) => {
  const { permission, effect } = req.body || {};
  if (!permission || !['GRANT', 'REVOKE'].includes(effect)) return fail(res, 400, 'permission and effect (GRANT|REVOKE) are required');
  const user = await repo.findById('users', req.params.id);
  if (!user || !belongsToSameOrg(req, user.orgId)) return fail(res, 404, 'User not found');

  await repo.removeWhere('userPermissionOverrides', { userId: user.id, permission });
  const override = await repo.insert('userPermissionOverrides', { id: uuidv4(), userId: user.id, permission, effect, createdAt: nowIso(), createdBy: req.user.uid });

  await recordAudit(req, { action: 'user.permission_override', entityType: 'user', entityId: user.id, newValue: override });
  created(res, override);
});

module.exports = router;
