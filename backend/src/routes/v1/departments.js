const express = require('express');
const { v4: uuidv4 } = require('uuid');
const repo = require('../../db');
const { nowIso } = require('../../utils/time');
const { requireAuth, requirePermission, belongsToSameOrg } = require('../../middleware/authGuards');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail, noContent } = require('../../utils/respond');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  ok(res, await repo.list('departments', { orgId: req.user.orgId }));
});

router.post('/', requireAuth, requirePermission('admin.settings'), async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return fail(res, 400, 'name is required');
  const dept = await repo.insert('departments', { id: uuidv4(), orgId: req.user.orgId, name, description: description || '', createdAt: nowIso() });
  await recordAudit(req, { action: 'department.create', entityType: 'department', entityId: dept.id, newValue: dept });
  created(res, dept);
});

router.patch('/:id', requireAuth, requirePermission('admin.settings'), async (req, res) => {
  const dept = await repo.findById('departments', req.params.id);
  if (!dept || !belongsToSameOrg(req, dept.orgId)) return fail(res, 404, 'Department not found');
  const oldValue = { ...dept };
  const updated = await repo.updateById('departments', dept.id, { name: req.body.name ?? dept.name, description: req.body.description ?? dept.description });
  await recordAudit(req, { action: 'department.update', entityType: 'department', entityId: dept.id, oldValue, newValue: updated });
  ok(res, updated);
});

router.delete('/:id', requireAuth, requirePermission('admin.settings'), async (req, res) => {
  const dept = await repo.findById('departments', req.params.id);
  if (!dept || !belongsToSameOrg(req, dept.orgId)) return fail(res, 404, 'Department not found');
  await repo.removeById('departments', dept.id);
  await recordAudit(req, { action: 'department.delete', entityType: 'department', entityId: dept.id });
  noContent(res);
});

module.exports = router;
