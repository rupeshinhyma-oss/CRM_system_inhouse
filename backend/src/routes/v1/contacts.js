const { createCrmRouter } = require('../../services/crmRouterFactory');

module.exports = createCrmRouter({
  collection: 'contacts',
  permPrefix: 'contact',
  fields: [
    'name', 'email', 'phone', 'designation', 'companyId', 'address', 'country', 'state', 'city',
    'tags', 'notes', 'assignedUserId',
  ],
  searchable: ['name', 'email', 'phone', 'designation'],
});
