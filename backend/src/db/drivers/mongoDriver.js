/**
 * MONGODB DRIVER — the only database driver this app uses.
 *
 * Activated via:
 *   1. npm install mongodb   (run inside backend/)
 *   2. DATABASE_URL=mongodb+srv://... set in .env
 *
 * Every doc this app produces already has an `id` field (uuid) that all
 * routes/services use as the primary key — so we always filter/query by
 * that `id` field, never Mongo's own `_id`. We strip `_id` out of every
 * returned doc so callers never see it and the shape stays identical to
 * what every route already expects.
 */

const { MongoClient } = require('mongodb');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Add it to your .env, ' +
    'e.g. DATABASE_URL=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/yourDbName'
  );
}

const client = new MongoClient(process.env.DATABASE_URL);
const dbPromise = client.connect().then(async (c) => {
  console.log('[db] MongoDB connected');
  const db = c.db(); // uses the db name from the DATABASE_URL path, e.g. /yourDbName
  await ensureIndexes(db);
  return db;
}).catch((err) => {
  console.error('[db] MongoDB connection failed:', err.message);
  if (err.codeName === 'AtlasError' || /bad auth/i.test(err.message)) {
    console.error(
      '[db] This is an authentication error from Atlas itself, not an app bug. Check:\n' +
      '  1. The username/password in DATABASE_URL match an existing Atlas Database Access user.\n' +
      '  2. Any special characters in the password are URL-encoded (@ : / ? # [ ] % etc).\n' +
      '  3. Network Access in Atlas allows connections from Render (0.0.0.0/0 or Render IPs).\n' +
      '  4. The cluster hostname in DATABASE_URL is correct.'
    );
  }
  process.exit(1); // fail fast with a clear log line instead of a raw unhandled-rejection trace
});

/**
 * Creates every index this app relies on for correctness (uniqueness) or
 * performance (hot lookup paths). Safe to run on every boot — createIndex
 * is a no-op if an identical index already exists, and Mongo auto-creates
 * a collection the first time an index is created on it, so this also
 * works correctly against a brand-new, totally empty database.
 *
 * IDENTITY MODEL (see services/identityService.js):
 *   - identities.email is the ONE piece of data in this whole app that is
 *     still globally unique — one identity per real login. This is
 *     enforced at the DB level here, not just in application code, so a
 *     race condition between two simultaneous signups can't create two
 *     identities with the same email.
 *   - organizationMembers has a compound unique index on
 *     (identityId, organizationId) — one membership row per identity per
 *     org, never duplicated, and it's also the index that makes
 *     "list every org this identity belongs to" and "is this identity a
 *     member of this org" fast instead of a full collection scan.
 *
 * Everything else here mirrors what used to be implicit full-collection
 * scans in the old lowdb driver — now indexed properly since Mongo is a
 * real networked database and those scans matter at scale.
 */
