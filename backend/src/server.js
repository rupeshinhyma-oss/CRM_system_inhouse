require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const { securityHeaders, createRateLimiter } = require('./middleware/security');
const { registerSocketHandlers } = require('./sockets');

const setupRoutes = require('./routes/v1/setup');
const authRoutes = require('./routes/v1/auth');
const organizationRoutes = require('./routes/v1/organizations');
const businessUnitRoutes = require('./routes/v1/businessUnits');
const roleRoutes = require('./routes/v1/roles');
const permissionRoutes = require('./routes/v1/permissions');
const userRoutes = require('./routes/v1/users');
const departmentRoutes = require('./routes/v1/departments');
const auditRoutes = require('./routes/v1/audit');
const contactRoutes = require('./routes/v1/contacts');
const companyRoutes = require('./routes/v1/companies');
const leadRoutes = require('./routes/v1/leads');
const dealRoutes = require('./routes/v1/deals');
const groupRoutes = require('./routes/v1/groups');
const messageRoutes = require('./routes/v1/messages');
const collaborationRoutes = require('./routes/v1/collaboration');
const notificationRoutes = require('./routes/v1/notifications');

// NOTE: there is no env-based Super Admin bootstrap anymore. The very first
// person to open this app creates the Super Admin account themselves through
// a real signup form — see /api/v1/setup and the frontend's "System setup"
// screen. That endpoint permanently locks itself once one Super Admin exists.

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000').split(',');

app.use(securityHeaders);
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(createRateLimiter({ windowMs: 60_000, max: 300 }));

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), dbDriver: process.env.DB_DRIVER || 'lowdb' }));

app.use('/api/v1/setup', setupRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/organizations', organizationRoutes);
app.use('/api/v1/business-units', businessUnitRoutes);
app.use('/api/v1/roles', roleRoutes);
app.use('/api/v1/permissions', permissionRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/departments', departmentRoutes);
app.use('/api/v1/audit-logs', auditRoutes);
app.use('/api/v1/contacts', contactRoutes);
app.use('/api/v1/companies', companyRoutes);
app.use('/api/v1/leads', leadRoutes);
app.use('/api/v1/deals', dealRoutes);
app.use('/api/v1/groups', groupRoutes);
app.use('/api/v1', messageRoutes); // /conversations*, /messages/:id/*
app.use('/api/v1/collaboration', collaborationRoutes);
app.use('/api/v1/notifications', notificationRoutes);

// --- Serve the frontend from the same Express app/port, so one Railway (or any) ---
// --- deployment hosts both the API and the UI. Relative fetch('/api/v1/...') and ---
// --- io(window.location.origin) calls in app.js work unchanged in both places.  ---
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(FRONTEND_DIR));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/health') return next();
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS, credentials: true } });
registerSocketHandlers(io);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Enterprise CRM+Chat backend listening on :${PORT} (DB_DRIVER=${process.env.DB_DRIVER || 'lowdb'})`);
});
