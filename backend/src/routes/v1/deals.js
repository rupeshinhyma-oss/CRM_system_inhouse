const { createCrmRouter } = require('../../services/crmRouterFactory');
const { db, nowIso } = require('../../db/db');
const { requireAuth, requirePermission, belongsToSameOrg } = require('../../middleware/authGuards');
const { recordAudit } = require('../../middleware/auditLog');
const { ok, fail } = require('../../utils/respond');

const router = createCrmRouter({
  collection: 'deals',
  permPrefix: 'deal',
  fields: [
    'name', 'pipeline', 'stage', 'amount', 'currency', 'probability', 'expectedCloseDate',
    'assignedUserId', 'contactId', 'companyId', 'productIds', 'notes', 'tags',
  ],
  searchable: ['name', 'pipeline', 'stage'],
  defaults: { pipeline: 'DEFAULT', stage: 'NEW', currency: 'USD', probability: 10 },
});

// POST /api/v1/deals/:id/close  { outcome: 'WON'|'LOST' } — requires deal.close
router.post('/:id/close', requireAuth, requirePermission('deal.close'), (req, res) => {
  const { outcome } = req.body || {};
  if (!['WON', 'LOST'].includes(outcome)) return fail(res, 400, 'outcome must be WON or LOST');
  const deal = db.get('deals').find({ id: req.params.id }).value();
  if (!deal || !belongsToSameOrg(req, deal.orgId)) return fail(res, 404, 'Deal not found');

  const updated = db.get('deals').find({ id: deal.id })
    .assign({ stage: outcome, closedAt: nowIso(), probability: outcome === 'WON' ? 100 : 0 }).write();
  recordAudit(req, { action: 'deal.close', entityType: 'deal', entityId: deal.id, newValue: { outcome } });
  ok(res, updated);
});

module.exports = router;
