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
 */
function signAccessToken(user) {
  return jwt.sign(
    {
      uid: user.id,
      orgId: user.orgId || null,
      buId: user.activeBusinessUnitId || null,
      isSuperAdmin: !!user.isSuperAdmin,
      roleId: user.roleId || null,
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