async function ensureIndexes(db) {
  const idx = (collection, spec, options) => db.collection(collection).createIndex(spec, options).catch((err) => {
    console.error(`[db] Failed to create index on ${collection}:`, err.message);
  });

  await Promise.all([
    // Every collection's own `id` (uuid) is the app-level primary key.
    idx('identities', { id: 1 }, { unique: true }),
    idx('identities', { email: 1 }, { unique: true }),
    idx('identities', { isSuperAdmin: 1 }),

    idx('organizations', { id: 1 }, { unique: true }),
    idx('organizations', { status: 1 }),

    idx('organizationMembers', { id: 1 }, { unique: true }),
    idx('organizationMembers', { identityId: 1, organizationId: 1 }, { unique: true }),
    idx('organizationMembers', { organizationId: 1, status: 1 }),

    idx('users', { id: 1 }, { unique: true }),
    idx('users', { orgId: 1 }),
    idx('users', { identityId: 1 }),
    idx('users', { orgId: 1, email: 1 }),

    idx('refreshTokens', { id: 1 }, { unique: true }),
    idx('refreshTokens', { token: 1 }, { unique: true }),
    idx('refreshTokens', { identityId: 1 }),

    idx('roles', { id: 1 }, { unique: true }),
    idx('roles', { orgId: 1 }),
    idx('rolePermissions', { roleId: 1 }),
    idx('userPermissionOverrides', { userId: 1 }),

    idx('businessUnits', { id: 1 }, { unique: true }),
    idx('businessUnits', { orgId: 1 }),
    idx('businessUnitMemberships', { businessUnitId: 1, userId: 1 }, { unique: true }),
    idx('businessUnitMemberships', { userId: 1, status: 1 }),

    idx('contacts', { id: 1 }, { unique: true }),
    idx('companies', { id: 1 }, { unique: true }),
    idx('leads', { id: 1 }, { unique: true }),
    idx('deals', { id: 1 }, { unique: true }),
    idx('tags', { id: 1 }, { unique: true }),
    ...['contacts', 'companies', 'leads', 'deals', 'tags'].map((c) => idx(c, { orgId: 1 })),

    idx('groups', { id: 1 }, { unique: true }),
    idx('groupMembers', { groupId: 1, userId: 1 }, { unique: true }),
    idx('conversations', { id: 1 }, { unique: true }),
    idx('conversations', { userAId: 1 }),
    idx('conversations', { userBId: 1 }),
    idx('messages', { id: 1 }, { unique: true }),
    idx('messages', { conversationId: 1 }),

    idx('auditLogs', { id: 1 }, { unique: true }),
    idx('auditLogs', { orgId: 1 }),
    idx('notifications', { id: 1 }, { unique: true }),
    idx('notifications', { orgId: 1 }),

    idx('sharedOrganizations', { id: 1 }, { unique: true }),
    idx('sharedResourceGrants', { id: 1 }, { unique: true }),
    idx('departments', { id: 1 }, { unique: true }),
    idx('teams', { id: 1 }, { unique: true }),
    idx('teamMembers', { id: 1 }, { unique: true }),
  ]);

  console.log('[db] Indexes ensured');
}

function strip(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

async function list(collection, filter = {}) {
  const db = await dbPromise;
  const docs = await db.collection(collection).find(filter).toArray();
  return docs.map(strip);
}

async function findOne(collection, filter = {}) {
  const db = await dbPromise;
  const doc = await db.collection(collection).findOne(filter);
  return strip(doc);
}

async function findById(collection, id) {
  return findOne(collection, { id });
}

async function insert(collection, doc) {
  const db = await dbPromise;
  try {
    await db.collection(collection).insertOne({ ...doc });
    return doc;
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key on a unique index (e.g. identities.email, or the
      // (identityId, organizationId) pair on organizationMembers) — surface
      // this the same way services/routes already throw their own 409s,
      // instead of leaking a raw MongoServerError up to an Express handler.
      throw Object.assign(new Error('A record with this value already exists'), { status: 409, cause: err });
    }
    throw err;
  }
}

async function updateById(collection, id, patch) {
  const db = await dbPromise;
  const result = await db.collection(collection).findOneAndUpdate(
    { id },
    { $set: patch },
    { returnDocument: 'after' }
  );
  // driver versions differ on whether findOneAndUpdate returns {value} or the doc itself
  const updated = result && result.value !== undefined ? result.value : result;
  return strip(updated);
}

async function updateWhere(collection, filter, patch) {
  const db = await dbPromise;
  const result = await db.collection(collection).updateMany(filter, { $set: patch });
  return result.modifiedCount;
}

async function removeById(collection, id) {
  const db = await dbPromise;
  const result = await db.collection(collection).deleteOne({ id });
  return result.deletedCount > 0;
}

async function removeWhere(collection, filter) {
  const db = await dbPromise;
  const result = await db.collection(collection).deleteMany(filter);
  return result.deletedCount;
}

async function count(collection, filter = {}) {
  const db = await dbPromise;
  return db.collection(collection).countDocuments(filter);
}

module.exports = { list, findOne, findById, insert, updateById, updateWhere, removeById, removeWhere, count };
