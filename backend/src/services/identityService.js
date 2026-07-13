// FILE: backend/src/services/identityService.js
// NEW FILE. Implements the Identity -> Membership -> Organization model:
//
//   IDENTITIES            one row per real-world login (email + passwordHash)
//   ORGANIZATIONS         unchanged tenant/workspace collection
//   ORGANIZATION_MEMBERS  join table: (identityId, organizationId, role, status)
//   USERS                 becomes the per-org PROFILE row (displayName,
//                         designation, roleId, businessUnitId, etc.) — still
//                         one row per (identity, organization) pair, but it
//                         no longer holds a password. Auth lives on Identity.
//
// Why `users` isn't deleted: every existing route, permission check, chat
// message, and CRM record already keys off `userId`/`orgId` on the `users`
// collection (see db/index.js header comment — "Nothing outside src/db
// changes when swapping databases" applies just as much to *not* rewriting
// 19 files that already do `repo.findById('users', ...)`). So `users` stays
// exactly what it was, MINUS the password — it's now purely an org-scoped
// profile+permissions record, linked back to its owning Identity via
// `identityId`. This is the minimal-blast-radius way to land the new model.
//
// Super Admin note: the single platform Super Admin is modeled as an
// Identity with `isSuperAdmin: true` and NO organization memberships at all
// (same as before — they operate above any single tenant). Their `users`-ish
// data (displayName, isSuperAdmin flag) is now merged directly onto the
// Identity row itself, since a Super Admin never has a per-org profile.

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const repo = require('../db');
const { nowIso } = require('../utils/time');
const { seedDefaultRolesForOrg } = require('../db/seed');
const { ensureDefaultBusinessUnit, addMembership: addBusinessUnitMembership } = require('./businessUnitService');

function publicIdentity(identity) {
  if (!identity) return null;
  const { passwordHash, ...safe } = identity;
  return safe;
}

/** Find an Identity by email (the ONE global uniqueness rule that still applies: one identity per email). */
async function findIdentityByEmail(email) {
  return repo.findOne('identities', { email: email.toLowerCase().trim() });
}

/**
 * Creates a brand-new Identity (a real person's login: email + password).
 * Throws 409 if that email is already registered — this is still globally
 * unique, same as any Slack/Notion/GitHub account, because it's one login,
 * not one organization.
 */
async function createIdentity({ email, password, displayName }) {
  const emailLower = email.toLowerCase().trim();
  if (await findIdentityByEmail(emailLower)) {
    throw Object.assign(new Error('An account with this email already exists'), { status: 409 });
  }
  return repo.insert('identities', {
    id: uuidv4(),
    email: emailLower,
    passwordHash: bcrypt.hashSync(password, 10),
    displayName,
    isSuperAdmin: false,
    defaultOrganizationId: null, // set once their first organization is created
    status: 'ACTIVE', // ACTIVE | DISABLED
    lastLoginAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

async function verifyPassword(identity, password) {
  return bcrypt.compareSync(password, identity.passwordHash);
}

async function setPassword(identityId, newPassword) {
  return repo.updateById('identities', identityId, {
    passwordHash: bcrypt.hashSync(newPassword, 10),
    updatedAt: nowIso(),
  });
}

/** Every organization membership row for this identity, each with its resolved organization + users-profile attached. */
async function listMembershipsForIdentity(identityId) {
  const memberships = await repo.list('organizationMembers', { identityId, status: 'ACTIVE' });
  const out = [];
  for (const m of memberships) {
    const organization = await repo.findById('organizations', m.organizationId);
    if (!organization || organization.status === 'DELETED') continue;
    const profile = await repo.findById('users', m.userProfileId);
    out.push({
      organizationId: organization.id,
      organizationName: organization.name,
      organizationStatus: organization.status,
      role: m.role, // 'owner' | 'member' (coarse — fine-grained permissions still live on the users-profile roleId)
      userProfileId: m.userProfileId,
      profile,
    });
  }
  return out;
}

async function getMembership(identityId, organizationId) {
  return repo.findOne('organizationMembers', { identityId, organizationId, status: 'ACTIVE' });
}

/**
 * Creates a brand-new, fully isolated ORGANIZATION under an ALREADY
 * AUTHENTICATED identity. This is the "+ Create Organization" flow —
 * deliberately takes NO password, because the identity is already logged
 * in. Mirrors Slack's "Create a workspace" / Notion's "Create workspace"
 * modal: only org-level details are asked for.
 *
 * If this is the identity's very first organization, it's set as their
 * defaultOrganizationId (opens automatically on future logins).
 */
async function createOrganizationForIdentity(identity, { orgName, industry, country }) {
  const org = await repo.insert('organizations', {
    id: uuidv4(),
    name: orgName,
    logoUrl: null,
    address: null,
    country: country || null,
    timezone: 'UTC',
    industry: industry || null,
    phone: null,
    email: identity.email,
    subscriptionPlan: 'FREE',
    storageUsedMb: 0,
    storageQuotaMb: 1024,
    status: 'ACTIVE',
    settings: { aiEnabled: false, crmEnabled: true, branding: {} },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  const roles = await seedDefaultRolesForOrg(org.id);
  const defaultBusinessUnit = await ensureDefaultBusinessUnit(org.id);

  // Per-org PROFILE row for this identity (displayName/designation/role/BU —
  // no password; see file header). One of these gets created per
  // organization an identity belongs to, same shape as before minus auth.
  const profile = await repo.insert('users', {
    id: uuidv4(),
    identityId: identity.id,
    orgId: org.id,
    email: identity.email,
    displayName: identity.displayName,
    avatarUrl: null,
    designation: 'Organization Owner',
    phone: null,
    departmentId: null,
    managerId: null,
    employeeId: 'EMP-0001',
    timezone: 'UTC',
    language: 'en',
    isSuperAdmin: false,
    roleId: roles.ORG_OWNER.id,
    activeBusinessUnitId: defaultBusinessUnit.id,
    status: 'OFFLINE',
    enabled: true,
    lastLoginAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  await addBusinessUnitMembership(defaultBusinessUnit.id, profile.id, roles.ORG_OWNER.id, 'ACTIVE');

  await repo.insert('organizationMembers', {
    id: uuidv4(),
    identityId: identity.id,
    organizationId: org.id,
    userProfileId: profile.id,
    role: 'owner',
    status: 'ACTIVE',
    createdAt: nowIso(),
  });

  // First organization ever created by this identity becomes their default.
  if (!identity.defaultOrganizationId) {
    await repo.updateById('identities', identity.id, { defaultOrganizationId: org.id, updatedAt: nowIso() });
  }

  return { organization: org, profile, roles, defaultBusinessUnit };
}

module.exports = {
  publicIdentity,
  findIdentityByEmail,
  createIdentity,
  verifyPassword,
  setPassword,
  listMembershipsForIdentity,
  getMembership,
  createOrganizationForIdentity,
};
