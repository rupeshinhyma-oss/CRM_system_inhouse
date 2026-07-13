// FILE: backend/src/routes/v1/setup.js
// REWRITTEN for the Identity -> Membership -> Organization model. The
// Super Admin's email + password now live on an IDENTITY row (isSuperAdmin:
// true, no organization memberships), same as every other login — not on a
// `users` row, since `users` is now purely a per-organization profile with
// no password of its own (see services/identityService.js).
//
// There must only ever be ONE Super Admin. Instead of seeding one from
// environment variables at boot, the very first person to open this app
// creates it themselves through a real signup form (see the frontend's
// "System setup" screen). Once that account exists, this endpoint locks
// itself permanently — there is no way to create a second Super Admin
// through the API.

const express = require('express');
const repo = require('../../db');
const identityService = require('../../services/identityService');
const { signAccessToken, issueRefreshTokenWithOrg } = require('../../middleware/tokens');
const { ok, created, fail } = require('../../utils/respond');

const router = express.Router();

// GET /api/v1/setup/status — the frontend checks this on load to decide
// whether to show "create your Super Admin account" or the normal login screen.
router.get('/status', async (req, res) => {
  const existing = await repo.findOne('identities', { isSuperAdmin: true });
  ok(res, { superAdminExists: !!existing });
});

// POST /api/v1/setup/super-admin  { email, password, displayName }
// Only works once, ever. Logs the new Super Admin in immediately.
router.post('/super-admin', async (req, res) => {
  const existing = await repo.findOne('identities', { isSuperAdmin: true });
  if (existing) return fail(res, 409, 'A Super Admin already exists. This setup step has already been completed.');

  const { email, password, displayName } = req.body || {};
  if (!email || !password || !displayName) return fail(res, 400, 'email, password and displayName are required');
  if (password.length < 8) return fail(res, 400, 'Password must be at least 8 characters');

  try {
    const identity = await identityService.createIdentity({ email, password, displayName });
    await repo.updateById('identities', identity.id, { isSuperAdmin: true, lastLoginAt: new Date().toISOString() });
    const refreshedIdentity = await repo.findById('identities', identity.id);

    const accessToken = await signAccessToken(refreshedIdentity, { activeOrgId: null });
    const refreshToken = await issueRefreshTokenWithOrg(refreshedIdentity, null, { ip: req.ip, userAgent: req.headers['user-agent'] });
    created(res, { identity: identityService.publicIdentity(refreshedIdentity), accessToken, refreshToken });
  } catch (err) {
    fail(res, err.status || 500, err.message || 'Failed to create Super Admin');
  }
});

module.exports = router;
