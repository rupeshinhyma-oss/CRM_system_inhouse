// FILE: backend/src/middleware/tokens.js
// Replace the existing file at this path with this one.
// CHANGE: signAccessToken now resolves the token's `orgId` claim from
// `user.activeOrgId` when the user is a Super Admin (set via the new
// POST /organizations/:id/switch-context and /organizations/exit-context
// routes in routes/v1/organizations.js). Regular tenant users are unaffected
// — their orgId claim still comes straight from user.orgId as before.

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const repo = require('../db');
const { nowIso } = require('../utils/time');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Add it to your .env (a long random string).');
}

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;

/**
 * Signs a short-lived JWT access token for a user.
 *
 * `buId` (active Business Unit id) is additive to the original payload shape —
 * it carries the user's *organization context* in the JioHotstar-style
 * switching sense (see services/businessUnitService.js). It is null for the
 * platform Super Admin and for tenants that predate this feature until they
 * are migrated (see db/migrations/2026_07_add_business_units.js). Nothing
 * about `uid` ever changes on a switch — same user, same session, only the
 * active-context claim differs.
 *
 * `orgId` claim resolution:
 *   - Regular tenant user  -> user.orgId (their real, fixed tenant)
 *   - Super Admin          -> user.activeOrgId if they've "stepped into" a
 *                             tenant via the account-switching page, else null
 *                             (null = platform-level view, no tenant data).
 * This is what lets every existing org-scoped route (users.list, roles.list,
 * etc., which all filter by req.user.orgId) transparently show a Super
 * Admin the data of whichever tenant they've switched into, with zero
 * changes needed in those routes.
 */
function signAccessToken(user) {
  const effectiveOrgId = user.isSuperAdmin ? (user.activeOrgId || null) : (user.orgId || null);
  return jwt.sign(
    {
      uid: user.id,
      orgId: effectiveOrgId,
      buId: user.activeBusinessUnitId || null,
      isSuperAdmin: !!user.isSuperAdmin,
      roleId: user.roleId || null,
      // True only while a Super Admin is "inside" a switched-to tenant —
      // lets the frontend show the "Exit to Platform" banner and lets any
      // route distinguish a real tenant owner from a visiting Super Admin.
      isActingContext: !!(user.isSuperAdmin && user.activeOrgId),
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

/** Verifies a JWT access token, returns its payload, or throws if invalid/expired. */
function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/** Issues a new opaque refresh token, stored in the DB, tied to a user + device. */
async function issueRefreshToken(user, meta = {}) {
  const token = uuidv4() + uuidv4(); // opaque, unguessable
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await repo.insert('refreshTokens', {
    id: uuidv4(),
    token,
    userId: user.id,
    ip: meta.ip || null,
    userAgent: meta.userAgent || null,
    revoked: false,
    expiresAt,
    createdAt: nowIso(),
  });
  return token;
}

/** Validates + rotates a refresh token: revokes the old one, issues a new pair. */
async function rotateRefreshToken(oldToken, meta = {}) {
  const record = await repo.findOne('refreshTokens', { token: oldToken });
  if (!record || record.revoked || new Date(record.expiresAt) < new Date()) return null;

  const user = await repo.findById('users', record.userId);
  if (!user || !user.enabled) return null;

  await repo.updateById('refreshTokens', record.id, { revoked: true });

  // Re-signed from the CURRENT db user record, so activeOrgId (set by the
  // switch-context / exit-context routes) is respected on every refresh —
  // a Super Admin's chosen tenant context survives past the 15-minute
  // access-token expiry instead of silently reverting on refresh.
  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user, meta);
  return { accessToken, refreshToken };
}

/** Revokes every refresh token for a user (e.g. on logout / "log out everywhere"). */
async function revokeAllRefreshTokensForUser(userId) {
  await repo.updateWhere('refreshTokens', { userId, revoked: false }, { revoked: true });
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeAllRefreshTokensForUser,
};
