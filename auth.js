const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./database');
const logger = require('./logger');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const JWT_EXPIRES = '7d';
const BCRYPT_ROUNDS = 12;

// Generate JWT token
function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// Verify JWT token
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Hash password
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// Compare password
async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Extract token from request
function extractToken(req) {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  // Check cookie
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }
  return null;
}

// Auth middleware
function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      if (req.xhr || req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      }
      return res.redirect('/login');
    }

    const decoded = verifyToken(token);

    // Check if session exists and is valid
    const session = db.getSession(decoded.userId, token);
    if (!session) {
      if (req.xhr || req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Session expired', code: 'SESSION_EXPIRED' });
      }
      return res.redirect('/login');
    }

    // Get user
    const user = db.getUserById(decoded.userId);
    if (!user) {
      if (req.xhr || req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      }
      return res.redirect('/login');
    }

    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    logger.error(`Auth middleware error: ${err.message}`);
    if (req.xhr || req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
    }
    return res.redirect('/login');
  }
}

// Auth routes (no auth required)
function setupAuthRoutes(app, rateLimit) {
  // Rate limiter for auth: 5 attempts per 15 min
  const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

  // Register
  app.post('/api/auth/register', authRateLimit, async (req, res) => {
    try {
      const { email, password, name } = req.body;

      // Validate
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required', code: 'MISSING_FIELDS' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters', code: 'WEAK_PASSWORD' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email format', code: 'INVALID_EMAIL' });
      }

      // Check if email exists
      const existing = db.getUserByEmail(email.trim().toLowerCase());
      if (existing) {
        return res.status(409).json({ error: 'Email already registered', code: 'EMAIL_EXISTS' });
      }

      // First user gets admin
      const userCount = db.getUserCount();
      const role = userCount === 0 ? 'admin' : 'user';

      // Hash password
      const passwordHash = await hashPassword(password);

      // Create user
      const result = db.createUser(email.trim().toLowerCase(), passwordHash, name || '', role);

      // Generate token
      const token = generateToken(result.id);

      // Store session
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      db.createSession(result.id, token, expiresAt);

      logger.info(`User registered: ${email} (role: ${role})`);

      res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
      res.json({
        success: true,
        token,
        user: { id: result.id, email: email.trim().toLowerCase(), name: name || '', role },
      });
    } catch (err) {
      logger.error(`Register error: ${err.message}`);
      res.status(500).json({ error: 'Registration failed', code: 'REGISTER_ERROR' });
    }
  });

  // Login
  app.post('/api/auth/login', authRateLimit, async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required', code: 'MISSING_FIELDS' });
      }

      const user = db.getUserByEmail(email.trim().toLowerCase());
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
      }

      const valid = await comparePassword(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
      }

      // Generate token
      const token = generateToken(user.id);

      // Store session
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      db.createSession(user.id, token, expiresAt);

      // Update last login
      db.updateLastLogin(user.id);

      logger.info(`User logged in: ${email}`);

      res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
      res.json({
        success: true,
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
      });
    } catch (err) {
      logger.error(`Login error: ${err.message}`);
      res.status(500).json({ error: 'Login failed', code: 'LOGIN_ERROR' });
    }
  });

  // Logout
  app.post('/api/auth/logout', (req, res) => {
    try {
      const token = extractToken(req);
      if (token) {
        db.deleteSession(token);
        logger.info('User logged out');
      }
      res.clearCookie('token');
      res.json({ success: true });
    } catch (err) {
      logger.error(`Logout error: ${err.message}`);
      res.status(500).json({ error: 'Logout failed', code: 'LOGOUT_ERROR' });
    }
  });

  // Get current user
  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
      whatsapp_session_id: req.user.whatsapp_session_id,
      created_at: req.user.created_at,
      last_login: req.user.last_login,
    });
  });
}

module.exports = {
  generateToken,
  verifyToken,
  hashPassword,
  comparePassword,
  requireAuth,
  setupAuthRoutes,
  extractToken,
};
