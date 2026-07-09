/**
 * MONGODB DRIVER — TEMPLATE, NOT YET ACTIVE.
 *
 * To activate:
 *   1. npm install mongodb
 *   2. Set DB_DRIVER=mongodb and DATABASE_URL=mongodb+srv://user:pass@cluster/dbname in .env
 *   3. No schema/migration step needed — Mongo is schemaless, and every doc this
 *      app produces is already a plain JS object, which is exactly a Mongo document.
 *      This is the least-work database to swap to.
 *   4. Implement the 8 functions below (see example shape at the bottom).
 *   5. Delete or rename this comment block once implemented.
 *
 * Every function must match the contract documented in src/db/index.js exactly
 * (same params, same return shape) — that contract is what lets every route
 * and service in the app work unchanged.
 */

const REQUIRED_METHODS = ['list', 'findOne', 'findById', 'insert', 'updateById', 'updateWhere', 'removeById', 'removeWhere', 'count'];

function notImplemented(name) {
  return async () => {
    throw new Error(
      `MongoDB driver method "${name}" is not implemented yet. ` +
      `See src/db/drivers/mongoDriver.js for setup steps.`
    );
  };
}

const driver = {};
REQUIRED_METHODS.forEach((name) => { driver[name] = notImplemented(name); });

/*
Example implementation shape once you've npm installed `mongodb`:

const { MongoClient } = require('mongodb');
const client = new MongoClient(process.env.DATABASE_URL);
const dbPromise = client.connect().then(() => client.db());

async function list(collection, filter = {}) {
  const db = await dbPromise;
  return db.collection(collection).find(filter).project({ _id: 0 }).toArray();
}

async function findOne(collection, filter = {}) {
  const db = await dbPromise;
  return db.collection(collection).findOne(filter, { projection: { _id: 0 } });
}

async function insert(collection, doc) {
  const db = await dbPromise;
  await db.collection(collection).insertOne({ ...doc });
  return doc;
}

async function updateById(collection, id, patch) {
  const db = await dbPromise;
  await db.collection(collection).updateOne({ id }, { $set: patch });
  return db.collection(collection).findOne({ id }, { projection: { _id: 0 } });
}

// ...and so on for the remaining 4 methods, following the same pattern.
// Note: findById, updateWhere, removeById, removeWhere, count all follow
// directly from Mongo's native filter/update/delete/countDocuments methods —
// this is the most natural fit of the three drivers, since the interface in
// src/db/index.js was deliberately modeled after Mongo-style operations.
*/

module.exports = driver;
