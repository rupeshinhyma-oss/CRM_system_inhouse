const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const adapter = new FileSync(path.join(__dirname, 'data.json'));
const db = low(adapter);

// Schema: users, departments, groups, groupMembers, conversations, messages, notifications
db.defaults({
  users: [],
  departments: [
    { id: 'dept-eng', name: 'Engineering', description: 'Product & platform engineering' },
    { id: 'dept-sales', name: 'Sales', description: 'Revenue team' },
    { id: 'dept-hr', name: 'HR', description: 'People operations' },
  ],
  groups: [],
  groupMembers: [],
  conversations: [],
  messages: [],
  notifications: [],
}).write();

/**
 * Generates a unique @username from a display name, e.g.
 * "John Smith" -> @johnsmith, then @johnsmith2, @johnsmith3, ...
 */
function generateUsername(displayName) {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20) || 'user';

  const existing = new Set(db.get('users').map((u) => u.username).value());

  if (!existing.has(base)) return base;

  let n = 2;
  while (existing.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

module.exports = { db, generateUsername };
