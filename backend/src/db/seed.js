const { v4: uuidv4 } = require('uuid');
const repo = require('./index');
const { nowIso } = require('../utils/time');
const { DEFAULT_ORG_ROLES } = require('../permissions/rolesSeed');

/** Seed the default permission-bundle roles into a newly created organization. */
async function seedDefaultRolesForOrg(orgId) {
  const created = {};
  for (const [key, def] of Object.entries(DEFAULT_ORG_ROLES)) {
    const role = await repo.insert('roles', {
      id: uuidv4(), orgId, key, label: def.label, systemProtected: !!def.systemProtected, createdAt: nowIso(),
    });
    for (const permission of def.permissions) {
      await repo.insert('rolePermissions', { id: uuidv4(), roleId: role.id, permission });
    }
    created[key] = role;
  }
  return created;
}

module.exports = { seedDefaultRolesForOrg };
