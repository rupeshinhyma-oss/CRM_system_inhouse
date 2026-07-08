const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, nowIso } = require('../../db/db');
const { requireAuth, requireSuperAdmin, requirePermission, belongsToSameOrg } = require('../../middleware/authGuards');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail } = require('../../utils/respond');

const router = express.Router();

// POST /api/v1/collaboration/links  { orgAId, orgBId } — Super Admin ONLY enables the possibility of collaboration.
// This does not share anything by itself — it just unlocks orgB/orgA admins to grant specific shares.
router.post('/links', requireAuth, requireSuperAdmin, (req, res) => {
  const { orgAId, orgBId } = req.body || {};
  if (!orgAId || !orgBId || orgAId === orgBId) return fail(res, 400, 'orgAId and orgBId are required and must differ');

  const link = { id: uuidv4(), orgAId, orgBId, status: 'ENABLED', enabledBy: req.user.uid, createdAt: nowIso() };
  db.get('sharedOrganizations').push(link).write();
  recordAudit(req, { action: 'collaboration.link_enable', entityType: 'sharedOrganization', entityId: link.id, newValue: link });
  created(res, link);
});

// GET /api/v1/collaboration/links — links visible to this org (or all, for Super Admin)
router.get('/links', requireAuth, (req, res) => {
  const links = req.user.isSuperAdmin
    ? db.get('sharedOrganizations').value()
    : db.get('sharedOrganizations').filter((l) => l.orgAId === req.user.orgId || l.orgBId === req.user.orgId).value();
  ok(res, links);
});

// POST /api/v1/collaboration/links/:linkId/grants
// { resourceType: 'contact'|'lead'|'deal'|'company'|'chat'|'file'|'project', resourceId, permission }
// Org Admin of either side of an ENABLED link grants a specific, scoped share. Nothing is automatic.
router.post('/links/:linkId/grants', requireAuth, requirePermission('admin.settings'), (req, res) => {
  const link = db.get('sharedOrganizations').find({ id: req.params.linkId }).value();
  if (!link) return fail(res, 404, 'Collaboration link not found');
  if (link.status !== 'ENABLED') return fail(res, 400, 'This collaboration link is not enabled');
  if (![link.orgAId, link.orgBId].includes(req.user.orgId) && !req.user.isSuperAdmin) {
    return fail(res, 403, 'Your organization is not part of this collaboration link');
  }

  const { resourceType, resourceId, permission } = req.body || {};
  if (!resourceType || !resourceId || !permission) return fail(res, 400, 'resourceType, resourceId and permission are required');

  const grant = {
    id: uuidv4(), sharedOrgLinkId: link.id, resourceType, resourceId, permission,
    grantedBy: req.user.uid, grantedByOrgId: req.user.orgId, createdAt: nowIso(),
  };
  db.get('sharedResourceGrants').push(grant).write();
  recordAudit(req, { action: 'collaboration.grant_create', entityType: 'sharedResourceGrant', entityId: grant.id, newValue: grant });
  created(res, grant);
});

// GET /api/v1/collaboration/links/:linkId/grants
router.get('/links/:linkId/grants', requireAuth, (req, res) => {
  const link = db.get('sharedOrganizations').find({ id: req.params.linkId }).value();
  if (!link) return fail(res, 404, 'Collaboration link not found');
  if (![link.orgAId, link.orgBId].includes(req.user.orgId) && !req.user.isSuperAdmin) {
    return fail(res, 403, 'Your organization is not part of this collaboration link');
  }
  ok(res, db.get('sharedResourceGrants').filter({ sharedOrgLinkId: link.id }).value());
});

// DELETE /api/v1/collaboration/links/:linkId/grants/:grantId — revoke a share
router.delete('/links/:linkId/grants/:grantId', requireAuth, requirePermission('admin.settings'), (req, res) => {
  db.get('sharedResourceGrants').remove({ id: req.params.grantId, sharedOrgLinkId: req.params.linkId }).write();
  recordAudit(req, { action: 'collaboration.grant_revoke', entityType: 'sharedResourceGrant', entityId: req.params.grantId });
  res.status(204).send();
});

module.exports = router;
