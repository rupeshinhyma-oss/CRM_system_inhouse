const { createCrmRouter } = require('../../services/crmRouterFactory');

module.exports = createCrmRouter({
  collection: 'companies',
  permPrefix: 'company',
  fields: ['name', 'industry', 'website', 'gst', 'address', 'employeeCount', 'revenue', 'tags', 'notes', 'assignedUserId'],
  searchable: ['name', 'industry', 'website', 'gst'],
});
