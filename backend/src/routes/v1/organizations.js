const express = require('express');
const { db, nowIso } = require('../../db/db');
const { requireAuth, requireSuperAdmin, belongsToSameOrg } = require('../../middleware/authGuards');
const { createOrganizationWithOwner, listOrganizations, setOrganizationStatus, deleteOrganization } = require('../../services/organizationService');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail, noContent } = require('../../utils/respond');

const router = express.Router();

// GET /api/v1/organizations — Super Admin only: view every organization
router.get('/', requireAuth, requireSuperAdmin, (req, res) => {
  ok(res, listOrganizations());
});

// POST /api/v1/organizations — Super Admin creates an org directly (with an owner)
router.post('/', requireAuth, requireSuperAdmin, (req, res) => {
  const { orgName, ownerEmail, ownerPassword, ownerDisplayName, industry, country } = req.body || {};
  if (!orgName || !ownerEmail || !ownerPassword || !ownerDisplayName) {
    return fail(res, 400, 'orgName, ownerEmail, ownerPassword and ownerDisplayName are required');
  }
  try {
    const result = createOrganizationWithOwner({ orgName, ownerEmail, ownerPassword, ownerDisplayName, industry, country });
    recordAudit(req, { action: 'organization.create', entityType: 'organization', entityId: result.organization.id, newValue: result.organization });
    created(res, result.organization);
  } catch (err) {
    fail(res, err.status || 500, err.message);
  }
});

// GET /api/v1/organizations/:id — self (org member) or Super Admin
router.get('/:id', requireAuth, (req, res) => {
  const org = db.get('organizations').find({ id: req.params.id }).value();
  if (!org) return fail(res, 404, 'Organization not found');
  if (!belongsToSameOrg(req, org.id)) return fail(res, 403, 'Not authorized to view this organization');
  ok(res, org);
});

// PATCH /api/v1/organizations/:id — org owner/admin updates their own org settings
router.patch('/:id', requireAuth, (req, res) => {
  const org = db.get('organizations').find({ id: req.params.id }).value();
  if (!org) return fail(res, 404, 'Organization not found');
  if (!belongsToSameOrg(req, org.id)) return fail(res, 403, 'Not authorized to edit this organization');

  const allowed = ['name', 'logoUrl', 'address', 'country', 'timezone', 'industry', 'phone', 'email', 'settings'];
  const updates = {};
  for (const key of allowed) if (key in req.body) updates[key] = req.body[key];
  updates.updatedAt = nowIso();

  const oldValue = { ...org };
  const updated = db.get('organizations').find({ id: org.id }).assign(updates).write();
  recordAudit(req, { action: 'organization.update', entityType: 'organization', entityId: org.id, oldValue, newValue: updated });
  ok(res, updated);
});

// POST /api/v1/organizations/:id/suspend — Super Admin only
router.post('/:id/suspend', requireAuth, requireSuperAdmin, (req, res) => {
  try {
    const updated = setOrganizationStatus(req.params.id, 'SUSPENDED');
    recordAudit(req, { action: 'organization.suspend', entityType: 'organization', entityId: req.params.id, newValue: updated });
    ok(res, updated);
  } catch (err) { fail(res, err.status || 500, err.message); }
});

// POST /api/v1/organizations/:id/activate — Super Admin only
router.post('/:id/activate', requireAuth, requireSuperAdmin, (req, res) => {
  try {
    const updated = setOrganizationStatus(req.params.id, 'ACTIVE');
    recordAudit(req, { action: 'organization.activate', entityType: 'organization', entityId: req.params.id, newValue: updated });
    ok(res, updated);
  } catch (err) { fail(res, err.status || 500, err.message); }
});

// DELETE /api/v1/organizations/:id — Super Admin only (soft delete)
router.delete('/:id', requireAuth, requireSuperAdmin, (req, res) => {
  try {
    deleteOrganization(req.params.id);
    recordAudit(req, { action: 'organization.delete', entityType: 'organization', entityId: req.params.id });
    noContent(res);
  } catch (err) { fail(res, err.status || 500, err.message); }
});

module.exports = router;
