# Enterprise CRM + Chat Platform (Phase 1: Multi-Tenant Foundation)

This is the enterprise evolution of the original single-tenant chat MVP. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full architecture plan,
permission matrix, API surface, and phased roadmap — read that first.

## What's in this phase

- Multi-tenant data model (every table is `orgId`-scoped)
- Email-only identity, single-Super-Admin enforcement, rotating/revocable refresh tokens
- Full Permission-Based Access Control (role → permissions, + per-user overrides), 11 seeded default roles
- Audit logging on every mutating action
- CRM: Contacts, Companies, Leads (+ convert), Deals (+ close) — CRUD, search, pagination, sort, bulk actions, soft delete/restore, assign
- Chat: DMs, groups, department/announcement channel types, org-scoped Socket.IO real-time layer, cross-org conversation support (gated by explicit sharing grants)
- Cross-organization collaboration: Super-Admin-enabled links + org-admin-granted, resource-scoped, revocable shares
- Notifications (in-app; email/push/SMS/WhatsApp channels stubbed for later workers)
- Clean architecture: `routes/ → services/ → repositories via db.js`, `middleware/`, `permissions/`, `sockets/`

## Run it

```bash
cd backend
npm install
cp .env.example .env
# Edit .env: set JWT_SECRET, and SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD for first boot
npm start          # -> Enterprise CRM+Chat backend listening on :8080
```

Data persists to `backend/data.json` (git-ignored). Delete it to reset everything, including the bootstrapped Super Admin.

> **Note:** this was authored in a sandboxed environment without network
> access, so `npm install` hasn't been run against it here — only every
> file's syntax and every `require()` path have been verified. Run
> `npm install` in your own environment before starting the server.

## Quick start flow

1. `POST /api/v1/auth/register-organization` — creates your organization + you as its Owner (full permissions).
2. `POST /api/v1/auth/login` — get your access + refresh token.
3. Use `Authorization: Bearer <accessToken>` on everything else.
4. As Owner, invite teammates: `POST /api/v1/users/invite` (assign one of the 11 seeded roles, or create a custom one via `POST /api/v1/roles` first).
5. Separately, the **Super Admin** logs in with the credentials from `.env` and manages organizations at `/api/v1/organizations`.

## File structure

```
backend/
  src/
    server.js              Express + Socket.IO bootstrap, security headers, rate limiting
    db/db.js                lowdb schema (shaped to map 1:1 onto PRISMA_SCHEMA.prisma)
    permissions/             catalog.js (every permission string), rolesSeed.js (default role bundles)
    middleware/               authGuards.js (requireAuth/requireSuperAdmin/requirePermission),
                              tokens.js (JWT + rotating refresh tokens), auditLog.js, security.js
    services/                 organizationService.js, notificationService.js, crmRouterFactory.js
    routes/v1/                auth, organizations, roles, permissions, users, departments, audit,
                              contacts, companies, leads, deals, groups, messages, collaboration, notifications
    sockets/index.js          real-time chat: send/typing/read/presence, org-scoped rooms
  legacy/                    the original single-tenant MVP (db.js, routes/, socket.js, server.js) — kept for reference, no longer wired into package.json
  PRISMA_SCHEMA.prisma        target relational schema for the future Postgres migration
frontend/
  index.html                 original MVP UI — still points at the old API shape; a permission-aware
                              dashboard rebuild is Phase 4 (see ARCHITECTURE.md)
```

## Moving to production

See `ARCHITECTURE.md` §8 for the full list of intentional gaps. In short:
Postgres via the included Prisma schema, S3 for files, Redis Socket.IO
adapter for horizontal scaling, real `helmet`/`express-rate-limit` packages,
email verification + MFA flows.
