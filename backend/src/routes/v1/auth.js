const express = require('express');
const bcrypt = require('bcryptjs');
const repo = require('../../db');
const { createOrganizationWithOwner } = require('../../services/organizationService');
const {
  signAccessToken, issueRefreshToken, rotateRefreshToken, revokeAllRefreshTokensForUser,
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

// POST /api/v1/auth/register-organization
// { orgName, ownerEmail, ownerPassword, ownerDisplayName, industry?, country? }
// Public self-service signup — creates a brand-new tenant + its Owner. (The
// single Super Admin account is created separately, once, via /api/v1/setup —
// see routes/v1/setup.js — never through this endpoint.)
router.post('/register-organization', async (req, res) => {
  const { orgName, ownerEmail, ownerPassword, ownerDisplayName, industry, country } = req.body || {};
  if (!orgName || !ownerEmail || !ownerPassword || !ownerDisplayName) {
    return fail(res, 400, 'orgName, ownerEmail, ownerPassword and ownerDisplayName are required');
  }
  if (ownerPassword.length < 8) return fail(res, 400, 'Password must be at least 8 characters');

  try {
    const { organization, owner } = await createOrganizationWithOwner({
      orgName, ownerEmail, ownerPassword, ownerDisplayName, industry, country,
    });
    const accessToken = signAccessToken(owner);
    const refreshToken = await issueRefreshToken(owner, { ip: req.ip, userAgent: req.headers['user-agent'] });
    created(res, { organization, user: publicUser(owner), accessToken, refreshToken });
  } catch (err) {
    fail(res, err.status || 500, err.message || 'Failed to create organization');
  }
});

// POST /api/v1/auth/login  { email, password }
// Works for regular users, org owners, AND the single Super Admin account.
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 400, 'email and password are required');

  const user = await repo.findOne('users', { email: email.toLowerCase().trim() });
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return fail(res, 401, 'Invalid email or password');
  }
  if (!user.enabled) return fail(res, 403, 'This account has been disabled');
  if (user.orgId) {
    const org = await repo.findById('organizations', user.orgId);
    if (org && org.status !== 'ACTIVE') return fail(res, 403, `Organization is ${org.status.toLowerCase()}`);
  }

  await repo.updateById('users', user.id, { lastLoginAt: nowIso() });

  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user, { ip: req.ip, userAgent: req.headers['user-agent'] });
  ok(res, { user: publicUser(user), accessToken, refreshToken });
});

// POST /api/v1/auth/refresh  { refreshToken }
// Rotating refresh tokens: old one is revoked, a new one is issued every time.
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return fail(res, 400, 'refreshToken is required');

  const result = await rotateRefreshToken(refreshToken, { ip: req.ip, userAgent: req.headers['user-agent'] });
  if (!result) return fail(res, 401, 'Invalid, expired, or already-used refresh token');
  ok(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });
});

// POST /api/v1/auth/logout — revokes all refresh tokens for this user (all devices)
router.post('/logout', requireAuth, async (req, res) => {
  await revokeAllRefreshTokensForUser(req.user.uid);
  ok(res, { loggedOut: true });
});

// GET /api/v1/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const user = await repo.findById('users', req.user.uid);
  if (!user) return fail(res, 404, 'User not found');
  const role = user.roleId ? await repo.findById('roles', user.roleId) : null;
  ok(res, { ...publicUser(user), role: role ? { id: role.id, key: role.key, label: role.label } : null });
});

module.exports = router;
