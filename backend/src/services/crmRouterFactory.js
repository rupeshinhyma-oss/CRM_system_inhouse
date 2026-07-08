const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, nowIso } = require('../db/db');
const { requireAuth, requirePermission, belongsToSameOrg, getEffectivePermissions } = require('../middleware/authGuards');
const { recordAudit } = require('../middleware/auditLog');
const { notify } = require('./notificationService');
const { ok, created, fail, noContent, paginate } = require('../utils/respond');

/**
 * Builds a fully-featured CRM entity router (contacts/companies/leads/deals/...)
 * so every module gets the same CRUD + search + pagination + sort + filter +
 * bulk actions + soft delete + audit log behavior for free, instead of
 * hand-rolling it four times.
 *
 * @param {object} cfg
 * @param {string} cfg.collection    lowdb collection name, e.g. 'contacts'
 * @param {string} cfg.permPrefix    permission prefix, e.g. 'contact' -> contact.view/create/edit/delete
 * @param {string[]} cfg.fields      whitelist of editable fields
 * @param {string[]} cfg.searchable  fields checked against ?search=
 * @param {object} [cfg.defaults]    default field values merged into every new record
 */
function createCrmRouter({ collection, permPrefix, fields, searchable, defaults = {} }) {
  const router = express.Router();
  const perm = (action) => `${permPrefix}.${action}`;

  function scoped(req) {
    return db.get(collection).filter((r) => r.orgId === req.user.orgId && !r.deletedAt);
  }

  // GET /?search=&page=&pageSize=&sortBy=&sortDir=&tag=&assignedTo=&...filters
  router.get('/', requireAuth, requirePermission(perm('view')), (req, res) => {
    const { search, page, pageSize, sortBy, sortDir, assignedTo, includeDeleted } = req.query;
    let records = includeDeleted === 'true'
      ? db.get(collection).filter({ orgId: req.user.orgId }).value()
      : scoped(req).value();

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
  router.get('/:id', requireAuth, requirePermission(perm('view')), (req, res) => {
    const record = db.get(collection).find({ id: req.params.id }).value();
    if (!record || !belongsToSameOrg(req, record.orgId)) return fail(res, 404, 'Record not found');
    ok(res, record);
  });

  // POST /
  router.post('/', requireAuth, requirePermission(perm('create')), (req, res) => {
    const body = {};
    for (const f of fields) if (f in req.body) body[f] = req.body[f];

    const record = {
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
    };
    db.get(collection).push(record).write();
    recordAudit(req, { action: `${permPrefix}.create`, entityType: permPrefix, entityId: record.id, newValue: record });
    created(res, record);
  });

  // PATCH /:id
  router.patch('/:id', requireAuth, requirePermission(perm('edit')), (req, res) => {
    const record = db.get(collection).find({ id: req.params.id }).value();
    if (!record || !belongsToSameOrg(req, record.orgId)) return fail(res, 404, 'Record not found');

    const updates = {};
    for (const f of fields) if (f in req.body) updates[f] = req.body[f];
    updates.updatedBy = req.user.uid;
    updates.updatedAt = nowIso();

    const oldValue = { ...record };
    const updated = db.get(collection).find({ id: record.id }).assign(updates).write();
    recordAudit(req, { action: `${permPrefix}.update`, entityType: permPrefix, entityId: record.id, oldValue, newValue: updated });
    ok(res, updated);
  });

  // DELETE /:id — soft delete
  router.delete('/:id', requireAuth, requirePermission(perm('delete')), (req, res) => {
    const record = db.get(collection).find({ id: req.params.id }).value();
    if (!record || !belongsToSameOrg(req, record.orgId)) return fail(res, 404, 'Record not found');
    db.get(collection).find({ id: record.id }).assign({ deletedAt: nowIso(), updatedBy: req.user.uid }).write();
    recordAudit(req, { action: `${permPrefix}.delete`, entityType: permPrefix, entityId: record.id });
    noContent(res);
  });

  // POST /:id/restore — requires the generic crm.restore permission
  router.post('/:id/restore', requireAuth, requirePermission('crm.restore'), (req, res) => {
    const record = db.get(collection).find({ id: req.params.id }).value();
    if (!record || !belongsToSameOrg(req, record.orgId)) return fail(res, 404, 'Record not found');
    const updated = db.get(collection).find({ id: record.id }).assign({ deletedAt: null }).write();
    recordAudit(req, { action: `${permPrefix}.restore`, entityType: permPrefix, entityId: record.id });
    ok(res, updated);
  });

  // POST /:id/assign  { userId } — requires crm.assign
  router.post('/:id/assign', requireAuth, requirePermission('crm.assign'), (req, res) => {
    const { userId } = req.body || {};
    const record = db.get(collection).find({ id: req.params.id }).value();
    if (!record || !belongsToSameOrg(req, record.orgId)) return fail(res, 404, 'Record not found');
    const oldValue = { assignedUserId: record.assignedUserId };
    const updated = db.get(collection).find({ id: record.id }).assign({ assignedUserId: userId, updatedAt: nowIso() }).write();
    recordAudit(req, { action: `${permPrefix}.assign`, entityType: permPrefix, entityId: record.id, oldValue, newValue: { assignedUserId: userId } });
    if (userId) {
      notify({
        orgId: req.user.orgId, userId, type: `${permPrefix}.assigned`,
        title: `New ${permPrefix} assigned to you`, body: record.name || record.id,
      });
    }
    ok(res, updated);
  });

  // POST /bulk  { ids: [], action: 'delete'|'update', patch? } — requires crm.bulk_update / crm.bulk_delete
  router.post('/bulk', requireAuth, (req, res) => {
    const { ids = [], action, patch = {} } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || !['delete', 'update'].includes(action)) {
      return fail(res, 400, 'ids[] and action ("delete"|"update") are required');
    }
    const requiredPerm = action === 'delete' ? 'crm.bulk_delete' : 'crm.bulk_update';
    if (!req.user.isSuperAdmin) {
      const effective = getEffectivePermissions(req.user.uid);
      if (!effective || !effective.has(requiredPerm)) return fail(res, 403, `Missing required permission: ${requiredPerm}`);
    }

    let affected = 0;
    ids.forEach((id) => {
      const record = db.get(collection).find({ id }).value();
      if (!record || !belongsToSameOrg(req, record.orgId)) return;
      if (action === 'delete') {
        db.get(collection).find({ id }).assign({ deletedAt: nowIso() }).write();
      } else {
        const safePatch = {};
        for (const f of fields) if (f in patch) safePatch[f] = patch[f];
        db.get(collection).find({ id }).assign({ ...safePatch, updatedAt: nowIso(), updatedBy: req.user.uid }).write();
      }
      affected++;
    });
    recordAudit(req, { action: `${permPrefix}.bulk_${action}`, entityType: permPrefix, entityId: ids.join(','), newValue: { ids, action, patch } });
    ok(res, { affected });
  });

  // GET /export — requires crm.export, returns JSON (CSV conversion is a frontend/export-service concern)
  router.get('/export/all', requireAuth, requirePermission('crm.export'), (req, res) => {
    recordAudit(req, { action: `${permPrefix}.export`, entityType: permPrefix, entityId: 'bulk' });
    ok(res, scoped(req).value());
  });

  return router;
}

module.exports = { createCrmRouter };
