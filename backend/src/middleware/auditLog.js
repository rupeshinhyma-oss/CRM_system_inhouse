const { v4: uuidv4 } = require('uuid');
const { db, nowIso } = require('../db/db');

/**
 * Call this directly from a controller/service right after a mutation:
 *   recordAudit(req, { action: 'lead.create', entityType: 'lead', entityId: lead.id, newValue: lead });
 */
function recordAudit(req, { action, entityType, entityId, oldValue = null, newValue = null }) {
  db.get('auditLogs').push({
    id: uuidv4(),
    orgId: req.user?.orgId || null,
    userId: req.user?.uid || null,
    action,
    entityType,
    entityId,
    oldValue,
    newValue,
    ip: req.ip,
    userAgent: req.headers['user-agent'] || null,
    createdAt: nowIso(),
  }).write();
}

module.exports = { recordAudit };
