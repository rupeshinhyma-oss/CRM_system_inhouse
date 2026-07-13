// FILE: backend/src/routes/v1/auth.js
// REWRITTEN for the Identity -> Membership -> Organization model.
//
// KEY CHANGE FROM BEFORE: email + password now belong to an IDENTITY (one
// real login), not to a single organization. One identity can own/belong to
// many organizations (Slack/Notion/GitHub-style), so:
//   - /auth/register creates an IDENTITY (no organization yet).
//   - /auth/register-organization creates an identity AND its first org in
//     one step (kept for the public "sign up" page, where you don't have an
//     identity yet at all).
//   - /auth/login authenticates the IDENTITY once — no more picking a
//     random per-org row for a repeated email — then opens their default
//     organization automatically.
//   - /auth/switch-organization moves the *token's* activeOrgId to a
//     different organization this identity belongs to. No database writes
//     to the identity or any user profile — just a freshly-signed token.
//   - /auth/me now returns identity + activeOrganization + the full list of
//     organization memberships, so the frontend can render an org switcher.

const express = require('express');
const repo = require('../../db');
const identityService = require('../../services/identityService');
const { createOrganizationForIdentity } = identityService;
const {
  signAccessToken, issueRefreshTokenWithOrg, rotateRefreshToken, revokeAllRefreshTokensForIdentity,
} = require('../../middleware/tokens');
const { requireAuth } = require('../../middleware/authGuards');
const { nowIso } = require('../../utils/time');
const { ok, created, fail } = require('../../utils/respond');

const router = express.Router();

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

// POST /api/v1/auth/register  { email, password, displayName }
// Creates a brand-new IDENTITY only — no organization yet. Used when
// someone wants an account first and will create/join an organization
// afterwards (mirrors "Create your account" as a separate step from
// "Create a workspace" in Slack/Notion).
router.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!email || !password || !displayName) {
    return fail(res, 400, 'email, password and displayName are required');
  }
  if (password.length < 8) return fail(res, 400, 'Password must be at least 8 characters');

  try {
    const identity = await identityService.createIdentity({ email, password, displayName });
    const accessToken = await signAccessToken(identity, { activeOrgId: null });
    const refreshToken = await issueRefreshTokenWithOrg(identity, null, { ip: req.ip, userAgent: req.headers['user-agent'] });
    created(res, { identity: identityService.publicIdentity(identity), accessToken, refreshToken });
  } catch (err) {
    fail(res, err.status || 500, err.message || 'Failed to create account');
  }
});

// POST /api/v1/auth/register-organization
// { orgName, ownerEmail, ownerPassword, ownerDisplayName, industry?, country? }
// Public self-service signup — creates a brand-new Identity (if that email
// isn't registered yet) AND its first Organization in one step. This is the
// ONLY place an email + password is required alongside organization details
// — because at this point there is no logged-in identity yet at all.
// (The single Super Admin account is created separately, once, via
// /api/v1/setup — see routes/v1/setup.js — never through this endpoint.)
router.post('/register-organization', async (req, res) => {
  const { orgName, ownerEmail, ownerPassword, ownerDisplayName, industry, country } = req.body || {};
  if (!orgName || !ownerEmail || !ownerPassword || !ownerDisplayName) {
    return fail(res, 400, 'orgName, ownerEmail, ownerPassword and ownerDisplayName are required');
  }
  if (ownerPassword.length < 8) return fail(res, 400, 'Password must be at least 8 characters');

  try {
    let identity = await identityService.findIdentityByEmail(ownerEmail);
    if (identity) {
      // Email already has an identity — this becomes "create another
      // organization under my existing account," same as the authenticated
      // /organizations flow, just reached from the public signup page.
      const validPassword = await identityService.verifyPassword(identity, ownerPassword);
      if (!validPassword) return fail(res, 409, 'An account with this email already exists');
    } else {
      identity = await identityService.createIdentity({ email: ownerEmail, password: ownerPassword, displayName: ownerDisplayName });
    }

    const { organization, profile } = await createOrganizationForIdentity(identity, { orgName, industry, country });

    const accessToken = await signAccessToken(identity, { activeOrgId: organization.id });
    const refreshToken = await issueRefreshTokenWithOrg(identity, organization.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    created(res, { organization, user: publicUser(profile), accessToken, refreshToken });
  } catch (err) {
    fail(res, err.status || 500, err.message || 'Failed to create organization');
  }
});

// POST /api/v1/auth/login  { email, password }
// Authenticates the IDENTITY exactly once — no ambiguity even if this email
// owns many organizations, because there is only ONE identity row per
// email now. Opens the identity's default organization automatically
// (mirrors Slack: log in once, land in your last/default workspace).
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 400, 'email and password are required');

  const identity = await identityService.findIdentityByEmail(email);
  if (!identity || !(await identityService.verifyPassword(identity, password))) {
    return fail(res, 401, 'Invalid email or password');
  }
  if (identity.status !== 'ACTIVE') return fail(res, 403, 'This account has been disabled');

  // Super Admin has no organization context at all.
  let activeOrgId = null;
  if (!identity.isSuperAdmin) {
    activeOrgId = identity.defaultOrganizationId || null;
    // Guard against a stale/deleted default org — fall back to any other
    // active membership so login never silently 401s for a real user.
    if (activeOrgId) {
      const org = await repo.findById('organizations', activeOrgId);
      if (!org || org.status === 'DELETED') activeOrgId = null;
    }
    if (!activeOrgId) {
      const memberships = await identityService.listMembershipsForIdentity(identity.id);
      if (memberships.length) activeOrgId = memberships[0].organizationId;
    }
    if (activeOrgId) {
      const org = await repo.findById('organizations', activeOrgId);
      if (org && org.status !== 'ACTIVE') return fail(res, 403, `Organization is ${org.status.toLowerCase()}`);
    }
  }

  await repo.updateById('identities', identity.id, { lastLoginAt: nowIso() });

  const accessToken = await signAccessToken(identity, { activeOrgId });
  const refreshToken = await issueRefreshTokenWithOrg(identity, activeOrgId, { ip: req.ip, userAgent: req.headers['user-agent'] });

  let profile = null;
  if (activeOrgId) {
    const membership = await identityService.getMembership(identity.id, activeOrgId);
    if (membership) profile = await repo.findById('users', membership.userProfileId);
  }

  ok(res, { identity: identityService.publicIdentity(identity), user: publicUser(profile), activeOrgId, accessToken, refreshToken });
});

