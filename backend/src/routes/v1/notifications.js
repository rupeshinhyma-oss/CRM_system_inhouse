const express = require('express');
const repo = require('../../db');
const { requireAuth } = require('../../middleware/authGuards');
const { ok, paginate } = require('../../utils/respond');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  let notifications = await repo.list('notifications', { userId: req.user.uid });
  if (req.query.unreadOnly === 'true') notifications = notifications.filter((n) => !n.read);
  notifications = [...notifications].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const { items, meta } = paginate(notifications, { page: req.query.page, pageSize: req.query.pageSize });
  ok(res, items, meta);
});

router.post('/:id/read', requireAuth, async (req, res) => {
  const updated = await repo.updateById('notifications', req.params.id, { read: true });
  ok(res, updated);
});

router.post('/read-all', requireAuth, async (req, res) => {
  await repo.updateWhere('notifications', { userId: req.user.uid }, { read: true });
  ok(res, { ok: true });
});

module.exports = router;
