// FILE: backend/src/routes/v1/organizations.js
// Replace the existing file at this path with this one.
// CHANGE: adds two Super-Admin-only endpoints that power the new
// "Switch Organization" page in the frontend:
//   POST /api/v1/organizations/:id/switch-context  -> step into a tenant
//   POST /api/v1/organizations/exit-context         -> step back out to the
//                                                      platform-level view
// Everything else in this file is unchanged from the original.

const express = require('express');
const repo = require('../../db');
const { nowIso } = require('../../utils/time');
const { requireAuth, requireSuperAdmin, belongsToSameOrg } = require('../../middleware/authGuards');
const { createOrganizationWithOwner, listOrganizations, setOrganizationStatus, deleteOrganization } = require('../../services/organizationService');
const { signAccessToken, issueRefreshToken } = require('../../middleware/tokens');
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

// ---------------------------------------------------------------------------
// Super Admin account switching ("step into a tenant").
//
// The platform Super Admin has no orgId of their own, so every org-scoped
// route (users, roles, contacts, deals, ...) filters to an empty result for
// them. These two routes let a Super Admin choose which tenant's data they
// want to view/manage, WITHOUT impersonating any individual user in that
// tenant — they keep their own identity (uid never changes) and their
// Super Admin privileges (isSuperAdmin stays true, so every permission
// check still auto-passes). Only the effective `orgId` claim on their
// token changes, by persisting `activeOrgId` on their own user record and
// re-signing their tokens from it (see middleware/tokens.js).
//
// IMPORTANT: this must be defined BEFORE the generic `GET/PATCH/DELETE /:id`
// routes below so Express doesn't treat "exit-context" as an :id.
// ---------------------------------------------------------------------------

router.post('/:id/switch-context', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const org = await repo.findById('organizations', req.params.id);
    if (!org) return fail(res, 404, 'Organization not found');
    if (org.status === 'DELETED') return fail(res, 400, 'This organization has been deleted');

    const updatedUser = await repo.updateById('users', req.user.uid, { activeOrgId: org.id, updatedAt: nowIso() });
    const accessToken = signAccessToken(updatedUser);
    const refreshToken = await issueRefreshToken(updatedUser, { ip: req.ip, userAgent: req.headers['user-agent'] });

    await recordAudit(req, {
      action: 'superadmin.switch_context',
      entityType: 'organization',
      entityId: org.id,
      newValue: { organizationId: org.id, organizationName: org.name },
    });

    ok(res, { accessToken, refreshToken, organization: org });
  } catch (err) {
    fail(res, err.status || 500, err.message);
  }
});

router.post('/exit-context', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const updatedUser = await repo.updateById('users', req.user.uid, { activeOrgId: null, updatedAt: nowIso() });
    const accessToken = signAccessToken(updatedUser);
    const refreshToken = await issueRefreshToken(updatedUser, { ip: req.ip, userAgent: req.headers['user-agent'] });

    await recordAudit(req, { action: 'superadmin.exit_context', entityType: 'organization', entityId: null });

    ok(res, { accessToken, refreshToken });
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
