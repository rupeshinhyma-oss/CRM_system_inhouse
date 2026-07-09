/**
 * ============================================================================
 * THE DATABASE ABSTRACTION LAYER
 * ============================================================================
 * Every route, service, and middleware in this app talks to the database
 * ONLY through the 8 methods below (via `const repo = require('../db')`).
 * Nothing outside `src/db/drivers/*` ever imports lowdb, pg, mongodb, or
 * anything database-specific directly.
 *
 * TO SWITCH DATABASES LATER: write one new file in `src/db/drivers/` that
 * implements these same 8 methods, then change DB_DRIVER in your .env.
 * That is the ONLY file you need to write. Every route, every service,
 * every permission check, chat message, CRM record — all of it — keeps
 * working unchanged, because they never knew which database was underneath.
 *
 * Method contract (every driver MUST implement all 8, with these exact
 * signatures and return shapes, so swapping drivers is a true drop-in):
 *
 *   list(collection, filter = {})       -> Promise<Array<doc>>
 *     Returns every doc in `collection` whose fields match `filter` exactly
 *     (simple equality, e.g. { orgId: 'abc' }). filter = {} returns all.
 *     Complex search/sort/pagination is done in application code on the
 *     returned array — keeps this interface tiny and portable across very
 *     different databases. (A future perf pass can push filters into a
 *     real SQL WHERE per-driver without changing this contract.)
 *
 *   findOne(collection, filter = {})    -> Promise<doc | null>
 *     First doc matching filter, or null.
 *
 *   findById(collection, id)            -> Promise<doc | null>
 *     Shorthand for findOne(collection, { id }).
 *
 *   insert(collection, doc)             -> Promise<doc>
 *     Inserts doc as-is (caller is responsible for setting `id`) and
 *     returns it back.
 *
 *   updateById(collection, id, patch)   -> Promise<doc | null>
 *     Merges patch into the doc with that id, returns the updated doc,
 *     or null if no doc had that id.
 *
 *   updateWhere(collection, filter, patch) -> Promise<number>
 *     Merges patch into every doc matching filter. Returns count updated.
 *
 *   removeById(collection, id)          -> Promise<boolean>
 *     Deletes the doc with that id. Returns whether anything was deleted.
 *
 *   removeWhere(collection, filter)     -> Promise<number>
 *     Deletes every doc matching filter. Returns count deleted.
 *
 *   count(collection, filter = {})      -> Promise<number>
 *
 * Every method is async / returns a Promise even though the default lowdb
 * driver is instant under the hood — that's deliberate. A Postgres or
 * MongoDB driver genuinely needs to await a network call, and every call
 * site in this app already does `await repo.xxx(...)`. That's what makes
 * the swap possible without touching 19 other files.
 * ============================================================================
 */

const DB_DRIVER = (process.env.DB_DRIVER || 'lowdb').toLowerCase();

const DRIVERS = {
  lowdb: './drivers/lowdbDriver',
  postgres: './drivers/postgresDriver',
  mysql: './drivers/mysqlDriver',
  mongodb: './drivers/mongoDriver',
};

if (!DRIVERS[DB_DRIVER]) {
  throw new Error(
    `Unknown DB_DRIVER "${DB_DRIVER}". Valid options: ${Object.keys(DRIVERS).join(', ')}. ` +
    `Set DB_DRIVER in your .env file.`
  );
}

let repo;
try {
  repo = require(DRIVERS[DB_DRIVER]);
} catch (err) {
  if (DB_DRIVER !== 'lowdb') {
    throw new Error(
      `Failed to load DB_DRIVER "${DB_DRIVER}": ${err.message}\n` +
      `See src/db/drivers/${DB_DRIVER}Driver.js for the setup steps that driver needs ` +
      `(npm install target, connection env vars, etc).`
    );
  }
  throw err;
}

module.exports = repo;
