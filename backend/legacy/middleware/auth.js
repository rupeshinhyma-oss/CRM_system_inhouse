const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production-min-32-chars';

function signAccessToken(user) {
  return jwt.sign(
    { uid: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

function signRefreshToken(user) {
  return jwt.sign({ uid: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/** Express middleware: requires a valid Bearer token, attaches req.user = { uid, email, role } */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    req.user = verifyToken(header.substring(7));
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'SYSTEM_ADMIN') {
    return res.status(403).json({ error: 'System administrator access required' });
  }
  next();
}

module.exports = { JWT_SECRET, signAccessToken, signRefreshToken, verifyToken, requireAuth, requireAdmin };
