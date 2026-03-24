require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const fs = require('fs');
const chalk = require('chalk');
const db = require('./database');
const wa = require('./whatsapp');
const logger = require('./logger');
const { requireAuth, setupAuthRoutes, extractToken, verifyToken } = require('./auth');
const rateLimit = require('./middleware/rateLimit');
const { sanitizeInputs, limitPayloadSize, validateCSV, isValidPhone } = require('./middleware/validate');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Security headers (manual helmet-like)
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('X-XSS-Protection', '1; mode=block');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Powered-By', 'WA Auto Send');
  next();
});

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logMsg = `${req.method} ${req.url} ${res.statusCode} ${duration}ms`;
    if (res.statusCode >= 500) {
      logger.error(logMsg);
    } else if (res.statusCode >= 400) {
      logger.warn(logMsg);
    } else {
      logger.info(logMsg);
    }
  });
  next();
});

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple cookie parser (no external dep needed)
app.use((req, res, next) => {
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    req.cookies = {};
    cookieHeader.split(';').forEach(cookie => {
      const parts = cookie.trim().split('=');
      const key = parts.shift();
      const value = parts.join('=');
      if (key) req.cookies[key] = value;
    });
  } else {
    req.cookies = {};
  }
  next();
});

// Input sanitization
app.use(sanitizeInputs);

// Rate limiters
const apiRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const sendRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

// Apply API rate limit to /api/ routes
app.use('/api/', apiRateLimit);

// Multer for CSV uploads
const upload = multer({
  dest: path.join(__dirname, 'data', 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files allowed'));
    }
  },
});

// Ensure uploads dir exists
fs.mkdirSync(path.join(__dirname, 'data', 'uploads'), { recursive: true });

// Set IO on WhatsApp manager
wa.setIO(io);

// --- Auth routes (NO auth required) ---
setupAuthRoutes(app, rateLimit);

// Health check (no auth — for Docker/Railway/monitoring)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Login page (no auth)
app.get('/login', (req, res) => {
  // If already logged in, redirect
  const token = extractToken(req);
  if (token) {
    try {
      const decoded = verifyToken(token);
      const session = db.getSession(decoded.userId, token);
      if (session) return res.redirect('/');
    } catch (e) { /* invalid token, show login */ }
  }
  res.render('login', { title: 'Login' });
});

// Register page (no auth)
app.get('/register', (req, res) => {
  const token = extractToken(req);
  if (token) {
    try {
      const decoded = verifyToken(token);
      const session = db.getSession(decoded.userId, token);
      if (session) return res.redirect('/');
    } catch (e) { /* invalid token */ }
  }
  res.render('register', { title: 'Register' });
});

// --- Auth middleware for all routes below ---
app.use(requireAuth);

// Socket.IO connection with JWT auth
io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }
  try {
    const decoded = verifyToken(token);
    const session = db.getSession(decoded.userId, token);
    if (!session) {
      return next(new Error('Session expired'));
    }
    const user = db.getUserById(decoded.userId);
    if (!user) {
      return next(new Error('User not found'));
    }
    socket.userId = user.id;
    socket.user = user;
    next();
  } catch (err) {
    return next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  logger.info(`[IO] Client connected (user ${socket.userId})`);

  // Join user-specific room
  socket.join(`user_${socket.userId}`);

  socket.emit('wa:status', wa.getStatus(socket.userId));

  socket.on('wa:init', () => {
    wa.initialize(socket.userId).catch(err => {
      logger.error(`[WA] Init error for user ${socket.userId}: ${err.message}`);
    });
  });

  socket.on('wa:status_request', () => {
    socket.emit('wa:status', wa.getStatus(socket.userId));
  });

  socket.on('send:start', sendRateLimit, async (data) => {
    try {
      const contacts = db.getUnsentContacts(data.limit || 999);
      if (contacts.length === 0) {
        socket.emit('send:complete', { sent: 0, failed: 0, total: 0 });
        return;
      }

      const templateId = data.templateId;
      const limit = data.limit ? parseInt(data.limit) : null;

      await wa.sendWithProtection(socket.userId, contacts, templateId, limit, (progress) => {
        io.to(`user_${socket.userId}`).emit('send:progress', progress);
      });
    } catch (err) {
      logger.error(`[SEND] Error for user ${socket.userId}: ${err.message}`);
      io.to(`user_${socket.userId}`).emit('send:error', { message: err.message });
    }
  });

  socket.on('send:pause', () => {
    wa.pause(socket.userId);
    io.to(`user_${socket.userId}`).emit('send:progress', { status: 'paused' });
  });

  socket.on('send:resume', () => {
    wa.resume(socket.userId);
    io.to(`user_${socket.userId}`).emit('send:progress', { status: 'resumed' });
  });

  socket.on('send:abort', () => {
    wa.abort(socket.userId);
    io.to(`user_${socket.userId}`).emit('send:progress', { status: 'aborted' });
  });

  socket.on('disconnect', () => {
    logger.info(`[IO] Client disconnected (user ${socket.userId})`);
  });
});

