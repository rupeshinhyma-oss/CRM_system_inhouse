const { db } = require('../db/db');
const { verifyAccessToken } = require('./tokens');

/** Requires a valid Bearer access token. Attaches req.user = { uid, orgId, isSuperAdmin, roleId }. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    req.user = verifyAccessToken(header.substring(7));
    const dbUser = db.get('users').find({ id: req.user.uid }).value();
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
 * Super Admins implicitly have every permission everywhere.
 */
function getEffectivePermissions(userId) {
  const user = db.get('users').find({ id: userId }).value();
  if (!user) return new Set();
  if (user.isSuperAdmin) return null; // null == "all permissions", checked specially below

  const rolePerms = user.roleId
    ? db.get('rolePermissions').filter({ roleId: user.roleId }).map('permission').value()
    : [];
  const overrides = db.get('userPermissionOverrides').filter({ userId }).value();

  const effective = new Set(rolePerms);
  overrides.forEach((o) => {
    if (o.effect === 'GRANT') effective.add(o.permission);
    if (o.effect === 'REVOKE') effective.delete(o.permission);
  });
  return effective;
}

/** Route middleware factory: requirePermission('crm.view') */
function requirePermission(permission) {
  return (req, res, next) => {
    if (req.user?.isSuperAdmin) return next();
    const effective = getEffectivePermissions(req.user.uid);
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

module.exports = { requireAuth, requireSuperAdmin, requirePermission, getEffectivePermissions, belongsToSameOrg };