// POST /api/v1/auth/switch-organization  { organizationId }
// Moves this identity's ACTIVE organization context. No database writes to
// the identity or any user profile — just a freshly-signed token pair with
// a different activeOrgId claim. Requires the identity to actually have an
// active membership in that organization.
router.post('/switch-organization', requireAuth, async (req, res) => {
  const { organizationId } = req.body || {};
  if (!organizationId) return fail(res, 400, 'organizationId is required');

  const identity = await repo.findById('identities', req.user.identityId);
  if (!identity) return fail(res, 404, 'Identity not found');

  if (!identity.isSuperAdmin) {
    const membership = await identityService.getMembership(identity.id, organizationId);
    if (!membership) return fail(res, 403, 'You are not a member of this organization');
    const org = await repo.findById('organizations', organizationId);
    if (!org || org.status === 'DELETED') return fail(res, 404, 'Organization not found');
    if (org.status !== 'ACTIVE') return fail(res, 403, `Organization is ${org.status.toLowerCase()}`);
  }

  const accessToken = await signAccessToken(identity, { activeOrgId: organizationId });
  const refreshToken = await issueRefreshTokenWithOrg(identity, organizationId, { ip: req.ip, userAgent: req.headers['user-agent'] });
  ok(res, { accessToken, refreshToken, activeOrgId: organizationId });
});

// POST /api/v1/auth/refresh  { refreshToken }
// Rotating refresh tokens: old one is revoked, a new one is issued every
// time, preserving whichever organization was active.
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return fail(res, 400, 'refreshToken is required');

  const result = await rotateRefreshToken(refreshToken, { ip: req.ip, userAgent: req.headers['user-agent'] });
  if (!result) return fail(res, 401, 'Invalid, expired, or already-used refresh token');
  ok(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });
});

// POST /api/v1/auth/logout — revokes all refresh tokens for this identity (all devices, all orgs)
router.post('/logout', requireAuth, async (req, res) => {
  await revokeAllRefreshTokensForIdentity(req.user.identityId);
  ok(res, { loggedOut: true });
});

// GET /api/v1/auth/me
// Returns the identity, the currently-active organization (if any), the
// per-org profile for that organization, and the FULL list of organization
// memberships — everything the frontend needs to render an org switcher
// without a second round-trip.
router.get('/me', requireAuth, async (req, res) => {
  const identity = await repo.findById('identities', req.user.identityId);
  if (!identity) return fail(res, 404, 'Identity not found');

  const memberships = identity.isSuperAdmin ? [] : await identityService.listMembershipsForIdentity(identity.id);

  let activeOrganization = null;
  let profile = null;
  let role = null;
  if (req.user.activeOrgId) {
    activeOrganization = await repo.findById('organizations', req.user.activeOrgId);
    const membership = memberships.find((m) => m.organizationId === req.user.activeOrgId);
    profile = membership ? membership.profile : null;
    if (profile?.roleId) role = await repo.findById('roles', profile.roleId);
  }

  ok(res, {
    identity: identityService.publicIdentity(identity),
    activeOrganization,
    activeOrgId: req.user.activeOrgId || null,
    // `user` kept for backward compatibility with existing frontend code
    // that reads state.me.displayName / state.me.isSuperAdmin / etc.
    ...publicUser(profile),
    isSuperAdmin: !!identity.isSuperAdmin,
    displayName: profile?.displayName || identity.displayName,
    role: role ? { id: role.id, key: role.key, label: role.label } : null,
    memberships: memberships.map((m) => ({
      organizationId: m.organizationId,
      organizationName: m.organizationName,
      organizationStatus: m.organizationStatus,
      role: m.role,
    })),
  });
});

module.exports = router;
