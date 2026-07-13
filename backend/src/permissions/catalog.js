/**
 * Canonical permission catalog. Every permission string used anywhere in the
 * system MUST be declared here. requirePermission() and the admin "manage
 * roles" UI both read from this list, so adding a new capability is a
 * one-line change here plus whatever route/service enforces it.
 */

const PERMISSION_GROUPS = {
  crm: [
    'crm.view', 'crm.create', 'crm.edit', 'crm.delete', 'crm.export', 'crm.import',
    'crm.assign', 'crm.transfer', 'crm.merge', 'crm.restore', 'crm.bulk_update', 'crm.bulk_delete',
  ],
  lead: ['lead.view', 'lead.create', 'lead.edit', 'lead.delete', 'lead.assign', 'lead.convert'],
  deal: ['deal.view', 'deal.create', 'deal.edit', 'deal.delete', 'deal.close'],
  company: ['company.view', 'company.create', 'company.edit', 'company.delete'],
  contact: ['contact.view', 'contact.create', 'contact.edit', 'contact.delete'],
  user: ['user.view', 'user.create', 'user.edit', 'user.delete', 'user.disable', 'user.permissions'],
  chat: ['chat.view', 'chat.send', 'chat.delete', 'chat.create_group', 'chat.manage'],
  file: ['file.upload', 'file.download', 'file.delete', 'file.share'],
  analytics: ['analytics.view', 'analytics.export'],
  admin: ['admin.settings', 'admin.users', 'admin.roles', 'admin.permissions', 'admin.audit'],
  // Business Unit ("organization switching" — see ARCHITECTURE.md §10) management,
  // distinct from `admin.*` (tenant-level) since a tenant admin may want to delegate
  // BU management without granting full admin rights.
  org: ['org.manage_business_units', 'org.view_business_units'],
};

const ALL_PERMISSIONS = Object.values(PERMISSION_GROUPS).flat();
const PERMISSION_SET = new Set(ALL_PERMISSIONS);

function isValidPermission(key) {
  return PERMISSION_SET.has(key);
}

module.exports = { PERMISSION_GROUPS, ALL_PERMISSIONS, isValidPermission };
