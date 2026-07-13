const repo = require('../db');
const { verifyAccessToken } = require('./tokens');

/** Requires a valid Bearer access token. Attaches req.user = { uid, orgId, isSuperAdmin, roleId }. */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    req.user = verifyAccessToken(header.substring(7));
    const dbUser = await repo.findById('users', req.user.uid);
    if (!dbUser || !dbUser.enabled) return res.status(401).json({ error: 'Account not found or disabled' });
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireSuperAdmin(req, res, next) {
  if (!req.user?.isSuperAdmin) return res.status(403).json({ error: 'Super Admin access required' });
  next();
}

/**
 * Computes the effective permission set for a user:
 *   role permissions  ∪ user GRANT overrides  −  user REVOKE overrides
 * Super Admins implicitly have every permission everywhere (represented as `null`).
 */
async function getEffectivePermissions(userId) {
  const user = await repo.findById('users', userId);
  if (!user) return new Set();
  if (user.isSuperAdmin) return null; // null == "all permissions"

  const rolePerms = user.roleId
    ? (await repo.list('rolePermissions', { roleId: user.roleId })).map((r) => r.permission)
    : [];
  const overrides = await repo.list('userPermissionOverrides', { userId });

  const effective = new Set(rolePerms);
  overrides.forEach((o) => {
    if (o.effect === 'GRANT') effective.add(o.permission);
    if (o.effect === 'REVOKE') effective.delete(o.permission);
  });
  return effective;
}

/** Route middleware factory: requirePermission('crm.view') */
function requirePermission(permission) {
  return async (req, res, next) => {
    if (req.user?.isSuperAdmin) return next();
    const effective = await getEffectivePermissions(req.user.uid);
    if (effective && effective.has(permission)) return next();
    return res.status(403).json({ error: `Missing required permission: ${permission}` });
  };
}

/**
 * Ensures the resource's orgId matches the requesting user's orgId, unless
 * the user is Super Admin, or a valid cross-org sharing grant covers this
 * resource type + permission (checked by caller via sharing service).
 */
function belongsToSameOrg(req, resourceOrgId) {
  if (req.user?.isSuperAdmin) return true;
  return req.user?.orgId === resourceOrgId;
}

/**
 * Ensures a resource's businessUnitId matches the requesting user's ACTIVE
 * business unit — the "organization switching" isolation boundary that sits
 * one level below tenant isolation (see services/businessUnitService.js and
 * ARCHITECTURE.md §10). Super Admin bypasses it, same as belongsToSameOrg.
 *
 * A resource with no businessUnitId at all (a record created before this
 * feature existed, prior to running the backfill migration) is treated as
 * visible — this is a deliberate, documented backward-compat allowance, not
 * a silent gap: run db/migrations/2026_07_add_business_units.js to backfill
 * every legacy record onto its org's Default business unit, after which
 * every record has a businessUnitId and this fallback stops applying.
 */
function belongsToSameBusinessUnit(req, resourceBuId) {
  if (req.user?.isSuperAdmin) return true;
  if (!resourceBuId) return true;
  return req.user?.buId === resourceBuId;
}

module.exports = {
  requireAuth, requireSuperAdmin, requirePermission, getEffectivePermissions,
  belongsToSameOrg, belongsToSameBusinessUnit,
};
