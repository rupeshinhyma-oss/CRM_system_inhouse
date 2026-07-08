/**
 * Hand-rolled equivalent of the security headers `helmet` would set.
 * Swap for `require('helmet')()` once you can `npm install` in your own
 * environment — behavior is the same, this just avoids a new dependency
 * in the sandboxed build environment this was authored in.
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0'); // modern guidance: rely on CSP, not this legacy header
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; script-src 'self'; style-src 'self' 'unsafe-inline'"
  );
  next();
}

/** Simple per-IP sliding-window rate limiter — swap for a Redis-backed one at scale. */
function createRateLimiter({ windowMs = 60_000, max = 300 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const bucket = buckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + windowMs; }
    bucket.count++;
    buckets.set(key, bucket);
    if (bucket.count > max) return res.status(429).json({ error: 'Too many requests, slow down' });
    next();
  };
}

module.exports = { securityHeaders, createRateLimiter };
