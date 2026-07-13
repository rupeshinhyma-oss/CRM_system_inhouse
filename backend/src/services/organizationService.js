const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const repo = require('../db');
const { nowIso } = require('../utils/time');
const { seedDefaultRolesForOrg } = require('../db/seed');
const { ensureDefaultBusinessUnit, addMembership } = require('./businessUnitService');

/** Self-service signup: creates a brand-new Organization + its Owner user. */
async function createOrganizationWithOwner({ orgName, ownerEmail, ownerPassword, ownerDisplayName, industry, country }) {
  const emailLower = ownerEmail.toLowerCase().trim();
  if (await repo.findOne('users', { email: emailLower })) {
    throw Object.assign(new Error('An account with this email already exists'), { status: 409 });
  }

  const org = await repo.insert('organizations', {
    id: uuidv4(),
    name: orgName,
    logoUrl: null,
    address: null,
    country: country || null,
    timezone: 'UTC',
    industry: industry || null,
    phone: null,
    email: emailLower,
    subscriptionPlan: 'FREE',
    storageUsedMb: 0,
    storageQuotaMb: 1024,
    status: 'ACTIVE', // ACTIVE | SUSPENDED | DELETED
    settings: { aiEnabled: false, crmEnabled: true, branding: {} },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  const roles = await seedDefaultRolesForOrg(org.id);

  // Every tenant gets a "Default" business unit on day one, so the
  // JioHotstar-style org selector always has at least one working profile —
  // additional business units (e.g. "Acme India" / "Acme UAE") are created
  // later via POST /api/v1/business-units.
  const defaultBusinessUnit = await ensureDefaultBusinessUnit(org.id);

  const owner = await repo.insert('users', {
    id: uuidv4(),
    orgId: org.id,
    email: emailLower,
    passwordHash: bcrypt.hashSync(ownerPassword, 10),
    displayName: ownerDisplayName,
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

  await addMembership(defaultBusinessUnit.id, owner.id, roles.ORG_OWNER.id, 'ACTIVE');

  return { organization: org, owner, roles, defaultBusinessUnit };
}

async function listOrganizations() {
  return repo.list('organizations');
}

async function setOrganizationStatus(orgId, status) {
  const updated = await repo.updateById('organizations', orgId, { status, updatedAt: nowIso() });
  if (!updated) throw Object.assign(new Error('Organization not found'), { status: 404 });
  return updated;
}

async function deleteOrganization(orgId) {
  // Soft-delete pattern: mark suspended + tag deletedAt rather than destroying data outright.
  const updated = await repo.updateById('organizations', orgId, { status: 'DELETED', deletedAt: nowIso(), updatedAt: nowIso() });
  if (!updated) throw Object.assign(new Error('Organization not found'), { status: 404 });
  return updated;
}

module.exports = { createOrganizationWithOwner, listOrganizations, setOrganizationStatus, deleteOrganization };
