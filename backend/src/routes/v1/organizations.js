const express = require('express');
const repo = require('../../db');
const { nowIso } = require('../../utils/time');
const { requireAuth, requireSuperAdmin, belongsToSameOrg } = require('../../middleware/authGuards');
const { createOrganizationWithOwner, listOrganizations, setOrganizationStatus, deleteOrganization } = require('../../services/organizationService');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail, noContent } = require('../../utils/respond');

const router = express.Router();

router.get('/', requireAuth, requireSuperAdmin, async (req, res) => {
  ok(res, await listOrganizations());
});

router.post('/', requireAuth, requireSuperAdmin, async (req, res) => {
  const { orgName, ownerEmail, ownerPassword, ownerDisplayName, industry, country } = req.body || {};
  if (!orgName || !ownerEmail || !ownerPassword || !ownerDisplayName) {
    return fail(res, 400, 'orgName, ownerEmail, ownerPassword and ownerDisplayName are required');
  }
  try {
    const result = await createOrganizationWithOwner({ orgName, ownerEmail, ownerPassword, ownerDisplayName, industry, country });
    await recordAudit(req, { action: 'organization.create', entityType: 'organization', entityId: result.organization.id, newValue: result.organization });
    created(res, result.organization);
  } catch (err) {
    fail(res, err.status || 500, err.message);
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  const org = await repo.findById('organizations', req.params.id);
  if (!org) return fail(res, 404, 'Organization not found');
  if (!belongsToSameOrg(req, org.id)) return fail(res, 403, 'Not authorized to view this organization');
  ok(res, org);
});

router.patch('/:id', requireAuth, async (req, res) => {
  const org = await repo.findById('organizations', req.params.id);
  if (!org) return fail(res, 404, 'Organization not found');
  if (!belongsToSameOrg(req, org.id)) return fail(res, 403, 'Not authorized to edit this organization');

  const allowed = ['name', 'logoUrl', 'address', 'country', 'timezone', 'industry', 'phone', 'email', 'settings'];
  const updates = {};
  for (const key of allowed) if (key in req.body) updates[key] = req.body[key];
  updates.updatedAt = nowIso();

  const oldValue = { ...org };
  const updated = await repo.updateById('organizations', org.id, updates);
  await recordAudit(req, { action: 'organization.update', entityType: 'organization', entityId: org.id, oldValue, newValue: updated });
  ok(res, updated);
});

router.post('/:id/suspend', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const updated = await setOrganizationStatus(req.params.id, 'SUSPENDED');
    await recordAudit(req, { action: 'organization.suspend', entityType: 'organization', entityId: req.params.id, newValue: updated });
    ok(res, updated);
  } catch (err) { fail(res, err.status || 500, err.message); }
});

router.post('/:id/activate', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const updated = await setOrganizationStatus(req.params.id, 'ACTIVE');
    await recordAudit(req, { action: 'organization.activate', entityType: 'organization', entityId: req.params.id, newValue: updated });
    ok(res, updated);
  } catch (err) { fail(res, err.status || 500, err.message); }
});

router.delete('/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await deleteOrganization(req.params.id);
    await recordAudit(req, { action: 'organization.delete', entityType: 'organization', entityId: req.params.id });
    noContent(res);
  } catch (err) { fail(res, err.status || 500, err.message); }
});

module.exports = router;
