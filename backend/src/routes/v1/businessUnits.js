const express = require('express');
const repo = require('../../db');
const { nowIso } = require('../../utils/time');
const { requireAuth, requirePermission, belongsToSameOrg } = require('../../middleware/authGuards');
const { signAccessToken, issueRefreshToken } = require('../../middleware/tokens');
const { recordAudit } = require('../../middleware/auditLog');
const {
  createBusinessUnit, addMembership, removeMembership, listBusinessUnitsForUser, isMember,
} = require('../../services/businessUnitService');
const { ok, created, fail, noContent } = require('../../utils/respond');

const router = express.Router();

// GET /api/v1/business-units — the "Who's working?" list: every business unit the caller belongs to.
router.get('/', requireAuth, async (req, res) => {
  const user = await repo.findById('users', req.user.uid);
  const units = await listBusinessUnitsForUser(user);
  ok(res, units.map((u) => ({ ...u, active: u.id === req.user.buId })));
});

// GET /api/v1/business-units/current — resolve the caller's current active organization context.
router.get('/current', requireAuth, async (req, res) => {
  if (!req.user.buId) return ok(res, null);
  const bu = await repo.findById('businessUnits', req.user.buId);
  ok(res, bu || null);
});

// POST /api/v1/business-units  { name, code?, logo?, description? }
router.post('/', requireAuth, requirePermission('org.manage_business_units'), async (req, res) => {
  const { name, code, logo, description } = req.body || {};
  if (!name) return fail(res, 400, 'name is required');
  if (!req.user.orgId) return fail(res, 400, 'Only members of an organization (tenant) can create business units');

  const bu = await createBusinessUnit(req.user.orgId, { name, code, logo, description });
  await addMembership(bu.id, req.user.uid, req.user.roleId, 'ACTIVE');
  await recordAudit(req, { action: 'businessunit.create', entityType: 'businessUnit', entityId: bu.id, newValue: bu });
  created(res, bu);
});

router.patch('/:id', requireAuth, requirePermission('org.manage_business_units'), async (req, res) => {
  const bu = await repo.findById('businessUnits', req.params.id);
  if (!bu || !belongsToSameOrg(req, bu.orgId)) return fail(res, 404, 'Business unit not found');

  const allowed = ['name', 'code', 'logo', 'description', 'settings'];
  const updates = {};
  for (const key of allowed) if (key in req.body) updates[key] = req.body[key];
  updates.updatedAt = nowIso();

  const oldValue = { ...bu };
  const updated = await repo.updateById('businessUnits', bu.id, updates);
  await recordAudit(req, { action: 'businessunit.update', entityType: 'businessUnit', entityId: bu.id, oldValue, newValue: updated });
  ok(res, updated);
});

router.post('/:id/archive', requireAuth, requirePermission('org.manage_business_units'), async (req, res) => {
  const bu = await repo.findById('businessUnits', req.params.id);
  if (!bu || !belongsToSameOrg(req, bu.orgId)) return fail(res, 404, 'Business unit not found');
  if (bu.isDefault) return fail(res, 400, 'The default business unit cannot be archived');

  const updated = await repo.updateById('businessUnits', bu.id, { status: 'ARCHIVED', updatedAt: nowIso() });
  await recordAudit(req, { action: 'businessunit.archive', entityType: 'businessUnit', entityId: bu.id });
  ok(res, updated);
});

router.delete('/:id', requireAuth, requirePermission('org.manage_business_units'), async (req, res) => {
  const bu = await repo.findById('businessUnits', req.params.id);
  if (!bu || !belongsToSameOrg(req, bu.orgId)) return fail(res, 404, 'Business unit not found');
  if (bu.isDefault) return fail(res, 400, 'The default business unit cannot be deleted');

  // Soft-delete, same pattern as organizationService.deleteOrganization — never destroy data outright.
  await repo.updateById('businessUnits', bu.id, { status: 'DELETED', updatedAt: nowIso() });
  await recordAudit(req, { action: 'businessunit.delete', entityType: 'businessUnit', entityId: bu.id });
  noContent(res);
});

/**
 * POST /api/v1/business-units/switch  { businessUnitId }
 *
 * The core of "organization switching." NOT impersonation: req.user.uid is
 * never touched. Server-side validation only — the frontend's businessUnitId
 * is never trusted without this membership + same-tenant check.
 */
router.post('/switch', requireAuth, async (req, res) => {
  const { businessUnitId } = req.body || {};
  if (!businessUnitId) return fail(res, 400, 'businessUnitId is required');

  const bu = await repo.findById('businessUnits', businessUnitId);
  if (!bu || bu.status !== 'ACTIVE') return fail(res, 404, 'Business unit not found');

  if (!req.user.isSuperAdmin) {
    if (bu.orgId !== req.user.orgId) return fail(res, 403, 'That business unit belongs to a different organization');
    const member = await isMember(req.user.uid, businessUnitId);
    if (!member) return fail(res, 403, 'You are not a member of that business unit');
  }

  const user = await repo.findById('users', req.user.uid);
  await repo.updateById('users', user.id, { activeBusinessUnitId: businessUnitId, updatedAt: nowIso() });

  // Re-sign tokens with the fresh buId claim — same session, same identity, new context.
  const accessToken = signAccessToken({ ...user, activeBusinessUnitId: businessUnitId });
  const refreshToken = await issueRefreshToken(user, { ip: req.ip, userAgent: req.headers['user-agent'] });

  await recordAudit(req, {
    action: 'businessunit.switch',
    entityType: 'businessUnit',
    entityId: businessUnitId,
    oldValue: { previousBusinessUnitId: req.user.buId || null },
    newValue: { businessUnitId },
  });

  ok(res, { businessUnit: bu, accessToken, refreshToken });
});

// POST /api/v1/business-units/:id/members  { userId, roleId? } — add an existing tenant user to this BU
router.post('/:id/members', requireAuth, requirePermission('org.manage_business_units'), async (req, res) => {
  const bu = await repo.findById('businessUnits', req.params.id);
  if (!bu || !belongsToSameOrg(req, bu.orgId)) return fail(res, 404, 'Business unit not found');

  const { userId, roleId } = req.body || {};
  if (!userId) return fail(res, 400, 'userId is required');
  const targetUser = await repo.findById('users', userId);
  if (!targetUser || !belongsToSameOrg(req, targetUser.orgId)) return fail(res, 404, 'User not found in this organization');

  const membership = await addMembership(bu.id, userId, roleId || targetUser.roleId, 'ACTIVE');
  await recordAudit(req, { action: 'businessunit.member_add', entityType: 'businessUnit', entityId: bu.id, newValue: membership });
  created(res, membership);
});

router.delete('/:id/members/:userId', requireAuth, requirePermission('org.manage_business_units'), async (req, res) => {
  const bu = await repo.findById('businessUnits', req.params.id);
  if (!bu || !belongsToSameOrg(req, bu.orgId)) return fail(res, 404, 'Business unit not found');

  const removedCount = await removeMembership(bu.id, req.params.userId);
  await recordAudit(req, { action: 'businessunit.member_remove', entityType: 'businessUnit', entityId: bu.id, oldValue: { userId: req.params.userId } });
  ok(res, { removed: removedCount > 0 });
});

module.exports = router;