// --- Page Routes ---

// Dashboard
app.get('/', (req, res) => {
  const totalContacts = db.getTotalContacts();
  const sentToday = db.getSentToday();
  const config = db.getConfig();
  const remainingToday = Math.max(0, (config.daily_limit || 100) - sentToday);
  const successRate = db.getSuccessRate();
  const waStatus = wa.getStatus(req.user.id);

  res.render('dashboard', {
    title: 'Dashboard',
    totalContacts,
    sentToday,
    remainingToday,
    successRate,
    waStatus,
    user: req.user,
  });
});

// Contacts
app.get('/contacts', (req, res) => {
  const search = req.query.search || '';
  const page = parseInt(req.query.page) || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const contacts = db.getContacts({ search, offset, limit });
  const totalCount = db.getContactCount(search);
  const totalPages = Math.ceil(totalCount / limit);

  res.render('contacts', {
    title: 'Contacts',
    contacts,
    search,
    page,
    totalPages,
    totalCount,
    user: req.user,
  });
});

// Templates
app.get('/templates', (req, res) => {
  const templates = db.getTemplates();
  const contacts = db.getContacts({ limit: 5 });
  res.render('templates', {
    title: 'Templates',
    templates,
    sampleContacts: contacts,
    user: req.user,
  });
});

// Send page
app.get('/send', (req, res) => {
  const templates = db.getTemplates();
  const unsentCount = db.getUnsentContacts(99999).length;
  const waStatus = wa.getStatus(req.user.id);
  const config = db.getConfig();

  res.render('send', {
    title: 'Send Messages',
    templates,
    unsentCount,
    waStatus,
    config,
    user: req.user,
  });
});

// Logs
app.get('/logs', (req, res) => {
  const { status, dateFrom, dateTo } = req.query;
  const page = parseInt(req.query.page) || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const filters = { status: status || 'all', dateFrom, dateTo };
  const logs = db.getLogs({ ...filters, offset, limit });
  const totalCount = db.getLogsCount(filters);
  const totalPages = Math.ceil(totalCount / limit);

  res.render('logs', {
    title: 'Sent Logs',
    logs,
    filters,
    page,
    totalPages,
    totalCount,
    user: req.user,
  });
});

// Settings
app.get('/settings', (req, res) => {
  const config = db.getConfig();
  const waStatus = wa.getStatus(req.user.id);
  res.render('settings', {
    title: 'Settings',
    config,
    waStatus,
    user: req.user,
  });
});

// --- API Routes (all require auth) ---

// API: Upload CSV
app.post('/api/contacts/upload', upload.single('csv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const content = fs.readFileSync(req.file.path, 'utf-8');
    const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });

    // Validate CSV structure
    const validation = validateCSV(records);
    if (!validation.valid) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: validation.error });
    }

    let added = 0;
    let skipped = 0;

    for (const record of records) {
      const phone = record.phone || record.Phone || record.number || record.Number || '';
      const name = record.name || record.Name || '';
      const custom1 = record.custom1 || record.Custom1 || '';
      const custom2 = record.custom2 || record.Custom2 || '';

      if (phone) {
        const result = db.addContact(phone.trim(), name.trim(), custom1.trim(), custom2.trim());
        if (result.changes > 0) added++;
        else skipped++;
      }
    }

    fs.unlinkSync(req.file.path);
    logger.info(`[API] CSV upload by user ${req.user.id}: ${added} added, ${skipped} skipped`);
    res.json({ success: true, added, skipped, total: records.length });
  } catch (err) {
    logger.error(`[API] CSV upload error: ${err.message}`);
    res.status(400).json({ error: 'Failed to parse CSV: ' + err.message });
  }
});

