# Architecture Plan — Enterprise CRM + Chat Platform

## 1. What changed vs. the original MVP, and why

| Area | Before | After (Phase 1) | Why |
|---|---|---|---|
| Identity | `@username`, auto-generated | Email only, globally unique | Spec requirement; usernames add a collision-prone layer with no enterprise value |
| Tenancy | None (single implicit org) | Every table carries `orgId`; every query filters by it | Multi-tenant isolation is the foundation everything else sits on |
| AuthZ | Two flat roles (`SYSTEM_ADMIN`/`EMPLOYEE`) | Role → Permission (many-to-many) + per-user GRANT/REVOKE overrides | Spec explicitly requires PBAC, not just RBAC |
| Refresh tokens | Stateless JWT, unrevocable | Opaque random token, hashed server-side, rotated on every use, revocable | Enterprise security baseline — a stolen refresh JWT used to be valid until expiry no matter what |
| Audit | None | `auditLogs` table + `recordAudit()` called from every mutating route | Explicit spec requirement, and non-negotiable for enterprise buyers |
| Super Admin | N/A | Exactly one, bootstrapped from env vars, never created via public API | Spec requires a single, non-duplicable super-admin identity |
| Chat | Org-agnostic | Org-scoped rooms/permissions, `kind` field for GROUP/DEPARTMENT/ANNOUNCEMENT, cross-org conversations carry `crossOrgLinkId` | Needed before cross-org collaboration or department channels can exist safely |
| CRM | Didn't exist | Contacts/Companies/Leads/Deals via a shared CRUD factory (search, pagination, sort, soft delete/restore, bulk ops, assign, audit) | Core of the spec; factory keeps 4 modules consistent instead of hand-rolled |
| DB | `lowdb` JSON file | Still `lowdb` (no network access to install Postgres driver in this build environment), but every collection is shaped to map 1:1 onto `PRISMA_SCHEMA.prisma` | Keeps the app runnable today with zero new installs; migration later is data-shape-preserving, not a rewrite |

## 2. Multi-tenancy model

- Every business record (`users`, `contacts`, `companies`, `leads`, `deals`, `groups`, `conversations`, `departments`, `auditLogs`, `notifications`) carries `orgId`.
- `belongsToSameOrg(req, resourceOrgId)` is the single choke point every route uses before returning or mutating a record. Super Admin bypasses it; nobody else does.
- The only place two organizations' data touches is `sharedOrganizations` + `sharedResourceGrants` — see §5.

## 2.5 Database abstraction layer (swap databases by writing ONE file)

Every route, service, and middleware talks to storage only through 8 generic
async methods (`list`, `findOne`, `findById`, `insert`, `updateById`,
`updateWhere`, `removeById`, `removeWhere`, `count`) defined in
`src/db/index.js` and implemented today by `src/db/drivers/lowdbDriver.js`.

Nothing outside `src/db/drivers/*` imports `lowdb` (or would import `pg`,
`mongodb`, etc.) directly. To move to Postgres, MySQL, or MongoDB later:

1. Implement the 8 methods in the matching template (`postgresDriver.js`,
   `mysqlDriver.js`, or `mongoDriver.js` — already scaffolded with setup
   instructions and example code in comments).
2. Set `DB_DRIVER=postgres` (or `mysql`/`mongodb`) and `DATABASE_URL` in `.env`.
3. `npm install` whichever client library that driver needs.

That's it — no route, service, or permission check changes, because none of
them know which database is underneath. This is also why every repository
call site is `await`ed even though lowdb itself is synchronous: a real
network-backed database genuinely needs the `await`, and retrofitting async
across 19 files later would have been a much bigger job than building it in
from the start.

## 3. Identity & auth

- `POST /auth/register-organization` — the *only* public signup path for organizations. Creates an `Organization` + its `ORG_OWNER` user in one transaction-like operation (lowdb has no real transactions; this is a documented gap the Postgres migration closes with a real `$transaction`).
- `POST /auth/login`, `POST /auth/refresh` (rotating), `POST /auth/logout` (revokes all refresh tokens for the user), `GET /auth/me`.
- Access tokens: 15 min JWT, payload `{ uid, orgId, isSuperAdmin, roleId }`.
- Refresh tokens: opaque random string, only its SHA-256 hash is stored, single-use (rotated), revocable individually or all-at-once.
- **The Super Admin is created through the app itself, not environment variables.** `GET /api/v1/setup/status` tells the frontend whether a Super Admin exists yet; if not, the frontend shows a one-time "System setup" screen that calls `POST /api/v1/setup/super-admin`. That endpoint permanently locks itself (returns 409) the instant one Super Admin exists — there is no API path to create a second one. See `routes/v1/setup.js`.

## 4. Permission system (PBAC)

