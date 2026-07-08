const express = require('express');
const { db } = require('../../db/db');
const { requireAuth, requirePermission } = require('../../middleware/authGuards');
const { ok, paginate } = require('../../utils/respond');

const router = express.Router();

// GET /api/v1/audit-logs?entityType=&userId=&action=&page=&pageSize=
// Super Admin sees everything; org admins (admin.audit) see only their own org's logs.
router.get('/', requireAuth, requirePermission('admin.audit'), (req, res) => {
  const { entityType, userId, action, page, pageSize } = req.query;
  let logs = req.user.isSuperAdmin ? db.get('auditLogs').value() : db.get('auditLogs').filter({ orgId: req.user.orgId }).value();

  if (entityType) logs = logs.filter((l) => l.entityType === entityType);
  if (userId) logs = logs.filter((l) => l.userId === userId);
  if (action) logs = logs.filter((l) => l.action === action);
  logs = [...logs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const { items, meta } = paginate(logs, { page, pageSize });
  ok(res, items, meta);
});

module.exports = router;
