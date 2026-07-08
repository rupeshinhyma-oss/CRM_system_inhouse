const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { db, nowIso, seedDefaultRolesForOrg } = require('../db/db');

/** Self-service signup: creates a brand-new Organization + its Owner user. */
function createOrganizationWithOwner({ orgName, ownerEmail, ownerPassword, ownerDisplayName, industry, country }) {
  const emailLower = ownerEmail.toLowerCase().trim();
  if (db.get('users').find({ email: emailLower }).value()) {
    throw Object.assign(new Error('An account with this email already exists'), { status: 409 });
  }

  const org = {
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
    status: 'ACTIVE', // ACTIVE | SUSPENDED
    settings: { aiEnabled: false, crmEnabled: true, branding: {} },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.get('organizations').push(org).write();

  const roles = seedDefaultRolesForOrg(org.id);

  const owner = {
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
    status: 'OFFLINE',
    enabled: true,
    lastLoginAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.get('users').push(owner).write();

  return { organization: org, owner, roles };
}

function listOrganizations() {
  return db.get('organizations').value();
}

function setOrganizationStatus(orgId, status) {
  const updated = db.get('organizations').find({ id: orgId }).assign({ status, updatedAt: nowIso() }).write();
  if (!updated) throw Object.assign(new Error('Organization not found'), { status: 404 });
  return updated;
}

function deleteOrganization(orgId) {
  // Soft-delete pattern: mark suspended + tag deletedAt rather than destroying data outright.
  const updated = db.get('organizations').find({ id: orgId })
    .assign({ status: 'DELETED', deletedAt: nowIso(), updatedAt: nowIso() }).write();
  if (!updated) throw Object.assign(new Error('Organization not found'), { status: 404 });
  return updated;
}

module.exports = { createOrganizationWithOwner, listOrganizations, setOrganizationStatus, deleteOrganization };
