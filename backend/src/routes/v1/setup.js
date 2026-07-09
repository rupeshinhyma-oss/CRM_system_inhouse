const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const repo = require('../../db');
const { nowIso } = require('../../utils/time');
const { signAccessToken, issueRefreshToken } = require('../../middleware/tokens');
const { ok, created, fail } = require('../../utils/respond');

const router = express.Router();

/**
 * There must only ever be ONE Super Admin. Instead of seeding one from
 * environment variables at boot, the very first person to open this app
 * creates it themselves through a real signup form (see the frontend's
 * "System setup" screen). Once that account exists, this endpoint locks
 * itself permanently — there is no way to create a second Super Admin
 * through the API.
 */

// GET /api/v1/setup/status — the frontend checks this on load to decide
// whether to show "create your Super Admin account" or the normal login screen.
router.get('/status', async (req, res) => {
  const existing = await repo.findOne('users', { isSuperAdmin: true });
  ok(res, { superAdminExists: !!existing });
});

// POST /api/v1/setup/super-admin  { email, password, displayName }
// Only works once, ever. Logs the new Super Admin in immediately.
router.post('/super-admin', async (req, res) => {
  const existing = await repo.findOne('users', { isSuperAdmin: true });
  if (existing) return fail(res, 409, 'A Super Admin already exists. This setup step has already been completed.');

  const { email, password, displayName } = req.body || {};
  if (!email || !password || !displayName) return fail(res, 400, 'email, password and displayName are required');
  if (password.length < 8) return fail(res, 400, 'Password must be at least 8 characters');

  const emailLower = email.toLowerCase().trim();
  if (await repo.findOne('users', { email: emailLower })) {
    return fail(res, 409, 'An account with this email already exists');
  }

  const superAdmin = await repo.insert('users', {
    id: uuidv4(),
    orgId: null,
    email: emailLower,
    passwordHash: bcrypt.hashSync(password, 10),
    displayName,
    avatarUrl: null,
    isSuperAdmin: true,
    roleId: null,
    status: 'OFFLINE',
    enabled: true,
    lastLoginAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  const accessToken = signAccessToken(superAdmin);
  const refreshToken = await issueRefreshToken(superAdmin, { ip: req.ip, userAgent: req.headers['user-agent'] });
  const { passwordHash, ...safe } = superAdmin;
  created(res, { user: safe, accessToken, refreshToken });
});

module.exports = router;
