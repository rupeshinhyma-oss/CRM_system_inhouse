// FILE: backend/src/services/organizationService.js
// NOTE: Organization CREATION now lives in services/identityService.js
// (createOrganizationForIdentity) as part of the Identity -> Membership ->
// Organization model — creating an organization always happens under an
// already-authenticated identity, so it belongs next to identity logic.
// This file keeps the remaining org lifecycle operations that don't involve
// identity/auth at all: listing, suspending, activating, deleting.

const repo = require('../db');
const { nowIso } = require('../utils/time');

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

module.exports = { listOrganizations, setOrganizationStatus, deleteOrganization };
