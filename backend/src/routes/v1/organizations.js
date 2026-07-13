// FILE: backend/src/routes/v1/organizations.js
// REWRITTEN for the Identity -> Membership -> Organization model.
//
// KEY CHANGE: POST / ("Add Account" / "+ Create Organization") no longer
// takes an email/password at all. The caller is ALREADY an authenticated
// Identity (that's what the Bearer token proves) — creating another
// organization just adds a new membership under that same identity, same
// as Slack's "Create a workspace." See services/identityService.js.
//
// switch-context / exit-context are kept as thin backward-compatible
// wrappers around the new /auth/switch-organization (which works for any
// identity, not just Super Admin) — so any existing frontend code hitting
// these URLs keeps working while it's migrated over.

const express = require('express');
const repo = require('../../db');
const { nowIso } = require('../../utils/time');
const { requireAuth, requireSuperAdmin, belongsToSameOrg } = require('../../middleware/authGuards');
const identityService = require('../../services/identityService');
const { listOrganizations, setOrganizationStatus, deleteOrganization } = require('../../services/organizationService');
const { signAccessToken, issueRefreshTokenWithOrg } = require('../../middleware/tokens');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, created, fail, noContent } = require('../../utils/respond');

const router = express.Router();

router.get('/', requireAuth, requireSuperAdmin, async (req, res) => {
  ok(res, await listOrganizations());
});

// POST /api/v1/organizations  { orgName, industry?, country? }
// "+ Create Organization" — NO email/password. Adds a new organization
// (and membership) under the ALREADY AUTHENTICATED identity making this
// call. Any identity can do this, not just Super Admin — creating your
// second, third, tenth organization works the same way for everyone.
router.post('/', requireAuth, async (req, res) => {
  const { orgName, industry, country } = req.body || {};
  if (!orgName) return fail(res, 400, 'orgName is required');

  try {
    const identity = await repo.findById('identities', req.user.identityId);
    if (!identity) return fail(res, 404, 'Identity not found');

    const result = await identityService.createOrganizationForIdentity(identity, { orgName, industry, country });
    await recordAudit(req, { action: 'organization.create', entityType: 'organization', entityId: result.organization.id, newValue: result.organization });

    // Immediately switch the caller's active context into the freshly
    // created org, same as before — just via the new token model.
    const accessToken = await signAccessToken(identity, { activeOrgId: result.organization.id });
    const refreshToken = await issueRefreshTokenWithOrg(identity, result.organization.id, { ip: req.ip, userAgent: req.headers['user-agent'] });

    created(res, { organization: result.organization, accessToken, refreshToken });
  } catch (err) {
    fail(res, err.status || 500, err.message);
  }
});

// ---------------------------------------------------------------------------
// Super Admin account switching ("step into a tenant").
//
// The platform Super Admin has no organization membership at all, so every
// org-scoped route (users, roles, contacts, deals, ...) filters to an empty
// result for them by default. These two routes let a Super Admin choose
// which tenant's data they want to view/manage, WITHOUT impersonating any
// individual user in that tenant — they keep their own identity (identityId
// never changes) and their Super Admin privileges (isSuperAdmin stays true,
// so every permission check still auto-passes). Only the token's
// `activeOrgId` claim changes — re-signed fresh each time (see
// middleware/tokens.js) — no database writes to the identity itself.
//
// IMPORTANT: this must be defined BEFORE the generic `GET/PATCH/DELETE /:id`
// routes below so Express doesn't treat "exit-context" as an :id.
// ---------------------------------------------------------------------------

router.post('/:id/switch-context', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const org = await repo.findById('organizations', req.params.id);
    if (!org) return fail(res, 404, 'Organization not found');
    if (org.status === 'DELETED') return fail(res, 400, 'This organization has been deleted');

    const identity = await repo.findById('identities', req.user.identityId);
    if (!identity) return fail(res, 404, 'Identity not found');

    const accessToken = await signAccessToken(identity, { activeOrgId: org.id });
    const refreshToken = await issueRefreshTokenWithOrg(identity, org.id, { ip: req.ip, userAgent: req.headers['user-agent'] });

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
    const identity = await repo.findById('identities', req.user.identityId);
    if (!identity) return fail(res, 404, 'Identity not found');

    const accessToken = await signAccessToken(identity, { activeOrgId: null });
    const refreshToken = await issueRefreshTokenWithOrg(identity, null, { ip: req.ip, userAgent: req.headers['user-agent'] });

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
