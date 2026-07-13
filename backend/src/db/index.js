/**
 * ============================================================================
 * THE DATABASE ABSTRACTION LAYER
 * ============================================================================
 * Every route, service, and middleware in this app talks to the database
 * ONLY through the 8 methods below (via `const repo = require('../db')`).
 * Nothing outside `src/db/drivers/mongoDriver.js` ever imports the mongodb
 * package directly.
 *
 * MongoDB is the only driver this app uses — the driver-switching
 * indirection some earlier versions of this file had is gone. If you ever
 * need a different database later, write a new file in `src/db/drivers/`
 * implementing these same 8 methods and swap the require below.
 *
 * Method contract (must return these exact shapes):
 *
 *   list(collection, filter = {})       -> Promise<Array<doc>>
 *     Returns every doc in `collection` whose fields match `filter` exactly
 *     (simple equality, e.g. { orgId: 'abc' }). filter = {} returns all.
 *
 *   findOne(collection, filter = {})    -> Promise<doc | null>
 *     First doc matching filter, or null.
 *
 *   findById(collection, id)            -> Promise<doc | null>
 *     Shorthand for findOne(collection, { id }).
 *
 *   insert(collection, doc)             -> Promise<doc>
 *     Inserts doc as-is (caller is responsible for setting `id`) and
 *     returns it back. Throws { status: 409 } on a unique-index conflict
 *     (e.g. a duplicate identities.email).
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
 * ============================================================================
 */

module.exports = require('./drivers/mongoDriver');
