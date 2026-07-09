const express = require('express');
const repo = require('../../db');
const { requireAuth, requirePermission } = require('../../middleware/authGuards');
const { ok, paginate } = require('../../utils/respond');

const router = express.Router();

router.get('/', requireAuth, requirePermission('admin.audit'), async (req, res) => {
  const { entityType, userId, action, page, pageSize } = req.query;
  let logs = req.user.isSuperAdmin ? await repo.list('auditLogs') : await repo.list('auditLogs', { orgId: req.user.orgId });

  if (entityType) logs = logs.filter((l) => l.entityType === entityType);
  if (userId) logs = logs.filter((l) => l.userId === userId);
  if (action) logs = logs.filter((l) => l.action === action);
  logs = [...logs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const { items, meta } = paginate(logs, { page, pageSize });
  ok(res, items, meta);
});

module.exports = router;
