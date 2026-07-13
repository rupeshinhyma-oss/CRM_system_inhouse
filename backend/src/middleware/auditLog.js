const { v4: uuidv4 } = require('uuid');
const repo = require('../db');
const { nowIso } = require('../utils/time');

/**
 * Call this directly from a controller/service right after a mutation:
 *   await recordAudit(req, { action: 'lead.create', entityType: 'lead', entityId: lead.id, newValue: lead });
 */
async function recordAudit(req, { action, entityType, entityId, oldValue = null, newValue = null }) {
  await repo.insert('auditLogs', {
    id: uuidv4(),
    orgId: req.user?.orgId || null,
    businessUnitId: req.user?.buId || null,
    userId: req.user?.uid || null,
    action,
    entityType,
    entityId,
    oldValue,
    newValue,
    ip: req.ip,
    userAgent: req.headers['user-agent'] || null,
    createdAt: nowIso(),
  });
}

module.exports = { recordAudit };
