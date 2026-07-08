const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, email, ...safe } = u;
  return safe; // email hidden from other employees per spec; admins get it via /admin routes
}

// GET /api/v1/users?search=john
router.get('/', requireAuth, (req, res) => {
  const { search } = req.query;
  let users = db.get('users').value();
  if (search) {
    const q = search.toLowerCase();
    users = users.filter(
      (u) => u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q)
    );
  }
  res.json(users.map(publicUser));
});

// GET /api/v1/users/:id
router.get('/:id', requireAuth, (req, res) => {
  const user = db.get('users').find({ id: req.params.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(user));
});

// PATCH /api/v1/users/me  (edit own profile)
router.patch('/me/profile', requireAuth, (req, res) => {
  const allowed = ['displayName', 'avatarUrl', 'designation', 'bio', 'phone', 'timezone', 'language', 'departmentId'];
  const updates = {};
  for (const key of allowed) if (key in req.body) updates[key] = req.body[key];

  const updated = db.get('users').find({ id: req.user.uid }).assign(updates).write();
  res.json(publicUser(updated));
});

// --- Admin-only user management ---

// POST /api/v1/users/admin/:id/disable
router.post('/admin/:id/disable', requireAuth, requireAdmin, (req, res) => {
  const updated = db.get('users').find({ id: req.params.id }).assign({ enabled: false }).write();
  if (!updated) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(updated));
});

// POST /api/v1/users/admin/:id/enable
router.post('/admin/:id/enable', requireAuth, requireAdmin, (req, res) => {
  const updated = db.get('users').find({ id: req.params.id }).assign({ enabled: true }).write();
  if (!updated) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(updated));
});

// DELETE /api/v1/users/admin/:id
router.delete('/admin/:id', requireAuth, requireAdmin, (req, res) => {
  db.get('users').remove({ id: req.params.id }).write();
  res.status(204).send();
});

module.exports = router;
