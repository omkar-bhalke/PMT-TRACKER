import crypto from 'node:crypto';

/**
 * Per-user authentication for the Android app. The app sends the SAME token it got from cPanel login;
 * Railway asks cPanel to validate it (no shared JWT secret, no shared password) and caches a positive
 * answer for 60 s. Every route then works ONLY on req.userId.
 */
export function makeAuth({ cpanel, ttlMs = 60000 }) {
  const cache = new Map();
  return async function auth(req, res, next) {
    const header = req.get('authorization') || '';
    if (!/^Bearer\s+\S+/i.test(header)) return res.status(401).json({ success: false, code: 'TOKEN_MISSING', message: 'Login required' });
    const device = req.get('x-device-id') || '';
    const key = crypto.createHash('sha256').update(header + '|' + device).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) { req.userId = hit.userId; return next(); }
    try {
      const userId = await cpanel.verifyUserToken(header, device);
      if (!userId) return res.status(401).json({ success: false, code: 'TOKEN_INVALID', message: 'Session expired. Please log in again.' });
      cache.set(key, { userId, exp: Date.now() + ttlMs });
      if (cache.size > 2000) for (const [k, v] of cache) if (v.exp < Date.now()) cache.delete(k);
      req.userId = userId; next();
    } catch (e) {
      res.status(503).json({ success: false, code: 'AUTH_BACKEND_DOWN', message: 'Cannot verify login right now. Please retry.' });
    }
  };
}
