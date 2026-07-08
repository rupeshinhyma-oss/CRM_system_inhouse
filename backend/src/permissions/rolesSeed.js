const { ALL_PERMISSIONS } = require('./catalog');

const CRM_FULL = [
  'crm.view', 'crm.create', 'crm.edit', 'crm.delete', 'crm.export', 'crm.import',
  'crm.assign', 'crm.transfer', 'crm.merge', 'crm.restore', 'crm.bulk_update', 'crm.bulk_delete',
  'lead.view', 'lead.create', 'lead.edit', 'lead.delete', 'lead.assign', 'lead.convert',
  'deal.view', 'deal.create', 'deal.edit', 'deal.delete', 'deal.close',
  'company.view', 'company.create', 'company.edit', 'company.delete',
  'contact.view', 'contact.create', 'contact.edit', 'contact.delete',
];
const CHAT_FULL = ['chat.view', 'chat.send', 'chat.delete', 'chat.create_group', 'chat.manage'];
const FILE_FULL = ['file.upload', 'file.download', 'file.delete', 'file.share'];

/**
 * Every one of these is a *default* — an org admin can create fully custom
 * roles and edit these permission sets after seeding. This just gives a new
 * organization sane, working defaults on day one.
 */
const DEFAULT_ORG_ROLES = {
  ORG_OWNER: {
    label: 'Organization Owner',
    permissions: ALL_PERMISSIONS, // everything within their own org
    systemProtected: true, // cannot be deleted, org must always have >=1 owner
  },
  ADMIN: {
    label: 'Admin',
    permissions: ALL_PERMISSIONS, // full admin within their own org
  },
  MANAGER: {
    label: 'Manager',
    permissions: [...CRM_FULL, ...CHAT_FULL, ...FILE_FULL, 'user.view', 'analytics.view', 'analytics.export'],
  },
  SALES_MANAGER: {
    label: 'Sales Manager',
    permissions: [
      'crm.view', 'crm.export', 'crm.assign', 'crm.transfer',
      'lead.view', 'lead.create', 'lead.edit', 'lead.assign', 'lead.convert',
      'deal.view', 'deal.create', 'deal.edit', 'deal.close',
      'company.view', 'company.create', 'company.edit',
      'contact.view', 'contact.create', 'contact.edit',
      ...CHAT_FULL, ...FILE_FULL, 'analytics.view',
    ],
  },
  SALES_AGENT: {
    label: 'Sales Agent',
    permissions: [
      'lead.view', 'lead.create', 'lead.edit',
      'deal.view', 'deal.create', 'deal.edit',
      'contact.view', 'contact.create', 'contact.edit',
      'company.view',
      'chat.view', 'chat.send', 'file.upload', 'file.download',
    ],
  },
  SUPPORT_MANAGER: {
    label: 'Support Manager',
    permissions: [
      'contact.view', 'contact.edit', 'company.view',
      ...CHAT_FULL, ...FILE_FULL, 'analytics.view', 'user.view',
    ],
  },
  SUPPORT_AGENT: {
    label: 'Support Agent',
    permissions: ['contact.view', 'company.view', 'chat.view', 'chat.send', 'file.upload', 'file.download'],
  },
  MARKETING: {
    label: 'Marketing',
    permissions: [
      'lead.view', 'lead.create', 'lead.edit', 'contact.view', 'contact.create',
      'company.view', 'analytics.view', 'analytics.export', ...CHAT_FULL, ...FILE_FULL,
    ],
  },
  HR: {
    label: 'HR',
    permissions: ['user.view', 'user.create', 'user.edit', 'chat.view', 'chat.send', 'file.upload', 'file.download'],
  },
  FINANCE: {
    label: 'Finance',
    permissions: ['deal.view', 'company.view', 'analytics.view', 'analytics.export', 'chat.view', 'chat.send'],
  },
  EMPLOYEE: {
    label: 'Employee',
    permissions: ['chat.view', 'chat.send', 'file.upload', 'file.download', 'contact.view'],
  },
};

module.exports = { DEFAULT_ORG_ROLES };
