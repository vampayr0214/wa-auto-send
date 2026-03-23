const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const defaultConfig = require('./config.json');
let logger;
try { logger = require('./logger'); } catch (e) { logger = { info: console.log, error: console.error, warn: console.warn, debug: console.debug }; }

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'wa-auto.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db = null;

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Initialize tables
  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      name TEXT,
      custom1 TEXT,
      custom2 TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      name TEXT,
      message_preview TEXT,
      template_id INTEGER,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'pending',
      FOREIGN KEY (template_id) REFERENCES templates(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Auth tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'user',
      whatsapp_session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  saveDB();

  // Seed default config if empty
  const configCount = queryOne('SELECT COUNT(*) as count FROM config');
  if (configCount.count === 0) {
    for (const [key, value] of Object.entries(defaultConfig)) {
      db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, String(value)]);
    }
    saveDB();
  }

  // Seed default template if empty
  const templateCount = queryOne('SELECT COUNT(*) as count FROM templates');
  if (templateCount.count === 0) {
    db.run('INSERT INTO templates (name, content, is_default) VALUES (?, ?, ?)', [
      'Default',
      'Hi {name}, this is a message for you. Your phone: {phone}',
      1,
    ]);
    saveDB();
  }

  return db;
}

function saveDB() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

// Helper: run query and return all rows as objects
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// Helper: run query and return first row as object
function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

// Helper: run statement (INSERT/UPDATE/DELETE) — returns lastInsertRowid for INSERTs
function run(sql, params = []) {
  db.run(sql, params);
  // Capture last_insert_rowid BEFORE saveDB() — db.export() resets it!
  let lastId = 0;
  try {
    const stmt = db.prepare('SELECT last_insert_rowid() as id');
    if (stmt.step()) {
      lastId = stmt.getAsObject().id;
    }
    stmt.free();
  } catch {
    // ignore
  }
  saveDB();
  return lastId;
}

// --- Config helpers ---
function getConfig() {
  const rows = queryAll('SELECT * FROM config');
  const config = {};
  for (const row of rows) {
    let val = row.value;
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (!isNaN(val) && val !== '') val = Number(val);
    config[row.key] = val;
  }
  return config;
}

function setConfig(key, value) {
  run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, String(value)]);
}

