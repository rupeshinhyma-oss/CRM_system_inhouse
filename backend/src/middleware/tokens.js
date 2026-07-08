const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, nowIso } = require('../db/db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production-min-32-chars';
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 7;

function signAccessToken(user) {
  return jwt.sign(
    { uid: user.id, orgId: user.orgId, isSuperAdmin: !!user.isSuperAdmin, roleId: user.roleId || null },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Issues a refresh token, stores only its hash server-side so it can be revoked/rotated. */
function issueRefreshToken(user, { ip, userAgent } = {}) {
  const raw = uuidv4() + uuidv4(); // opaque random token, not a JWT — avoids stateless-refresh replay issues
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.get('refreshTokens').push({
    id: uuidv4(),
    userId: user.id,
    tokenHash: hashToken(raw),
    revoked: false,
    expiresAt,
    createdAt: nowIso(),
    ip: ip || null,
    userAgent: userAgent || null,
  }).write();
  return raw;
}

/** Verifies a refresh token against the store, and rotates it (old one revoked, new one issued). */
function rotateRefreshToken(rawToken, { ip, userAgent } = {}) {
  const tokenHash = hashToken(rawToken);
  const record = db.get('refreshTokens').find({ tokenHash }).value();
  if (!record || record.revoked || new Date(record.expiresAt) < new Date()) return null;

  const user = db.get('users').find({ id: record.userId }).value();
  if (!user || !user.enabled) return null;

  db.get('refreshTokens').find({ id: record.id }).assign({ revoked: true }).write();
  const newRaw = issueRefreshToken(user, { ip, userAgent });
  return { user, accessToken: signAccessToken(user), refreshToken: newRaw };
}

function revokeAllRefreshTokensForUser(userId) {
  db.get('refreshTokens').filter({ userId }).each((t) => { t.revoked = true; }).write();
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = {
  JWT_SECRET,
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeAllRefreshTokensForUser,
  verifyAccessToken,
};
