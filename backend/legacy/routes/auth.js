const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db, generateUsername } = require('../db');
const { signAccessToken, signRefreshToken, verifyToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

function publicUser(u) {
  const { passwordHash, ...safe } = u;
  return safe;
}

// POST /api/v1/auth/register  { email, password, displayName, departmentId? }
router.post('/register', (req, res) => {
  const { email, password, displayName, departmentId } = req.body || {};
  if (!email || !password || !displayName) {
    return res.status(400).json({ error: 'email, password and displayName are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const emailLower = email.toLowerCase().trim();
  const exists = db.get('users').find({ email: emailLower }).value();
  if (exists) return res.status(409).json({ error: 'An account with this email already exists' });

  const user = {
    id: uuidv4(),
    email: emailLower,
    passwordHash: bcrypt.hashSync(password, 10),
    username: generateUsername(displayName),
    displayName,
    avatarUrl: null,
    designation: null,
    bio: '',
    phone: null,
    timezone: 'UTC',
    language: 'en',
    departmentId: departmentId || null,
    status: 'OFFLINE',
    role: db.get('users').size().value() === 0 ? 'SYSTEM_ADMIN' : 'EMPLOYEE', // first user bootstraps as admin
    enabled: true,
    lastSeenAt: null,
    createdAt: new Date().toISOString(),
  };

  db.get('users').push(user).write();

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  res.status(201).json({ user: publicUser(user), accessToken, refreshToken });
});

// POST /api/v1/auth/login  { email, password }
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const user = db.get('users').find({ email: email.toLowerCase().trim() }).value();
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.enabled) return res.status(403).json({ error: 'This account has been disabled' });

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  res.json({ user: publicUser(user), accessToken, refreshToken });
});

// POST /api/v1/auth/refresh  { refreshToken }
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });
  try {
    const payload = verifyToken(refreshToken);
    if (payload.type !== 'refresh') throw new Error('not a refresh token');
    const user = db.get('users').find({ id: payload.uid }).value();
    if (!user || !user.enabled) return res.status(401).json({ error: 'User not found or disabled' });
    res.json({ accessToken: signAccessToken(user) });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// GET /api/v1/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.get('users').find({ id: req.user.uid }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(user));
});

module.exports = router;
