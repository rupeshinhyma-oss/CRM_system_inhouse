const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, nowIso } = require('../../db/db');
const { isValidPermission } = require('../../permissions/catalog');
const { requireAuth, requirePermission, belongsToSameOrg } = require('../../middleware/authGuards');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail, noContent } = require('../../utils/respond');

const router = express.Router();

function roleWithPermissions(role) {
  const permissions = db.get('rolePermissions').filter({ roleId: role.id }).map('permission').value();
  return { ...role, permissions };
}

// GET /api/v1/roles — all roles for the caller's org (or ?orgId= for Super Admin)
router.get('/', requireAuth, (req, res) => {
  const orgId = req.user.isSuperAdmin ? (req.query.orgId || null) : req.user.orgId;
  if (!orgId) return fail(res, 400, 'orgId is required');
  const roles = db.get('roles').filter({ orgId }).value().map(roleWithPermissions);
  ok(res, roles);
});

// POST /api/v1/roles  { orgId?, key, label, permissions: [] } — create a custom role
router.post('/', requireAuth, requirePermission('admin.roles'), (req, res) => {
  const orgId = req.user.isSuperAdmin ? req.body.orgId : req.user.orgId;
  const { key, label, permissions = [] } = req.body || {};
  if (!orgId || !key || !label) return fail(res, 400, 'orgId, key and label are required');

  const invalid = permissions.filter((p) => !isValidPermission(p));
  if (invalid.length) return fail(res, 400, 'Unknown permission(s)', invalid);

  const role = { id: uuidv4(), orgId, key, label, systemProtected: false, createdAt: nowIso() };
  db.get('roles').push(role).write();
  permissions.forEach((permission) => db.get('rolePermissions').push({ id: uuidv4(), roleId: role.id, permission }).write());

  recordAudit(req, { action: 'role.create', entityType: 'role', entityId: role.id, newValue: { ...role, permissions } });
  created(res, roleWithPermissions(role));
});

// PATCH /api/v1/roles/:id  { label?, permissions? } — edit a custom role's permission bundle
router.patch('/:id', requireAuth, requirePermission('admin.roles'), (req, res) => {
  const role = db.get('roles').find({ id: req.params.id }).value();
  if (!role) return fail(res, 404, 'Role not found');
  if (!belongsToSameOrg(req, role.orgId)) return fail(res, 403, 'Not authorized to edit this role');
  if (role.systemProtected && 'permissions' in req.body) {
    return fail(res, 400, 'This is a system-protected role and its base permissions cannot be edited. Clone it into a custom role instead.');
  }

  const oldValue = roleWithPermissions(role);
  if ('label' in req.body) db.get('roles').find({ id: role.id }).assign({ label: req.body.label }).write();

  if (Array.isArray(req.body.permissions)) {
    const invalid = req.body.permissions.filter((p) => !isValidPermission(p));
    if (invalid.length) return fail(res, 400, 'Unknown permission(s)', invalid);
    db.get('rolePermissions').remove({ roleId: role.id }).write();
    req.body.permissions.forEach((permission) => db.get('rolePermissions').push({ id: uuidv4(), roleId: role.id, permission }).write());
  }

  const updated = roleWithPermissions(db.get('roles').find({ id: role.id }).value());
  recordAudit(req, { action: 'role.update', entityType: 'role', entityId: role.id, oldValue, newValue: updated });
  ok(res, updated);
});

// DELETE /api/v1/roles/:id — cannot delete system-protected roles (e.g. Organization Owner)
router.delete('/:id', requireAuth, requirePermission('admin.roles'), (req, res) => {
  const role = db.get('roles').find({ id: req.params.id }).value();
  if (!role) return fail(res, 404, 'Role not found');
  if (!belongsToSameOrg(req, role.orgId)) return fail(res, 403, 'Not authorized to delete this role');
  if (role.systemProtected) return fail(res, 400, 'System-protected roles cannot be deleted');

  const usersWithRole = db.get('users').filter({ roleId: role.id }).size().value();
  if (usersWithRole > 0) return fail(res, 400, `Cannot delete a role assigned to ${usersWithRole} user(s). Reassign them first.`);

  db.get('rolePermissions').remove({ roleId: role.id }).write();
  db.get('roles').remove({ id: role.id }).write();
  recordAudit(req, { action: 'role.delete', entityType: 'role', entityId: role.id });
  noContent(res);
});

module.exports = router;
