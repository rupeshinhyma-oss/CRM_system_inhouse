/**
 * ============================================================================
 * MIGRATION: 2026_07_add_business_units
 * ============================================================================
 * Backfills the new "organization switching" layer (see
 * services/businessUnitService.js and ARCHITECTURE.md §10) onto data that
 * existed before this feature shipped. Purely additive — never deletes or
 * overwrites existing fields, only fills in previously-absent ones.
 *
 * For every existing tenant (`organizations` row):
 *   1. Ensure a "Default" business unit exists.
 *   2. Give every user in that tenant a membership in it + activeBusinessUnitId.
 *   3. Backfill businessUnitId on every contact/company/lead/deal/group/
 *      auditLog/notification that belongs to that tenant and doesn't have one yet.
 *
 * Usage:
 *   node src/db/migrations/2026_07_add_business_units.js            # apply
 *   node src/db/migrations/2026_07_add_business_units.js --rollback # undo
 *
 * The rollback removes every businessUnits/businessUnitMemberships row and
 * clears the businessUnitId/activeBusinessUnitId fields this migration set —
 * it does NOT touch any other field or delete any CRM record.
 * ============================================================================
 */

const repo = require('../index');
const { nowIso } = require('../../utils/time');
const { ensureDefaultBusinessUnit, addMembership } = require('../../services/businessUnitService');

const BACKFILL_COLLECTIONS = ['contacts', 'companies', 'leads', 'deals', 'groups', 'auditLogs', 'notifications'];

async function migrateUp() {
  const orgs = await repo.list('organizations');
  let usersMigrated = 0;
  let recordsBackfilled = 0;

  for (const org of orgs) {
    const defaultBu = await ensureDefaultBusinessUnit(org.id);

    const users = await repo.list('users', { orgId: org.id });
    for (const user of users) {
      if (!user.activeBusinessUnitId) {
        await repo.updateById('users', user.id, { activeBusinessUnitId: defaultBu.id, updatedAt: nowIso() });
        usersMigrated++;
      }
      await addMembership(defaultBu.id, user.id, user.roleId || null, 'ACTIVE');
    }

    for (const collection of BACKFILL_COLLECTIONS) {
      const records = await repo.list(collection, { orgId: org.id });
      for (const record of records) {
        if (!record.businessUnitId) {
          await repo.updateById(collection, record.id, { businessUnitId: defaultBu.id });
          recordsBackfilled++;
        }
      }
    }

    console.log(`[migrate] org "${org.name}" (${org.id}) -> Default business unit ${defaultBu.id}`);
  }

  console.log(`[migrate] Done. ${orgs.length} tenant(s), ${usersMigrated} user(s) assigned an active business unit, ${recordsBackfilled} record(s) backfilled.`);
}

async function migrateDown() {
  const businessUnits = await repo.list('businessUnits');
  const businessUnitIds = new Set(businessUnits.map((b) => b.id));

  for (const collection of BACKFILL_COLLECTIONS) {
    const records = await repo.list(collection);
    for (const record of records) {
      if (record.businessUnitId && businessUnitIds.has(record.businessUnitId)) {
        await repo.updateById(collection, record.id, { businessUnitId: null });
      }
    }
  }

  const users = await repo.list('users');
  for (const user of users) {
    if (user.activeBusinessUnitId) {
      await repo.updateById('users', user.id, { activeBusinessUnitId: null });
    }
  }

  const memberships = await repo.list('businessUnitMemberships');
  for (const m of memberships) await repo.removeById('businessUnitMemberships', m.id);
  for (const bu of businessUnits) await repo.removeById('businessUnits', bu.id);

  console.log(`[rollback] Removed ${businessUnits.length} business unit(s) and ${memberships.length} membership(s); cleared businessUnitId/activeBusinessUnitId fields.`);
}

if (require.main === module) {
  const isRollback = process.argv.includes('--rollback');
  (isRollback ? migrateDown() : migrateUp())
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { migrateUp, migrateDown };
