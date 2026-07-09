const express = require('express');
const { v4: uuidv4 } = require('uuid');
const repo = require('../../db');
const { nowIso } = require('../../utils/time');
const { requireAuth, requireSuperAdmin, requirePermission } = require('../../middleware/authGuards');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail } = require('../../utils/respond');

const router = express.Router();

// POST /api/v1/collaboration/links  { orgAId, orgBId } — Super Admin ONLY enables the possibility of collaboration.
router.post('/links', requireAuth, requireSuperAdmin, async (req, res) => {
  const { orgAId, orgBId } = req.body || {};
  if (!orgAId || !orgBId || orgAId === orgBId) return fail(res, 400, 'orgAId and orgBId are required and must differ');

  const link = await repo.insert('sharedOrganizations', { id: uuidv4(), orgAId, orgBId, status: 'ENABLED', enabledBy: req.user.uid, createdAt: nowIso() });
  await recordAudit(req, { action: 'collaboration.link_enable', entityType: 'sharedOrganization', entityId: link.id, newValue: link });
  created(res, link);
});

// GET /api/v1/collaboration/links
router.get('/links', requireAuth, async (req, res) => {
  const links = req.user.isSuperAdmin
    ? await repo.list('sharedOrganizations')
    : (await repo.list('sharedOrganizations')).filter((l) => l.orgAId === req.user.orgId || l.orgBId === req.user.orgId);
  ok(res, links);
});

// POST /api/v1/collaboration/links/:linkId/grants
router.post('/links/:linkId/grants', requireAuth, requirePermission('admin.settings'), async (req, res) => {
  const link = await repo.findById('sharedOrganizations', req.params.linkId);
  if (!link) return fail(res, 404, 'Collaboration link not found');
  if (link.status !== 'ENABLED') return fail(res, 400, 'This collaboration link is not enabled');
  if (![link.orgAId, link.orgBId].includes(req.user.orgId) && !req.user.isSuperAdmin) {
    return fail(res, 403, 'Your organization is not part of this collaboration link');
  }

  const { resourceType, resourceId, permission } = req.body || {};
  if (!resourceType || !resourceId || !permission) return fail(res, 400, 'resourceType, resourceId and permission are required');

  const grant = await repo.insert('sharedResourceGrants', {
    id: uuidv4(), sharedOrgLinkId: link.id, resourceType, resourceId, permission,
    grantedBy: req.user.uid, grantedByOrgId: req.user.orgId, createdAt: nowIso(),
  });
  await recordAudit(req, { action: 'collaboration.grant_create', entityType: 'sharedResourceGrant', entityId: grant.id, newValue: grant });
  created(res, grant);
});

// GET /api/v1/collaboration/links/:linkId/grants
router.get('/links/:linkId/grants', requireAuth, async (req, res) => {
  const link = await repo.findById('sharedOrganizations', req.params.linkId);
  if (!link) return fail(res, 404, 'Collaboration link not found');
  if (![link.orgAId, link.orgBId].includes(req.user.orgId) && !req.user.isSuperAdmin) {
    return fail(res, 403, 'Your organization is not part of this collaboration link');
  }
  ok(res, await repo.list('sharedResourceGrants', { sharedOrgLinkId: link.id }));
});

// DELETE /api/v1/collaboration/links/:linkId/grants/:grantId
router.delete('/links/:linkId/grants/:grantId', requireAuth, requirePermission('admin.settings'), async (req, res) => {
  await repo.removeWhere('sharedResourceGrants', { id: req.params.grantId, sharedOrgLinkId: req.params.linkId });
  await recordAudit(req, { action: 'collaboration.grant_revoke', entityType: 'sharedResourceGrant', entityId: req.params.grantId });
  res.status(204).send();
});

module.exports = router;