// API: Add contact
app.post('/api/contacts', (req, res) => {
  const { phone, name, custom1, custom2 } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone is required' });

  // Validate phone
  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: 'Invalid phone number format (10-15 digits)' });
  }

  const result = db.addContact(phone, name || '', custom1 || '', custom2 || '');
  if (result.changes === 0) {
    return res.status(409).json({ error: 'Contact already exists' });
  }
  res.json({ success: true, id: result.lastInsertRowid });
});

// API: Delete contact
app.delete('/api/contacts/:id', (req, res) => {
  db.deleteContact(parseInt(req.params.id));
  res.json({ success: true });
});

// API: Add template
app.post('/api/templates', (req, res) => {
  const { name, content, is_default } = req.body;
  if (!name || !content) return res.status(400).json({ error: 'Name and content required' });

  const result = db.addTemplate(name, content, is_default ? 1 : 0);
  res.json({ success: true, id: result.lastInsertRowid });
});

// API: Update template
app.put('/api/templates/:id', (req, res) => {
  const { name, content, is_default } = req.body;
  db.updateTemplate(parseInt(req.params.id), name, content, is_default ? 1 : 0);
  res.json({ success: true });
});

// API: Delete template
app.delete('/api/templates/:id', (req, res) => {
  db.deleteTemplate(parseInt(req.params.id));
  res.json({ success: true });
});

// API: Preview template
app.post('/api/templates/preview', (req, res) => {
  const { content, contact } = req.body;
  if (!content) return res.status(400).json({ error: 'Content required' });

  const c = contact || {};
  const preview = content
    .replace(/\{name\}/g, c.name || 'John Doe')
    .replace(/\{phone\}/g, c.phone || '9876543210')
    .replace(/\{custom1\}/g, c.custom1 || 'City')
    .replace(/\{custom2\}/g, c.custom2 || 'Company');

  res.json({ preview });
});

// API: Export logs CSV
app.get('/api/logs/export', (req, res) => {
  const { status, dateFrom, dateTo } = req.query;
  const filters = { status: status || 'all', dateFrom, dateTo };
  const logs = db.getAllLogsForExport(filters);

  const csv = stringify(logs.map(l => ({
    id: l.id,
    phone: l.phone,
    name: l.name || '',
    message: l.message_preview || '',
    sent_at: l.sent_at,
    status: l.status,
  })), { header: true });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=sent-logs.csv');
  res.send(csv);
});

// API: Get config
app.get('/api/config', (req, res) => {
  const config = db.getConfig();
  res.json(config);
});

// API: Update config
app.post('/api/config', (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    db.setConfig(key, value);
  }
  res.json({ success: true });
});

// API: WhatsApp connect (REST fallback for Socket.IO wa:init)
app.post('/api/wa/connect', async (req, res) => {
  try {
    wa.initialize(req.user.id).catch(err => {
      logger.error(`[WA] Init error for user ${req.user.id}: ${err.message}`);
    });
    res.json({ success: true, message: 'WhatsApp initialization started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: WhatsApp disconnect
app.post('/api/wa/disconnect', async (req, res) => {
  try {
    await wa.disconnect(req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: WhatsApp clear session
app.post('/api/wa/clear-session', async (req, res) => {
  try {
    await wa.clearSession(req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: WhatsApp status
app.get('/api/wa/status', (req, res) => {
  res.json(wa.getStatus(req.user.id));
});

// API: WhatsApp initialize (REST fallback for when Socket.IO disconnects)
app.post('/api/wa/init', async (req, res) => {
  try {
    await wa.initialize(req.user.id);
    res.json({ success: true, message: 'WhatsApp initialization started' });
  } catch (err) {
    logger.error(`[WA] Init error for user ${req.user.id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// API: WhatsApp disconnect
app.post('/api/wa/disconnect', async (req, res) => {
  try {
    await wa.disconnect(req.user.id);
    res.json({ success: true, message: 'WhatsApp disconnected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: WhatsApp clear session
app.post('/api/wa/clear', async (req, res) => {
  try {
    await wa.clearSession(req.user.id);
    res.json({ success: true, message: 'WhatsApp session cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await db.initDB();
    logger.info('[DB] Database initialized');

    server.listen(PORT, () => {
      logger.info(`[SERVER] Running on http://localhost:${PORT}`);
      logger.info('[SERVER] WhatsApp auto-initialization disabled — click Connect in the UI');
    });
  } catch (err) {
    logger.error(`[SERVER] Failed to start: ${err.message}`);
    process.exit(1);
  }
}

startServer();
