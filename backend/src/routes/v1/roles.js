const express = require('express');
const { v4: uuidv4 } = require('uuid');
const repo = require('../../db');
const { nowIso } = require('../../utils/time');
const { isValidPermission } = require('../../permissions/catalog');
const { requireAuth, requirePermission, belongsToSameOrg } = require('../../middleware/authGuards');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail, noContent } = require('../../utils/respond');

const router = express.Router();

async function roleWithPermissions(role) {
  const rows = await repo.list('rolePermissions', { roleId: role.id });
  return { ...role, permissions: rows.map((r) => r.permission) };
}

router.get('/', requireAuth, async (req, res) => {
  const orgId = req.user.isSuperAdmin ? (req.query.orgId || null) : req.user.orgId;
  if (!orgId) return fail(res, 400, 'orgId is required');
  const roles = await repo.list('roles', { orgId });
  ok(res, await Promise.all(roles.map(roleWithPermissions)));
});

router.post('/', requireAuth, requirePermission('admin.roles'), async (req, res) => {
  const orgId = req.user.isSuperAdmin ? req.body.orgId : req.user.orgId;
  const { key, label, permissions = [] } = req.body || {};
  if (!orgId || !key || !label) return fail(res, 400, 'orgId, key and label are required');

  const invalid = permissions.filter((p) => !isValidPermission(p));
  if (invalid.length) return fail(res, 400, 'Unknown permission(s)', invalid);

  const role = await repo.insert('roles', { id: uuidv4(), orgId, key, label, systemProtected: false, createdAt: nowIso() });
  for (const permission of permissions) {
    await repo.insert('rolePermissions', { id: uuidv4(), roleId: role.id, permission });
  }

  await recordAudit(req, { action: 'role.create', entityType: 'role', entityId: role.id, newValue: { ...role, permissions } });
  created(res, await roleWithPermissions(role));
});

router.patch('/:id', requireAuth, requirePermission('admin.roles'), async (req, res) => {
  const role = await repo.findById('roles', req.params.id);
  if (!role) return fail(res, 404, 'Role not found');
  if (!belongsToSameOrg(req, role.orgId)) return fail(res, 403, 'Not authorized to edit this role');
  if (role.systemProtected && 'permissions' in req.body) {
    return fail(res, 400, 'This is a system-protected role and its base permissions cannot be edited. Clone it into a custom role instead.');
  }

  const oldValue = await roleWithPermissions(role);
  if ('label' in req.body) await repo.updateById('roles', role.id, { label: req.body.label });

  if (Array.isArray(req.body.permissions)) {
    const invalid = req.body.permissions.filter((p) => !isValidPermission(p));
    if (invalid.length) return fail(res, 400, 'Unknown permission(s)', invalid);
    await repo.removeWhere('rolePermissions', { roleId: role.id });
    for (const permission of req.body.permissions) {
      await repo.insert('rolePermissions', { id: uuidv4(), roleId: role.id, permission });
    }
  }

  const updated = await roleWithPermissions(await repo.findById('roles', role.id));
  await recordAudit(req, { action: 'role.update', entityType: 'role', entityId: role.id, oldValue, newValue: updated });
  ok(res, updated);
});

router.delete('/:id', requireAuth, requirePermission('admin.roles'), async (req, res) => {
  const role = await repo.findById('roles', req.params.id);
  if (!role) return fail(res, 404, 'Role not found');
  if (!belongsToSameOrg(req, role.orgId)) return fail(res, 403, 'Not authorized to delete this role');
  if (role.systemProtected) return fail(res, 400, 'System-protected roles cannot be deleted');

  const usersWithRole = await repo.count('users', { roleId: role.id });
  if (usersWithRole > 0) return fail(res, 400, `Cannot delete a role assigned to ${usersWithRole} user(s). Reassign them first.`);

  await repo.removeWhere('rolePermissions', { roleId: role.id });
  await repo.removeById('roles', role.id);
  await recordAudit(req, { action: 'role.delete', entityType: 'role', entityId: role.id });
  noContent(res);
});

module.exports = router;