- `src/permissions/catalog.js` is the single source of truth for every permission string in the system (grouped: crm, lead, deal, company, contact, user, chat, file, analytics, admin — matches the spec's list exactly).
- `roles` are per-organization. `rolePermissions` is the join table.
- `userPermissionOverrides` lets an admin GRANT or REVOKE an individual permission for one user without creating a one-off role.
- Effective permission = `(role permissions ∪ GRANT overrides) − REVOKE overrides`. Super Admin short-circuits to "everything."
- `requirePermission('crm.export')` is the route-level enforcement point — every CRM, chat, user, and admin route is gated this way, not by role name.
- `src/permissions/rolesSeed.js` seeds 11 default roles (Org Owner, Admin, Manager, Sales Manager, Sales Agent, Support Manager, Support Agent, Marketing, HR, Finance, Employee) into every new org. Org admins can edit these (except the system-protected Org Owner bundle) or create fully custom roles via `POST /roles`.

### Permission matrix (abbreviated — full catalog is in `catalog.js`)

| Role | crm.* | lead.* | deal.* | contact/company.* | chat.* | user.* | admin.* |
|---|---|---|---|---|---|---|---|
| Org Owner | all | all | all | all | all | all | all |
| Admin | all | all | all | all | all | all | all (except role-protection bypass) |
| Manager | view/export/assign/transfer | — | — | full | full | view | analytics |
| Sales Manager | view/export/assign/transfer | full | full | create/edit/view | full | — | — |
| Sales Agent | — | create/edit/view | create/edit/view | create/edit/view | send/view | — | — |
| Support Manager | — | — | — | view/edit | full | view | — |
| Support Agent | — | — | — | view | send/view | — | — |
| Marketing | — | create/edit/view | — | create/view | full | — | — |
| HR | — | — | — | — | send/view | create/edit/view | — |
| Finance | — | — | view | view | send/view | — | — |
| Employee | — | — | — | view | send/view | — | — |

## 5. Cross-organization collaboration

Two-step, always explicit, never automatic:

1. **Super Admin** enables the *possibility* of collaboration between two orgs: `POST /collaboration/links`. This grants nothing by itself.
2. **An org admin on either side** (`admin.settings` permission) then grants a specific, scoped share: `POST /collaboration/links/:linkId/grants` with `{ resourceType, resourceId, permission }`. Each grant is one resource, one permission, one direction, auditable, and revocable independently.

Cross-org chat reuses the same `conversations` table with `crossOrgLinkId` set, so it gets the same Socket.IO room mechanics as any other conversation — no parallel chat system to maintain.

## 6. Audit logging

`recordAudit(req, { action, entityType, entityId, oldValue, newValue })` is called from every mutating route (create/update/delete/assign/disable/role changes/org lifecycle changes/collaboration grants). It captures `orgId`, `userId`, `ip`, `user-agent`, and a timestamp automatically from `req`. Viewable via `GET /audit-logs` (Super Admin sees everything, org admins see their own org only), gated by the `admin.audit` permission.

## 7. API surface (Phase 1)

```
/api/v1/auth                 register-organization, login, refresh, logout, me
/api/v1/organizations         CRUD (Super Admin create/suspend/activate/delete; org self-view/update)
/api/v1/roles                 list/create/update/delete custom roles per org
/api/v1/permissions           GET the full permission catalog
/api/v1/users                 invite/list/get/update/disable/enable/delete + permission overrides
/api/v1/departments            CRUD
/api/v1/audit-logs             GET, filterable
/api/v1/contacts               full CRM CRUD (search/paginate/sort/bulk/soft-delete/restore/assign/export)
/api/v1/companies               same shape as contacts
/api/v1/leads                   same shape + POST /:id/convert
/api/v1/deals                    same shape + POST /:id/close
/api/v1/groups                  chat channels: create/list mine/members
/api/v1/conversations            list/get-or-create DM/messages/search
/api/v1/messages/:id/(star|pin|delete)
/api/v1/collaboration/links      Super Admin enable, org admin grant/revoke
/api/v1/notifications            list/mark read
```

Every route returns `{ data, meta? }` on success and `{ error, details? }` on failure (see `src/utils/respond.js`).

## 8. What's intentionally NOT built yet (documented gaps, not silent omissions)

Consistent with "implement incrementally," these are named here rather than half-built:

- **Real relational DB.** `PRISMA_SCHEMA.prisma` defines the target shape; swapping `lowdb` for it is mechanical because every collection already matches a model 1:1. Requires network access to `npm install prisma @prisma/client pg`.
- **CRM extras**: Tasks, Meetings, Calls, Emails, Activities/Timeline, Pipelines/Stages as first-class objects (deals have a `stage` string today, not a configurable pipeline entity), Products, Quotes, Invoices, Orders, Custom Fields.
- **File/attachment storage** — no S3 integration; `file.*` permissions exist but no upload route yet.
- **Redis-backed Socket.IO adapter** for multi-instance horizontal scaling (`onlineSockets` is in-process today).
- **Frontend dashboard** — the existing static `frontend/index.html` still talks to the old MVP shape; a permission-aware React/Vue dashboard is a separate phase.
- **Email verification, password reset, MFA** — schema already has room (`isSuperAdmin`, `enabled` flags) but no flow is wired up.
- **Rate limiting / helmet** — hand-rolled equivalents in `src/middleware/security.js` since `helmet` isn't installable in this build environment; swap for the real package when you have network access, behavior is equivalent.

## 9. Suggested next phases

1. **Phase 2** — Postgres migration (wire up `PRISMA_SCHEMA.prisma`), file/attachment upload to S3-compatible storage, email verification + password reset flows.
2. **Phase 3** — CRM depth: Tasks/Meetings/Calls/Activities timeline, configurable Pipelines/Stages, Products/Quotes/Orders, Custom Fields engine.
3. **Phase 4** — Permission-aware frontend dashboard (org switcher for Super Admin, sidebar built from the caller's effective permission set).
4. **Phase 5** — AI-ready API layer (the doc's "AI Ready Architecture" ask) — scoped read-only API keys per org that respect the same PBAC checks.

Tell me which phase to build next and I'll pick up from here in the same architecture.
