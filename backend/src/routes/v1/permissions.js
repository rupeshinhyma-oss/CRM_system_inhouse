const express = require('express');
const { ALL_PERMISSIONS, PERMISSION_GROUPS } = require('../../permissions/catalog');
const { requireAuth } = require('../../middleware/authGuards');
const { ok } = require('../../utils/respond');

const router = express.Router();

// GET /api/v1/permissions — the full permission catalog, grouped by module
router.get('/', requireAuth, (req, res) => {
  ok(res, { groups: PERMISSION_GROUPS, all: ALL_PERMISSIONS });
});

module.exports = router;
