const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const adapter = new FileSync(path.join(__dirname, '..', '..', '..', 'data.json'));
const db = low(adapter);

// Every collection the app uses. Adding a new feature that needs storage
// means adding one line here — nothing else about this driver changes.
const COLLECTIONS = [
  'organizations', 'users', 'roles', 'rolePermissions', 'userPermissionOverrides',
  'departments', 'teams', 'teamMembers', 'refreshTokens', 'auditLogs', 'notifications',
  'sharedOrganizations', 'sharedResourceGrants',
  'contacts', 'companies', 'leads', 'deals', 'tags',
  'groups', 'groupMembers', 'conversations', 'messages',
];

const defaults = {};
COLLECTIONS.forEach((c) => { defaults[c] = []; });
db.defaults(defaults).write();

function matches(doc, filter) {
  return Object.keys(filter).every((key) => doc[key] === filter[key]);
}

async function list(collection, filter = {}) {
  const all = db.get(collection).value() || [];
  if (!Object.keys(filter).length) return [...all];
  return all.filter((doc) => matches(doc, filter));
}

async function findOne(collection, filter = {}) {
  const all = db.get(collection).value() || [];
  return all.find((doc) => matches(doc, filter)) || null;
}

async function findById(collection, id) {
  return findOne(collection, { id });
}

async function insert(collection, doc) {
  db.get(collection).push(doc).write();
  return doc;
}

async function updateById(collection, id, patch) {
  const record = db.get(collection).find({ id }).value();
  if (!record) return null;
  db.get(collection).find({ id }).assign(patch).write();
  return db.get(collection).find({ id }).value();
}

async function updateWhere(collection, filter, patch) {
  const all = db.get(collection).value() || [];
  let count = 0;
  all.forEach((doc) => {
    if (matches(doc, filter)) {
      db.get(collection).find({ id: doc.id }).assign(patch).write();
      count++;
    }
  });
  return count;
}

async function removeById(collection, id) {
  const existed = !!db.get(collection).find({ id }).value();
  db.get(collection).remove({ id }).write();
  return existed;
}

async function removeWhere(collection, filter) {
  const all = db.get(collection).value() || [];
  const toRemove = all.filter((doc) => matches(doc, filter));
  db.get(collection).remove((doc) => matches(doc, filter)).write();
  return toRemove.length;
}

async function count(collection, filter = {}) {
  return (await list(collection, filter)).length;
}

module.exports = { list, findOne, findById, insert, updateById, updateWhere, removeById, removeWhere, count };
