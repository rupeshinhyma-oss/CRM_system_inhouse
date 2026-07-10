/**
 * MONGODB DRIVER — ACTIVE.
 *
 * Activated via:
 *   1. npm install mongodb   (run inside backend/)
 *   2. DB_DRIVER=mongodb and DATABASE_URL=mongodb+srv://... set in .env
 *
 * Every doc this app produces already has an `id` field (uuid) that all
 * routes/services use as the primary key — so we always filter/query by
 * that `id` field, never Mongo's own `_id`. We strip `_id` out of every
 * returned doc so callers never see it and the shape stays identical to
 * the lowdb driver.
 */

const { MongoClient } = require('mongodb');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DB_DRIVER=mongodb but DATABASE_URL is not set. Add it to your .env, ' +
    'e.g. DATABASE_URL=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/yourDbName'
  );
}

const client = new MongoClient(process.env.DATABASE_URL);
const dbPromise = client.connect().then((c) => {
  console.log('[db] MongoDB connected');
  return c.db(); // uses the db name from the DATABASE_URL path, e.g. /yourDbName
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
  await db.collection(collection).insertOne({ ...doc });
  return doc;
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
