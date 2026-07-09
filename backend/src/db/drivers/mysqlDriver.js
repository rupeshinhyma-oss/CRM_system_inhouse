/**
 * MYSQL DRIVER — TEMPLATE, NOT YET ACTIVE.
 *
 * To activate:
 *   1. npm install mysql2
 *   2. Set DB_DRIVER=mysql and DATABASE_URL=mysql://user:pass@host:3306/dbname in .env
 *   3. Create the tables — PRISMA_SCHEMA.prisma at the repo root already has the
 *      exact target schema (one model per collection used below). Either run it
 *      through Prisma (`npx prisma migrate dev`) or hand-translate it to raw SQL.
 *   4. Implement the 8 functions below. A generic approach that works with the
 *      JSON-shaped docs this app already produces: give every table a `data JSON`
 *      column (plus an indexed `id VARCHAR(36) PRIMARY KEY` and `org_id VARCHAR(36)`
 *      for fast tenant filtering), and store/retrieve the whole doc as JSON. That's
 *      the fastest path to a working swap. A stricter column-per-field schema
 *      (matching PRISMA_SCHEMA.prisma exactly) is a follow-up optimization, not a blocker.
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
      `MySQL driver method "${name}" is not implemented yet. ` +
      `See src/db/drivers/mysqlDriver.js for setup steps.`
    );
  };
}

const driver = {};
REQUIRED_METHODS.forEach((name) => { driver[name] = notImplemented(name); });

/*
Example implementation shape once you've npm installed `mysql2`:

const mysql = require('mysql2/promise');
const pool = mysql.createPool(process.env.DATABASE_URL);

async function list(collection, filter = {}) {
  const keys = Object.keys(filter);
  const where = keys.length
    ? 'WHERE ' + keys.map((k) => `JSON_EXTRACT(data, '$.${k}') = ?`).join(' AND ')
    : '';
  const [rows] = await pool.query(`SELECT data FROM ${collection} ${where}`, Object.values(filter));
  return rows.map((r) => JSON.parse(r.data));
}

async function insert(collection, doc) {
  await pool.query(`INSERT INTO ${collection} (id, org_id, data) VALUES (?, ?, ?)`, [doc.id, doc.orgId || null, JSON.stringify(doc)]);
  return doc;
}

// ...and so on for the remaining 6 methods, following the same pattern.
*/

module.exports = driver;
