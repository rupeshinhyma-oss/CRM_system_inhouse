// FILE: backend/src/middleware/tokens.js
// REWRITTEN for the Identity -> Membership -> Organization model (see
// services/identityService.js). The token no longer belongs to one
// `users` row in one organization — it belongs to an IDENTITY (one login),
// with a separate `activeOrgId` claim for whichever organization that
// identity is currently working in. Switching organizations now means
// re-signing this token with a different activeOrgId — no database writes
// to any user/identity record, and no more "orgId is baked into who I am."

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
 * Signs a short-lived JWT access token for an Identity, scoped to one
 * active organization (or no organization, for a Super Admin at the
 * platform level, or an identity with no orgs yet).
 *
 * `activeOrgId` resolution order:
 *   1. Explicit `activeOrgId` passed in (e.g. from /auth/switch-organization)
 *   2. identity.defaultOrganizationId (first org they ever created)
 *   3. null (no organization context — platform-level / onboarding)
 *
 * The token also carries the resolved per-org PROFILE (`users` row) for
 * activeOrgId, if one exists — `uid` — so every existing route that already
 * does `repo.findById('users', req.user.uid)` / filters by `req.user.orgId`
 * keeps working completely unchanged. Only Super Admins and brand-new
 * identities with zero organizations will have `uid: null`.
 */
async function signAccessToken(identity, { activeOrgId } = {}) {
  const resolvedOrgId = activeOrgId !== undefined ? activeOrgId : (identity.defaultOrganizationId || null);

  let profile = null;
  if (resolvedOrgId) {
    const membership = await repo.findOne('organizationMembers', {
      identityId: identity.id, organizationId: resolvedOrgId, status: 'ACTIVE',
    });
    if (membership) profile = await repo.findById('users', membership.userProfileId);
  }

  // A Super Admin has NO organization membership by design (see
  // services/identityService.js header + routes/v1/organizations.js
  // switch-context) — they view/manage a tenant without being a member of
  // it. So `profile` will always be null for them, even while
  // activeOrgId correctly points at the tenant they've switched into.
  // Every org-scoped route in this app (users.invite, roles.list, etc.)
  // reads req.user.orgId — NOT req.user.activeOrgId — to know which
  // tenant to operate on, so orgId must still resolve to resolvedOrgId
  // for a Super Admin, or every action they take while "inside" a tenant
  // silently operates on orgId: null instead of the tenant they're
  // looking at (this was the bug behind invited teammates being created
  // with no organizationId and being unable to log in).
  const effectiveOrgId = profile ? profile.orgId : (identity.isSuperAdmin ? resolvedOrgId : null);
  const effectiveBuId = profile ? (profile.activeBusinessUnitId || null) : null;
  const effectiveRoleId = profile ? (profile.roleId || null) : null;

  return jwt.sign(
    {
      identityId: identity.id,
      // Backwards-compatible claims so every existing route (which reads
      // req.user.uid / req.user.orgId / req.user.buId / req.user.roleId)
      // keeps working with zero changes elsewhere in the codebase.
      uid: profile ? profile.id : null,
      orgId: effectiveOrgId,
      buId: effectiveBuId,
      roleId: effectiveRoleId,
      isSuperAdmin: !!identity.isSuperAdmin,
      activeOrgId: resolvedOrgId,
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

/** Verifies a JWT access token, returns its payload, or throws if invalid/expired. */
function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/** Same as issueRefreshToken but pins a specific activeOrgId (used by rotation and org-switching). */
async function issueRefreshTokenWithOrg(identity, activeOrgId, meta = {}) {
  const token = uuidv4() + uuidv4(); // opaque, unguessable
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await repo.insert('refreshTokens', {
    id: uuidv4(),
    token,
    identityId: identity.id,
    activeOrgId: activeOrgId || null,
    ip: meta.ip || null,
    userAgent: meta.userAgent || null,
    revoked: false,
    expiresAt,
    createdAt: nowIso(),
  });
  return token;
}

/** Issues a new opaque refresh token, defaulting activeOrgId to the identity's default organization. */
async function issueRefreshToken(identity, meta = {}) {
  return issueRefreshTokenWithOrg(identity, identity.defaultOrganizationId || null, meta);
}

/**
 * Validates + rotates a refresh token: revokes the old one, issues a new
 * pair, preserving activeOrgId.
 *
 * GRACE WINDOW: rotation is inherently racy across multiple browser tabs
 * (each tab has its own JS memory/in-flight-refresh tracking — see
 * frontend/app.js tryRefreshToken — so one tab can't stop another tab from
 * also trying to redeem the same refresh token at nearly the same moment).
 * Rather than hard-failing the loser (which force-logs the person out even
 * though their session is perfectly valid), a refresh token that was
 * rotated within the last few seconds still hands back the SAME new
 * token pair it already issued, instead of a fresh one. This keeps
 * rotation meaningfully single-use (a token that's actually old/stolen
 * still gets rejected) while not punishing ordinary multi-tab usage or
 * a burst of parallel requests on page load.
 */
const ROTATION_GRACE_MS = 10_000;

async function rotateRefreshToken(oldToken, meta = {}) {
  const record = await repo.findOne('refreshTokens', { token: oldToken });
  if (!record) return null;

  if (record.revoked) {
    // Already used — but if it was used VERY recently, this is almost
    // certainly a racing duplicate call for the same rotation (another
    // tab, or a parallel request), not a replay of a stale/stolen token.
    // Hand back the replacement token pair that rotation already produced
    // instead of failing.
    if (record.replacedByToken && record.revokedAt && (Date.now() - new Date(record.revokedAt).getTime()) < ROTATION_GRACE_MS) {
      const nextRecord = await repo.findOne('refreshTokens', { token: record.replacedByToken });
      if (nextRecord && !nextRecord.revoked && new Date(nextRecord.expiresAt) > new Date()) {
        const identity = await repo.findById('identities', nextRecord.identityId);
        if (identity && identity.status === 'ACTIVE') {
          const accessToken = await signAccessToken(identity, { activeOrgId: nextRecord.activeOrgId });
          return { accessToken, refreshToken: nextRecord.token };
        }
      }
    }
    return null;
  }

  if (new Date(record.expiresAt) < new Date()) return null;

  const identity = await repo.findById('identities', record.identityId);
  if (!identity || identity.status !== 'ACTIVE') return null;

  const refreshToken = await issueRefreshTokenWithOrg(identity, record.activeOrgId, meta);
  await repo.updateById('refreshTokens', record.id, { revoked: true, revokedAt: nowIso(), replacedByToken: refreshToken });

  const accessToken = await signAccessToken(identity, { activeOrgId: record.activeOrgId });
  return { accessToken, refreshToken };
}

/** Revokes every refresh token for an Identity (e.g. on logout / "log out everywhere"). */
async function revokeAllRefreshTokensForIdentity(identityId) {
  await repo.updateWhere('refreshTokens', { identityId, revoked: false }, { revoked: true });
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  issueRefreshTokenWithOrg,
  rotateRefreshToken,
  revokeAllRefreshTokensForIdentity,
};
