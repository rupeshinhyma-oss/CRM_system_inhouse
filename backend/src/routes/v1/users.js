const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, nowIso } = require('../../db/db');
const { requireAuth, requirePermission, belongsToSameOrg } = require('../../middleware/authGuards');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail, paginate } = require('../../utils/respond');

const router = express.Router();

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

// GET /api/v1/users?search=&department=&status=&page=&pageSize=
router.get('/', requireAuth, requirePermission('user.view'), (req, res) => {
  const { search, departmentId, status, page, pageSize } = req.query;
  let users = db.get('users').filter({ orgId: req.user.orgId }).value();

  if (search) {
    const q = search.toLowerCase();
    users = users.filter((u) => u.displayName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }
  if (departmentId) users = users.filter((u) => u.departmentId === departmentId);
  if (status) users = users.filter((u) => u.status === status);

  const { items, meta } = paginate(users, { page, pageSize });
  ok(res, items.map(publicUser), meta);
});

// POST /api/v1/users/invite  { email, displayName, roleId, departmentId? }
// Creates a user with a random temporary password (production: send an email invite/reset link instead).
router.post('/invite', requireAuth, requirePermission('user.create'), (req, res) => {
  const { email, displayName, roleId, departmentId } = req.body || {};
  if (!email || !displayName || !roleId) return fail(res, 400, 'email, displayName and roleId are required');

  const emailLower = email.toLowerCase().trim();
  if (db.get('users').find({ email: emailLower }).value()) return fail(res, 409, 'An account with this email already exists');

  const role = db.get('roles').find({ id: roleId, orgId: req.user.orgId }).value();
  if (!role) return fail(res, 400, 'roleId does not belong to your organization');

  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const employeeCount = db.get('users').filter({ orgId: req.user.orgId }).size().value();

  const user = {
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
  };
  db.get('users').push(user).write();

  recordAudit(req, { action: 'user.invite', entityType: 'user', entityId: user.id, newValue: publicUser(user) });
  // Production: email `tempPassword` via a secure invite link instead of returning it in the API response.
  created(res, { user: publicUser(user), temporaryPassword: tempPassword });
});

// GET /api/v1/users/:id
router.get('/:id', requireAuth, requirePermission('user.view'), (req, res) => {
  const user = db.get('users').find({ id: req.params.id }).value();
  if (!user || !belongsToSameOrg(req, user.orgId)) return fail(res, 404, 'User not found');
  ok(res, publicUser(user));
});

// PATCH /api/v1/users/me/profile — edit own profile, no permission required beyond auth
router.patch('/me/profile', requireAuth, (req, res) => {
  const allowed = ['displayName', 'avatarUrl', 'designation', 'phone', 'timezone', 'language'];
  const updates = {};
  for (const key of allowed) if (key in req.body) updates[key] = req.body[key];
  updates.updatedAt = nowIso();
  const updated = db.get('users').find({ id: req.user.uid }).assign(updates).write();
  ok(res, publicUser(updated));
});

// PATCH /api/v1/users/:id — admin edits a user (role, department, manager, etc.)
router.patch('/:id', requireAuth, requirePermission('user.edit'), (req, res) => {
  const user = db.get('users').find({ id: req.params.id }).value();
  if (!user || !belongsToSameOrg(req, user.orgId)) return fail(res, 404, 'User not found');

  const allowed = ['displayName', 'designation', 'phone', 'departmentId', 'managerId', 'roleId', 'timezone', 'language'];
  const updates = {};
  for (const key of allowed) if (key in req.body) updates[key] = req.body[key];
  updates.updatedAt = nowIso();

  const oldValue = publicUser(user);
  const updated = db.get('users').find({ id: user.id }).assign(updates).write();
  recordAudit(req, { action: 'user.update', entityType: 'user', entityId: user.id, oldValue, newValue: publicUser(updated) });
  ok(res, publicUser(updated));
});

// POST /api/v1/users/:id/disable | /enable | /suspend
for (const [path, enabled] of [['disable', false], ['enable', true]]) {
  router.post(`/:id/${path}`, requireAuth, requirePermission('user.disable'), (req, res) => {
    const user = db.get('users').find({ id: req.params.id }).value();
    if (!user || !belongsToSameOrg(req, user.orgId)) return fail(res, 404, 'User not found');
    const updated = db.get('users').find({ id: user.id }).assign({ enabled, updatedAt: nowIso() }).write();
    recordAudit(req, { action: `user.${path}`, entityType: 'user', entityId: user.id });
    ok(res, publicUser(updated));
  });
}

// DELETE /api/v1/users/:id
router.delete('/:id', requireAuth, requirePermission('user.delete'), (req, res) => {
  const user = db.get('users').find({ id: req.params.id }).value();
  if (!user || !belongsToSameOrg(req, user.orgId)) return fail(res, 404, 'User not found');
  db.get('users').remove({ id: user.id }).write();
  recordAudit(req, { action: 'user.delete', entityType: 'user', entityId: user.id });
  res.status(204).send();
});

// GET /api/v1/users/:id/permissions — effective permissions (role + overrides)
router.get('/:id/permissions', requireAuth, requirePermission('user.permissions'), (req, res) => {
  const user = db.get('users').find({ id: req.params.id }).value();
  if (!user || !belongsToSameOrg(req, user.orgId)) return fail(res, 404, 'User not found');
  const rolePerms = user.roleId ? db.get('rolePermissions').filter({ roleId: user.roleId }).map('permission').value() : [];
  const overrides = db.get('userPermissionOverrides').filter({ userId: user.id }).value();
  ok(res, { rolePermissions: rolePerms, overrides });
});

// POST /api/v1/users/:id/permissions  { permission, effect: 'GRANT'|'REVOKE' }
router.post('/:id/permissions', requireAuth, requirePermission('user.permissions'), (req, res) => {
  const { permission, effect } = req.body || {};
  if (!permission || !['GRANT', 'REVOKE'].includes(effect)) return fail(res, 400, 'permission and effect (GRANT|REVOKE) are required');
  const user = db.get('users').find({ id: req.params.id }).value();
  if (!user || !belongsToSameOrg(req, user.orgId)) return fail(res, 404, 'User not found');

  db.get('userPermissionOverrides').remove({ userId: user.id, permission }).write();
  const override = { id: uuidv4(), userId: user.id, permission, effect, createdAt: nowIso(), createdBy: req.user.uid };
  db.get('userPermissionOverrides').push(override).write();

  recordAudit(req, { action: 'user.permission_override', entityType: 'user', entityId: user.id, newValue: override });
  created(res, override);
});

module.exports = router;
