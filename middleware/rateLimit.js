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
    // Handle both HTTP requests and Socket.IO sockets
    let key;
    if (req.handshake) {
      // Socket.IO socket — use handshake address
      key = req.handshake.address || req.conn?.remoteAddress || 'unknown';
    } else {
      // HTTP request
      key = req.ip || req.connection?.remoteAddress || 'unknown';
    }
    const now = Date.now();

    let data = store.get(key);

    if (!data || now - data.windowStart > windowMs) {
      // New window
      data = { windowStart: now, count: 1 };
      store.set(key, data);
    } else {
      data.count++;
    }

    // Set rate limit headers (only for HTTP responses)
    const remaining = Math.max(0, max - data.count);
    const resetTime = data.windowStart + windowMs;
    if (res && res.set) {
      res.set('X-RateLimit-Limit', max);
      res.set('X-RateLimit-Remaining', remaining);
      res.set('X-RateLimit-Reset', Math.ceil(resetTime / 1000));
    }

    if (data.count > max) {
      const retryAfter = Math.ceil((resetTime - now) / 1000);
      // Socket.IO context: res might not exist
      if (res && res.set) {
        res.set('Retry-After', retryAfter);
        return res.status(429).json({
          error: message,
          code: 'RATE_LIMITED',
          retryAfter,
        });
      }
      // Socket.IO context: emit error and don't proceed
      if (req.emit) {
        req.emit('send:error', { message: 'Rate limited. Try again later.', code: 'RATE_LIMITED' });
      }
      return;
    }

    next();
  };
}

module.exports = rateLimit;