// --- Contact helpers ---
function getContacts({ search, offset = 0, limit = 50 } = {}) {
  let query = `SELECT c.*, CASE WHEN sl.phone IS NOT NULL THEN 1 ELSE 0 END as sent 
    FROM contacts c 
    LEFT JOIN (SELECT DISTINCT phone FROM sent_log WHERE status = 'success') sl ON c.phone = sl.phone`;
  const params = [];

  if (search) {
    query += ' WHERE c.phone LIKE ? OR c.name LIKE ?';
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return queryAll(query, params);
}

function getContactCount(search) {
  let query = 'SELECT COUNT(*) as count FROM contacts';
  const params = [];
  if (search) {
    query += ' WHERE phone LIKE ? OR name LIKE ?';
    params.push(`%${search}%`, `%${search}%`);
  }
  return queryOne(query, params).count;
}

function addContact(phone, name = '', custom1 = '', custom2 = '') {
  try {
    const id = run('INSERT OR IGNORE INTO contacts (phone, name, custom1, custom2) VALUES (?, ?, ?, ?)', [phone, name, custom1, custom2]);
    return { changes: id > 0 ? 1 : 0, lastInsertRowid: id };
  } catch (e) {
    return { changes: 0, lastInsertRowid: 0 };
  }
}

function deleteContact(id) {
  run('DELETE FROM contacts WHERE id = ?', [id]);
  return { changes: 1 };
}

function getUnsentContacts(limit) {
  return queryAll(`
    SELECT c.* FROM contacts c
    LEFT JOIN (SELECT DISTINCT phone FROM sent_log WHERE status = 'success') sl ON c.phone = sl.phone
    WHERE sl.phone IS NULL
    ORDER BY c.id ASC
    LIMIT ?
  `, [limit]);
}

// --- Template helpers ---
function getTemplates() {
  return queryAll('SELECT * FROM templates ORDER BY created_at DESC');
}

function getTemplate(id) {
  return queryOne('SELECT * FROM templates WHERE id = ?', [id]);
}

function addTemplate(name, content, isDefault = 0) {
  if (isDefault) {
    run('UPDATE templates SET is_default = 0 WHERE is_default = 1');
  }
  const id = run('INSERT INTO templates (name, content, is_default) VALUES (?, ?, ?)', [name, content, isDefault]);
  return { lastInsertRowid: id };
}

function updateTemplate(id, name, content, isDefault = 0) {
  if (isDefault) {
    run('UPDATE templates SET is_default = 0 WHERE is_default = 1');
  }
  run('UPDATE templates SET name = ?, content = ?, is_default = ? WHERE id = ?', [name, content, isDefault, id]);
  return { changes: 1 };
}

function deleteTemplate(id) {
  run('DELETE FROM templates WHERE id = ?', [id]);
  return { changes: 1 };
}

// --- Sent log helpers ---
function addLog(phone, name, messagePreview, templateId, status = 'pending') {
  run('INSERT INTO sent_log (phone, name, message_preview, template_id, status) VALUES (?, ?, ?, ?, ?)', [phone, name, messagePreview, templateId, status]);
}

function updateLogStatus(id, status) {
  run('UPDATE sent_log SET status = ? WHERE id = ?', [status, id]);
}

function getSentToday() {
  const row = queryOne("SELECT COUNT(*) as count FROM sent_log WHERE DATE(sent_at) = DATE('now', 'localtime') AND status = 'success'");
  return row ? row.count : 0;
}

function getSentTotal() {
  const row = queryOne('SELECT COUNT(*) as count FROM sent_log WHERE status = "success"');
  return row ? row.count : 0;
}

function getTotalContacts() {
  const row = queryOne('SELECT COUNT(*) as count FROM contacts');
  return row ? row.count : 0;
}

function getSuccessRate() {
  const total = queryOne('SELECT COUNT(*) as count FROM sent_log');
  if (!total || total.count === 0) return 0;
  const success = queryOne('SELECT COUNT(*) as count FROM sent_log WHERE status = "success"');
  return Math.round((success.count / total.count) * 100);
}

function getLogs({ status, dateFrom, dateTo, offset = 0, limit = 50 } = {}) {
  let query = 'SELECT * FROM sent_log WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }
  if (dateFrom) {
    query += ' AND DATE(sent_at) >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    query += ' AND DATE(sent_at) <= ?';
    params.push(dateTo);
  }

  query += ' ORDER BY sent_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return queryAll(query, params);
}

function getLogsCount({ status, dateFrom, dateTo } = {}) {
  let query = 'SELECT COUNT(*) as count FROM sent_log WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }
  if (dateFrom) {
    query += ' AND DATE(sent_at) >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    query += ' AND DATE(sent_at) <= ?';
    params.push(dateTo);
  }

  return queryOne(query, params).count;
}

function getAllLogsForExport({ status, dateFrom, dateTo } = {}) {
  let query = 'SELECT * FROM sent_log WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }
  if (dateFrom) {
    query += ' AND DATE(sent_at) >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    query += ' AND DATE(sent_at) <= ?';
    params.push(dateTo);
  }

  query += ' ORDER BY sent_at DESC';
  return queryAll(query, params);
}

// --- User helpers ---
function getUserByEmail(email) {
  return queryOne('SELECT * FROM users WHERE email = ?', [email]);
}

function getUserById(id) {
  return queryOne('SELECT * FROM users WHERE id = ?', [id]);
}

function getUserCount() {
  return queryOne('SELECT COUNT(*) as count FROM users').count;
}

function createUser(email, passwordHash, name, role = 'user') {
  const id = run('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)', [email, passwordHash, name, role]);
  return { id };
}

function updateLastLogin(userId) {
  run("UPDATE users SET last_login = DATETIME('now', 'localtime') WHERE id = ?", [userId]);
}

function updateUserSession(userId, sessionId) {
  run('UPDATE users SET whatsapp_session_id = ? WHERE id = ?', [sessionId, userId]);
}

// --- Session helpers ---
function createSession(userId, token, expiresAt) {
  run('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)', [userId, token, expiresAt]);
}

function getSession(userId, token) {
  return queryOne('SELECT * FROM sessions WHERE user_id = ? AND token = ? AND expires_at > DATETIME("now", "localtime")', [userId, token]);
}

function deleteSession(token) {
  run('DELETE FROM sessions WHERE token = ?', [token]);
}

function deleteAllUserSessions(userId) {
  run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

module.exports = {
  initDB,
  saveDB,
  getConfig,
  setConfig,
  getContacts,
  getContactCount,
  addContact,
  deleteContact,
  getUnsentContacts,
  getTemplates,
  getTemplate,
  addTemplate,
  updateTemplate,
  deleteTemplate,
  addLog,
  updateLogStatus,
  getSentToday,
  getSentTotal,
  getTotalContacts,
  getSuccessRate,
  getLogs,
  getLogsCount,
  getAllLogsForExport,
  // User helpers
  getUserByEmail,
  getUserById,
  getUserCount,
  createUser,
  updateLastLogin,
  updateUserSession,
  // Session helpers
  createSession,
  getSession,
  deleteSession,
  deleteAllUserSessions,
};
