/**
 * Simple in-memory sliding window rate limiter
 * Usage: app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 100 }));
 */
function rateLimit({ windowMs = 15 * 60 * 1000, max = 100, message = 'Too many requests' } = {}) {
  const store = new Map();

  // Cleanup expired entries every 5 minutes
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, data] of store.entries()) {
      if (now - data.windowStart > windowMs) {
        store.delete(key);
      }
    }
  }, 5 * 60 * 1000);

  // Allow cleanup to prevent memory leaks
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return function rateLimitMiddleware(req, res, next) {
    const key = req.ip || req.connection.remoteAddress;
    const now = Date.now();

    let data = store.get(key);

    if (!data || now - data.windowStart > windowMs) {
      // New window
      data = { windowStart: now, count: 1 };
      store.set(key, data);
    } else {
      data.count++;
    }

    // Set rate limit headers
    const remaining = Math.max(0, max - data.count);
    const resetTime = data.windowStart + windowMs;
    res.set('X-RateLimit-Limit', max);
    res.set('X-RateLimit-Remaining', remaining);
    res.set('X-RateLimit-Reset', Math.ceil(resetTime / 1000));

    if (data.count > max) {
      const retryAfter = Math.ceil((resetTime - now) / 1000);
      res.set('Retry-After', retryAfter);
      return res.status(429).json({
        error: message,
        code: 'RATE_LIMITED',
        retryAfter,
      });
    }

    next();
  };
}

module.exports = rateLimit;
