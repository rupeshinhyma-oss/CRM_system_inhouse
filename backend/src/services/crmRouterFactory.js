const express = require('express');
const { v4: uuidv4 } = require('uuid');
const repo = require('../db');
const { nowIso } = require('../utils/time');
const { requireAuth, requirePermission, belongsToSameOrg, getEffectivePermissions } = require('../middleware/authGuards');
const { recordAudit } = require('../middleware/auditLog');
const { notify } = require('./notificationService');
const { ok, created, fail, noContent, paginate } = require('../utils/respond');

/**
 * Builds a fully-featured CRM entity router (contacts/companies/leads/deals/...)
 * so every module gets the same CRUD + search + pagination + sort + filter +
 * bulk actions + soft delete + audit log behavior for free.
 *
 * Every DB call here goes through the generic repository (src/db/index.js) —
 * none of this changes when you swap from lowdb to Postgres/MySQL/MongoDB.
 */
function createCrmRouter({ collection, permPrefix, fields, searchable, defaults = {} }) {
  const router = express.Router();
  const perm = (action) => `${permPrefix}.${action}`;

  async function scoped(req) {
    const all = await repo.list(collection, { orgId: req.user.orgId });
    return all.filter((r) => !r.deletedAt);
  }

  // GET /?search=&page=&pageSize=&sortBy=&sortDir=&assignedTo=&includeDeleted=
  router.get('/', requireAuth, requirePermission(perm('view')), async (req, res) => {
    const { search, page, pageSize, sortBy, sortDir, assignedTo, includeDeleted } = req.query;
    let records = includeDeleted === 'true'
      ? await repo.list(collection, { orgId: req.user.orgId })
      : await scoped(req);

    if (search) {
      const q = search.toLowerCase();
      records = records.filter((r) => searchable.some((f) => String(r[f] || '').toLowerCase().includes(q)));
    }
    if (assignedTo) records = records.filter((r) => r.assignedUserId === assignedTo);

    if (sortBy) {
      const dir = sortDir === 'desc' ? -1 : 1;
      records = [...records].sort((a, b) => (a[sortBy] > b[sortBy] ? 1 : a[sortBy] < b[sortBy] ? -1 : 0) * dir);
    }

    const { items, meta } = paginate(records, { page, pageSize });
    ok(res, items, meta);
  });

  // GET /:id
  router.get('/:id', requireAuth, requirePermission(perm('view')), async (req, res) => {
    const record = await repo.findById(collection, req.params.id);
    if (!record || !belongsToSameOrg(req, record.orgId)) return fail(res, 404, 'Record not found');
    ok(res, record);
  });

  // POST /
  router.post('/', requireAuth, requirePermission(perm('create')), async (req, res) => {
    const body = {};
    for (const f of fields) if (f in req.body) body[f] = req.body[f];

    const record = await repo.insert(collection, {
      id: uuidv4(),
      orgId: req.user.orgId,
      ...defaults,
      ...body,
      tags: body.tags || [],
      createdBy: req.user.uid,
      updatedBy: req.user.uid,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
    });
    await recordAudit(req, { action: `${permPrefix}.create`, entityType: permPrefix, entityId: record.id, newValue: record });
    created(res, record);
  });

  // PATCH /:id
  router.patch('/:id', requireAuth, requirePermission(perm('edit')), async (req, res) => {
    const record = await repo.findById(collection, req.params.id);
    if (!record || !belongsToSameOrg(req, record.orgId)) return fail(res, 404, 'Record not found');

    const updates = {};
    for (const f of fields) if (f in req.body) updates[f] = req.body[f];
    updates.updatedBy = req.user.uid;
    updates.updatedAt = nowIso();

    const oldValue = { ...record };
    const updated = await repo.updateById(collection, record.id, updates);
    await recordAudit(req, { action: `${permPrefix}.update`, entityType: permPrefix, entityId: record.id, oldValue, newValue: updated });
    ok(res, updated);
  });

  // DELETE /:id — soft delete
  router.delete('/:id', requireAuth, requirePermission(perm('delete')), async (req, res) => {
    const record = await repo.findById(collection, req.params.id);
    if (!record || !belongsToSameOrg(req, record.orgId)) return fail(res, 404, 'Record not found');
    await repo.updateById(collection, record.id, { deletedAt: nowIso(), updatedBy: req.user.uid });
    await recordAudit(req, { action: `${permPrefix}.delete`, entityType: permPrefix, entityId: record.id });
    noContent(res);
  });

  // POST /:id/restore — requires the generic crm.restore permission
  router.post('/:id/restore', requireAuth, requirePermission('crm.restore'), async (req, res) => {
    const record = await repo.findById(collection, req.params.id);
    if (!record || !belongsToSameOrg(req, record.orgId)) return fail(res, 404, 'Record not found');
    const updated = await repo.updateById(collection, record.id, { deletedAt: null });
    await recordAudit(req, { action: `${permPrefix}.restore`, entityType: permPrefix, entityId: record.id });
    ok(res, updated);
  });

  // POST /:id/assign  { userId } — requires crm.assign
  router.post('/:id/assign', requireAuth, requirePermission('crm.assign'), async (req, res) => {
    const { userId } = req.body || {};
    const record = await repo.findById(collection, req.params.id);
    if (!record || !belongsToSameOrg(req, record.orgId)) return fail(res, 404, 'Record not found');
    const oldValue = { assignedUserId: record.assignedUserId };
    const updated = await repo.updateById(collection, record.id, { assignedUserId: userId, updatedAt: nowIso() });
    await recordAudit(req, { action: `${permPrefix}.assign`, entityType: permPrefix, entityId: record.id, oldValue, newValue: { assignedUserId: userId } });
    if (userId) {
      await notify({
        orgId: req.user.orgId, userId, type: `${permPrefix}.assigned`,
        title: `New ${permPrefix} assigned to you`, body: record.name || record.id,
      });
    }
    ok(res, updated);
  });

  // POST /bulk  { ids: [], action: 'delete'|'update', patch? } — requires crm.bulk_update / crm.bulk_delete
  router.post('/bulk', requireAuth, async (req, res) => {
    const { ids = [], action, patch = {} } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || !['delete', 'update'].includes(action)) {
      return fail(res, 400, 'ids[] and action ("delete"|"update") are required');
    }
    const requiredPerm = action === 'delete' ? 'crm.bulk_delete' : 'crm.bulk_update';
    if (!req.user.isSuperAdmin) {
      const effective = await getEffectivePermissions(req.user.uid);
      if (!effective || !effective.has(requiredPerm)) return fail(res, 403, `Missing required permission: ${requiredPerm}`);
    }

    let affected = 0;
    for (const id of ids) {
      const record = await repo.findById(collection, id);
      if (!record || !belongsToSameOrg(req, record.orgId)) continue;
      if (action === 'delete') {
        await repo.updateById(collection, id, { deletedAt: nowIso() });
      } else {
        const safePatch = {};
        for (const f of fields) if (f in patch) safePatch[f] = patch[f];
        await repo.updateById(collection, id, { ...safePatch, updatedAt: nowIso(), updatedBy: req.user.uid });
      }
      affected++;
    }
    await recordAudit(req, { action: `${permPrefix}.bulk_${action}`, entityType: permPrefix, entityId: ids.join(','), newValue: { ids, action, patch } });
    ok(res, { affected });
  });

  // GET /export/all — requires crm.export, returns JSON (CSV conversion is a frontend concern)
  router.get('/export/all', requireAuth, requirePermission('crm.export'), async (req, res) => {
    await recordAudit(req, { action: `${permPrefix}.export`, entityType: permPrefix, entityId: 'bulk' });
    ok(res, await scoped(req));
  });

  return router;
}

module.exports = { createCrmRouter };
