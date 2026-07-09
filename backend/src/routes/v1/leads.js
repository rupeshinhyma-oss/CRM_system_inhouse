const { v4: uuidv4 } = require('uuid');
const { createCrmRouter } = require('../../services/crmRouterFactory');
const repo = require('../../db');
const { nowIso } = require('../../utils/time');
const { requireAuth, requirePermission, belongsToSameOrg } = require('../../middleware/authGuards');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, fail } = require('../../utils/respond');

const router = createCrmRouter({
  collection: 'leads',
  permPrefix: 'lead',
  fields: [
    'name', 'email', 'phone', 'source', 'status', 'score', 'interestedProducts',
    'priority', 'assignedUserId', 'notes', 'tags',
  ],
  searchable: ['name', 'email', 'phone', 'source'],
  defaults: { status: 'NEW', score: 0, priority: 'MEDIUM', conversionHistory: [] },
});

// POST /api/v1/leads/:id/convert — requires lead.convert, creates a Deal + Contact from the lead
router.post('/:id/convert', requireAuth, requirePermission('lead.convert'), async (req, res) => {
  const lead = await repo.findById('leads', req.params.id);
  if (!lead || !belongsToSameOrg(req, lead.orgId)) return fail(res, 404, 'Lead not found');

  const contact = await repo.insert('contacts', {
    id: uuidv4(), orgId: req.user.orgId, name: lead.name, email: lead.email, phone: lead.phone,
    designation: null, companyId: null, tags: lead.tags || [], notes: lead.notes || '',
    assignedUserId: lead.assignedUserId, createdBy: req.user.uid, updatedBy: req.user.uid,
    createdAt: nowIso(), updatedAt: nowIso(), deletedAt: null,
  });

  const deal = await repo.insert('deals', {
    id: uuidv4(), orgId: req.user.orgId, name: `${lead.name} - Deal`, pipeline: 'DEFAULT', stage: 'NEW',
    amount: 0, currency: 'USD', probability: 20, expectedCloseDate: null, assignedUserId: lead.assignedUserId,
    contactId: contact.id, tags: [], notes: '', createdBy: req.user.uid, updatedBy: req.user.uid,
    createdAt: nowIso(), updatedAt: nowIso(), deletedAt: null,
  });

  const conversionHistory = [...(lead.conversionHistory || []), { convertedAt: nowIso(), convertedBy: req.user.uid, dealId: deal.id, contactId: contact.id }];
  const updatedLead = await repo.updateById('leads', lead.id, { status: 'CONVERTED', conversionHistory });

  await recordAudit(req, { action: 'lead.convert', entityType: 'lead', entityId: lead.id, newValue: { dealId: deal.id, contactId: contact.id } });
  ok(res, { lead: updatedLead, contact, deal });
});

module.exports = router;
