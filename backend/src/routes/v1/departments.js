const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, nowIso } = require('../../db/db');
const { requireAuth, requirePermission, belongsToSameOrg } = require('../../middleware/authGuards');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail, noContent } = require('../../utils/respond');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  ok(res, db.get('departments').filter({ orgId: req.user.orgId }).value());
});

router.post('/', requireAuth, requirePermission('admin.settings'), (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return fail(res, 400, 'name is required');
  const dept = { id: uuidv4(), orgId: req.user.orgId, name, description: description || '', createdAt: nowIso() };
  db.get('departments').push(dept).write();
  recordAudit(req, { action: 'department.create', entityType: 'department', entityId: dept.id, newValue: dept });
  created(res, dept);
});

router.patch('/:id', requireAuth, requirePermission('admin.settings'), (req, res) => {
  const dept = db.get('departments').find({ id: req.params.id }).value();
  if (!dept || !belongsToSameOrg(req, dept.orgId)) return fail(res, 404, 'Department not found');
  const oldValue = { ...dept };
  const updated = db.get('departments').find({ id: dept.id }).assign({ name: req.body.name ?? dept.name, description: req.body.description ?? dept.description }).write();
  recordAudit(req, { action: 'department.update', entityType: 'department', entityId: dept.id, oldValue, newValue: updated });
  ok(res, updated);
});

router.delete('/:id', requireAuth, requirePermission('admin.settings'), (req, res) => {
  const dept = db.get('departments').find({ id: req.params.id }).value();
  if (!dept || !belongsToSameOrg(req, dept.orgId)) return fail(res, 404, 'Department not found');
  db.get('departments').remove({ id: dept.id }).write();
  recordAudit(req, { action: 'department.delete', entityType: 'department', entityId: dept.id });
  noContent(res);
});

module.exports = router;
