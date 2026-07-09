const { v4: uuidv4 } = require('uuid');
const repo = require('../db');
const { nowIso } = require('../utils/time');

/**
 * Creates an in-app notification. `channel` records intent for future
 * fan-out (email/push/SMS/WhatsApp workers reading this table), even though
 * only in-app delivery is wired up today.
 */
async function notify({ orgId, userId, type, title, body, channel = 'IN_APP' }) {
  return repo.insert('notifications', {
    id: uuidv4(), orgId, userId, type, title, body, read: false, channel, createdAt: nowIso(),
  });
}

module.exports = { notify };
