const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { createCrmRouter } = require('../../services/crmRouterFactory');
const { db, nowIso } = require('../../db/db');
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
router.post('/:id/convert', requireAuth, requirePermission('lead.convert'), (req, res) => {
  const lead = db.get('leads').find({ id: req.params.id }).value();
  if (!lead || !belongsToSameOrg(req, lead.orgId)) return fail(res, 404, 'Lead not found');

  const contact = {
    id: uuidv4(), orgId: req.user.orgId, name: lead.name, email: lead.email, phone: lead.phone,
    designation: null, companyId: null, tags: lead.tags || [], notes: lead.notes || '',
    assignedUserId: lead.assignedUserId, createdBy: req.user.uid, updatedBy: req.user.uid,
    createdAt: nowIso(), updatedAt: nowIso(), deletedAt: null,
  };
  db.get('contacts').push(contact).write();

  const deal = {
    id: uuidv4(), orgId: req.user.orgId, name: `${lead.name} - Deal`, pipeline: 'DEFAULT', stage: 'NEW',
    amount: 0, currency: 'USD', probability: 20, expectedCloseDate: null, assignedUserId: lead.assignedUserId,
    contactId: contact.id, tags: [], notes: '', createdBy: req.user.uid, updatedBy: req.user.uid,
    createdAt: nowIso(), updatedAt: nowIso(), deletedAt: null,
  };
  db.get('deals').push(deal).write();

  const conversionHistory = [...(lead.conversionHistory || []), { convertedAt: nowIso(), convertedBy: req.user.uid, dealId: deal.id, contactId: contact.id }];
  const updatedLead = db.get('leads').find({ id: lead.id }).assign({ status: 'CONVERTED', conversionHistory }).write();

  recordAudit(req, { action: 'lead.convert', entityType: 'lead', entityId: lead.id, newValue: { dealId: deal.id, contactId: contact.id } });
  ok(res, { lead: updatedLead, contact, deal });
});

module.exports = router;
