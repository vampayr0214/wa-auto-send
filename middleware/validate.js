/**
 * Input validation and sanitization middleware
 */

// HTML entity map for escaping
const entityMap = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
};

function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[&<>"'/]/g, char => entityMap[char]);
}

function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return escapeHtml(str.trim());
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      obj[key] = sanitizeString(obj[key]);
    }
  }
  return obj;
}

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidPhone(phone) {
  if (typeof phone !== 'string') return false;
  const cleaned = phone.replace(/[^0-9]/g, '');
  return cleaned.length >= 10 && cleaned.length <= 15;
}

function validateCSV(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return { valid: false, error: 'No records found in CSV' };
  }
  const firstRow = records[0];
  const keys = Object.keys(firstRow).map(k => k.toLowerCase());
  if (!keys.includes('phone') && !keys.includes('number')) {
    return { valid: false, error: 'CSV must have a "phone" or "number" column' };
  }
  return { valid: true };
}

// Reject payloads > 1MB
function limitPayloadSize(req, res, next) {
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > 1024 * 1024) {
    return res.status(413).json({ error: 'Payload too large (max 1MB)', code: 'PAYLOAD_TOO_LARGE' });
  }
  next();
}

// Sanitize all string inputs middleware
function sanitizeInputs(req, res, next) {
  if (req.body) sanitizeObject(req.body);
  if (req.query) sanitizeObject(req.query);
  if (req.params) sanitizeObject(req.params);
  next();
}

module.exports = {
  escapeHtml,
  sanitizeString,
  sanitizeObject,
  isValidEmail,
  isValidPhone,
  validateCSV,
  limitPayloadSize,
  sanitizeInputs,
};
