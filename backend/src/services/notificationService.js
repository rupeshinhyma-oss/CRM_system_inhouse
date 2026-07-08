const { v4: uuidv4 } = require('uuid');
const { db, nowIso } = require('../db/db');

/**
 * Creates an in-app notification. `channel` records intent for future
 * fan-out (email/push/SMS/WhatsApp workers reading this table), even though
 * only in-app delivery is wired up today.
 */
function notify({ orgId, userId, type, title, body, channel = 'IN_APP' }) {
  const notification = {
    id: uuidv4(), orgId, userId, type, title, body, read: false, channel, createdAt: nowIso(),
  };
  db.get('notifications').push(notification).write();
  return notification;
}

module.exports = { notify };
