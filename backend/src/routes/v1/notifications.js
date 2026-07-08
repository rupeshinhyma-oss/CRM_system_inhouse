const express = require('express');
const { db } = require('../../db/db');
const { requireAuth } = require('../../middleware/authGuards');
const { ok, paginate } = require('../../utils/respond');

const router = express.Router();

// GET /api/v1/notifications?unreadOnly=&page=&pageSize=
router.get('/', requireAuth, (req, res) => {
  let notifications = db.get('notifications').filter({ userId: req.user.uid }).value();
  if (req.query.unreadOnly === 'true') notifications = notifications.filter((n) => !n.read);
  notifications = [...notifications].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const { items, meta } = paginate(notifications, { page: req.query.page, pageSize: req.query.pageSize });
  ok(res, items, meta);
});

// POST /api/v1/notifications/:id/read
router.post('/:id/read', requireAuth, (req, res) => {
  const updated = db.get('notifications').find({ id: req.params.id, userId: req.user.uid }).assign({ read: true }).write();
  ok(res, updated);
});

// POST /api/v1/notifications/read-all
router.post('/read-all', requireAuth, (req, res) => {
  db.get('notifications').filter({ userId: req.user.uid }).each((n) => { n.read = true; }).write();
  ok(res, { ok: true });
});

module.exports = router;
