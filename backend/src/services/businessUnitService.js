const { v4: uuidv4 } = require('uuid');
const repo = require('../db');
const { nowIso } = require('../utils/time');

/**
 * ============================================================================
 * BUSINESS UNITS — the JioHotstar/Netflix-style "organization switching" layer
 * ============================================================================
 * Terminology mapping (see ARCHITECTURE.md §10 for the full write-up):
 *
 *   Prompt's "Tenant"        -> the pre-existing `organizations` collection
 *                               (unchanged; still the hard multi-tenant
 *                               isolation boundary every record's orgId maps to)
 *   Prompt's "Organization"  -> this NEW `businessUnits` collection, scoped
 *                               inside exactly one tenant (orgId), and the
 *                               thing a user actually switches between
 *                               ("Acme India" / "Acme UAE" under tenant "Acme")
 *
 * This naming was chosen over renaming the existing Organization model
 * because CRITICAL RULE #3 ("do not break existing APIs") rules out a rename
 * of a collection that every CRM record, role, and audit log already keys
 * off of. Every function below is purely additive.
 */

/**
 * Ensures a tenant has at least one ACTIVE business unit ("Default"), so
 * every org — including ones created before this feature shipped — always
 * has a valid switch target. Idempotent; safe to call on every login.
 */
async function ensureDefaultBusinessUnit(orgId) {
  const existing = await repo.findOne('businessUnits', { orgId, isDefault: true });
  if (existing) return existing;
  return repo.insert('businessUnits', {
    id: uuidv4(),
    orgId,
    name: 'Default',
    code: 'DEFAULT',
    logo: null,
    description: 'Default business unit (auto-created)',
    status: 'ACTIVE', // ACTIVE | ARCHIVED | DELETED
    isDefault: true,
    settings: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

async function createBusinessUnit(orgId, { name, code, logo, description }) {
  return repo.insert('businessUnits', {
    id: uuidv4(),
    orgId,
    name,
    code: code || null,
    logo: logo || null,
    description: description || null,
    status: 'ACTIVE',
    isDefault: false,
    settings: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

/** One row per (businessUnitId, userId) — "one user can belong to multiple organizations." */
async function addMembership(businessUnitId, userId, roleId = null, status = 'ACTIVE') {
  const existing = await repo.findOne('businessUnitMemberships', { businessUnitId, userId });
  if (existing) return repo.updateById('businessUnitMemberships', existing.id, { status, roleId: roleId ?? existing.roleId });
  return repo.insert('businessUnitMemberships', {
    id: uuidv4(),
    businessUnitId,
    userId,
    roleId,
    status,
    createdAt: nowIso(),
  });
}

async function removeMembership(businessUnitId, userId) {
  return repo.removeWhere('businessUnitMemberships', { businessUnitId, userId });
}

/** The "Who's working?" list — every ACTIVE business unit this user is a member of, within their own tenant. */
async function listBusinessUnitsForUser(user) {
  if (!user || user.isSuperAdmin) return []; // Super Admin operates at the platform level, above any single BU context
  const memberships = await repo.list('businessUnitMemberships', { userId: user.id, status: 'ACTIVE' });
  const units = [];
  for (const m of memberships) {
    const bu = await repo.findById('businessUnits', m.businessUnitId);
    if (bu && bu.orgId === user.orgId && bu.status === 'ACTIVE') units.push(await withDisplayName(bu));
  }
  return units;
}

/**
 * Adds a computed `displayName` to a business unit WITHOUT changing its
 * stored `name` field. For the org's isDefault unit, this is always
 * "<current organization name> (Default)" — resolved live from the
 * organization every time, so renaming the organization later (e.g.
 * "Org 1" -> "ACP") is reflected immediately as "ACP (Default)" with no
 * migration or backfill needed. Every other (non-default) business unit
 * just uses its own stored name unchanged.
 */
async function withDisplayName(bu) {
  if (!bu.isDefault) return { ...bu, displayName: bu.name };
  const org = await repo.findById('organizations', bu.orgId);
  const orgName = org ? org.name : bu.name;
  return { ...bu, displayName: `${orgName} (Default)` };
}

async function isMember(userId, businessUnitId) {
  const m = await repo.findOne('businessUnitMemberships', { userId, businessUnitId, status: 'ACTIVE' });
  return !!m;
}

module.exports = {
  ensureDefaultBusinessUnit,
  createBusinessUnit,
  addMembership,
  removeMembership,
  listBusinessUnitsForUser,
  isMember,
};
