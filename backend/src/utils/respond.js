/** Consistent JSON envelope so every /api/v1 endpoint returns a predictable shape. */
function ok(res, data, meta) {
  const body = { data };
  if (meta) body.meta = meta;
  return res.json(body);
}

function created(res, data) {
  return res.status(201).json({ data });
}

function noContent(res) {
  return res.status(204).send();
}

function fail(res, status, error, details) {
  const body = { error };
  if (details) body.details = details;
  return res.status(status).json(body);
}

function paginate(array, { page = 1, pageSize = 25 } = {}) {
  const p = Math.max(parseInt(page) || 1, 1);
  const size = Math.min(Math.max(parseInt(pageSize) || 25, 1), 200);
  const start = (p - 1) * size;
  return {
    items: array.slice(start, start + size),
    meta: { page: p, pageSize: size, total: array.length, totalPages: Math.ceil(array.length / size) },
  };
}

module.exports = { ok, created, noContent, fail, paginate };
