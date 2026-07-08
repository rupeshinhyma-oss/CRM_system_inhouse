const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { DEFAULT_ORG_ROLES } = require('../permissions/rolesSeed');

const adapter = new FileSync(path.join(__dirname, '..', '..', 'data.json'));
const db = low(adapter);

/**
 * Every collection below maps 1:1 to a future Postgres table. Foreign keys
 * are plain string ids (uuid) exactly as they'd be in a relational schema —
 * this is a deliberate design choice so the eventual Prisma/knex migration
 * is a data dump + schema translation, not a rewrite. See
 * backend/PRISMA_SCHEMA.prisma for the target relational shape.
 */
db.defaults({
  organizations: [],
  users: [],
  roles: [],              // { id, orgId|null, key, label, systemProtected }
  rolePermissions: [],     // { id, roleId, permission }
  userPermissionOverrides: [], // { id, userId, permission, effect: 'GRANT'|'REVOKE' }
  departments: [],
  teams: [],
  teamMembers: [],
  refreshTokens: [],       // { id, userId, tokenHash, revoked, expiresAt, createdAt, ip, userAgent }
  auditLogs: [],           // { id, orgId, userId, action, entityType, entityId, oldValue, newValue, ip, userAgent, createdAt }
  notifications: [],       // { id, orgId, userId, type, title, body, read, createdAt, channel }
  sharedOrganizations: [], // { id, orgAId, orgBId, status, enabledBy, createdAt }
  sharedResourceGrants: [], // { id, sharedOrgLinkId, resourceType, resourceId, permission, grantedBy, createdAt }

  // CRM
  contacts: [],
  companies: [],
  leads: [],
  deals: [],
  tags: [],

  // Chat (org + department + announcement + cross-org aware)
  groups: [],
  groupMembers: [],
  conversations: [],
  messages: [],

  metaBootstrapped: false,
}).write();

function nowIso() { return new Date().toISOString(); }

/** Seed the global permission catalog's default role bundles into a given org. */
function seedDefaultRolesForOrg(orgId) {
  const created = {};
  for (const [key, def] of Object.entries(DEFAULT_ORG_ROLES)) {
    const role = {
      id: uuidv4(),
      orgId,
      key,
      label: def.label,
      systemProtected: !!def.systemProtected,
      createdAt: nowIso(),
    };
    db.get('roles').push(role).write();
    def.permissions.forEach((permission) => {
      db.get('rolePermissions').push({ id: uuidv4(), roleId: role.id, permission }).write();
    });
    created[key] = role;
  }
  return created;
}

/**
 * There must only ever be ONE Super Admin in the entire system. This is
 * bootstrapped once from SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD env vars —
 * NOT reachable through public registration. If a super admin already
 * exists, this is a no-op.
 */
function bootstrapSuperAdminIfNeeded() {
  const existing = db.get('users').find({ isSuperAdmin: true }).value();
  if (existing) return existing;

  const email = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('[bootstrap] SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD not set — no Super Admin exists yet.');
    return null;
  }

  const superAdmin = {
    id: uuidv4(),
    orgId: null, // super admin belongs to no single org
    email: email.toLowerCase().trim(),
    passwordHash: bcrypt.hashSync(password, 10),
    displayName: 'Super Administrator',
    isSuperAdmin: true,
    roleId: null,
    status: 'OFFLINE',
    enabled: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.get('users').push(superAdmin).write();
  console.log(`[bootstrap] Super Admin created for ${superAdmin.email}`);
  return superAdmin;
}

module.exports = { db, nowIso, seedDefaultRolesForOrg, bootstrapSuperAdminIfNeeded };
