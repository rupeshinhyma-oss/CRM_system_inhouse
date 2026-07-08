require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const groupRoutes = require('./routes/groups');
const messageRoutes = require('./routes/messages');
const { registerSocketHandlers } = require('./socket');

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000').split(',');

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: '2mb' }));

// basic in-memory rate limiter (per-IP) — swap for Redis-backed limiter at scale
const rateBuckets = new Map();
app.use((req, res, next) => {
  const key = req.ip;
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + 60_000 };
  if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 60_000; }
  bucket.count++;
  rateBuckets.set(key, bucket);
  if (bucket.count > 300) return res.status(429).json({ error: 'Too many requests, slow down' });
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/groups', groupRoutes);
app.use('/api/v1', messageRoutes); // exposes /conversations* and /messages/:id/*

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS, credentials: true } });
registerSocketHandlers(io);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Enterprise chat backend listening on :${PORT}`));
