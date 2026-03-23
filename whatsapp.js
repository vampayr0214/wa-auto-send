// ═══════════════════════════════════════════════════════════════
// CRITICAL: Monkey-patch BEFORE any whatsapp-web.js import
// ═══════════════════════════════════════════════════════════════
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'puppeteer') {
    return originalResolve.call(this, 'puppeteer-extra', parent, isMain, options);
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

// Load stealth plugin
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

// NOW load whatsapp-web.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const chalk = require('chalk');
const fs = require('fs');
const db = require('./database');
let logger;
try { logger = require('./logger'); } catch (e) { logger = { info: console.log, error: console.error, warn: console.warn, debug: console.debug }; }

class WhatsAppManager {
  constructor() {
    this.clients = new Map(); // userId → { client, connected, sessionActive, qrCode, sending, paused, abortSend }
    this.io = null;
    this.maxSessions = parseInt(process.env.MAX_SESSIONS) || 10;
  }

  setIO(io) {
    this.io = io;
  }

  emit(event, data, userId) {
    if (this.io) {
      if (userId) {
        // Emit to specific user's rooms
        this.io.to(`user_${userId}`).emit(event, data);
      } else {
        this.io.emit(event, data);
      }
    }
  }

  _getClientState(userId) {
    if (!this.clients.has(userId)) {
      this.clients.set(userId, {
        client: null,
        connected: false,
        sessionActive: false,
        qrCode: null,
        sending: false,
        paused: false,
        abortSend: false,
      });
    }
    return this.clients.get(userId);
  }

  async initialize(userId) {
    const state = this._getClientState(userId);
    if (state.client) {
      return;
    }

    // Check max sessions
    if (this.clients.size >= this.maxSessions) {
      throw new Error('Maximum concurrent sessions reached (' + this.maxSessions + ')');
    }

    const config = db.getConfig();
    // Auto-detect Chrome path based on OS
    let chromePath = config.chrome_path || process.env.CHROME_PATH;
    if (!chromePath) {
      if (process.platform === 'win32') {
        chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      } else if (process.platform === 'darwin') {
        chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      } else {
        // Linux — try common paths (Docker uses /usr/bin/chromium)
        chromePath = '/usr/bin/chromium' || '/usr/bin/google-chrome-stable' || '/usr/bin/google-chrome';
      }
    }
    const headless = config.headless !== false;

    const userAuthPath = path.join(__dirname, 'data', '.wwebjs_auth', String(userId));

    state.client = new Client({
      authStrategy: new LocalAuth({ dataPath: userAuthPath }),
      puppeteer: {
        headless: headless ? 'new' : false,
        executablePath: chromePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1280,720',
        ],
        defaultViewport: { width: 1280, height: 720 },
      },
      takeoverOnConflict: true,
      takeoverTimeoutMs: 10000,
    });

    state.client.on('qr', async (qr) => {
      logger.info(`[WA] QR Code received for user ${userId}`);
      try {
        const dataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        state.qrCode = dataUrl;
        state.connected = false;
        this.emit('wa:qr', dataUrl, userId);
        this.emit('wa:status', { connected: false, qr: dataUrl, sessionActive: false }, userId);
      } catch (err) {
        logger.error(`[WA] QR generation error for user ${userId}: ${err.message}`);
      }
    });

    state.client.on('ready', () => {
      logger.info(`[WA] Client ready for user ${userId} (stealth ON)`);
      state.connected = true;
      state.sessionActive = true;
      state.qrCode = null;
      this.emit('wa:status', { connected: true, qr: null, sessionActive: true }, userId);
    });

    state.client.on('authenticated', () => {
      logger.info(`[WA] User ${userId} authenticated`);
      state.sessionActive = true;
      this.emit('wa:status', { connected: state.connected, qr: state.qrCode, sessionActive: true }, userId);
    });

    state.client.on('auth_failure', (msg) => {
      logger.error(`[WA] Auth failure for user ${userId}: ${msg}`);
      state.connected = false;
      state.sessionActive = false;
      this.emit('wa:status', { connected: false, qr: null, sessionActive: false }, userId);
    });

    state.client.on('disconnected', (reason) => {
      logger.warn(`[WA] User ${userId} disconnected: ${reason}`);
      state.connected = false;
      state.sessionActive = false;
      state.qrCode = null;
      this.emit('wa:status', { connected: false, qr: null, sessionActive: false }, userId);
    });

    try {
      await state.client.initialize();
      logger.info(`[WA] Initialization started for user ${userId}`);
    } catch (err) {
      logger.error(`[WA] Initialization error for user ${userId}: ${err.message}`);
    }
  }

  async disconnect(userId) {
    const state = this._getClientState(userId);
    if (state.client) {
      try { await state.client.logout(); } catch (e) { /* ignore */ }
      try { await state.client.destroy(); } catch (e) { /* ignore */ }
      state.client = null;
      state.connected = false;
      state.sessionActive = false;
      state.qrCode = null;
      this.emit('wa:status', { connected: false, qr: null, sessionActive: false }, userId);
    }
  }

  async clearSession(userId) {
    await this.disconnect(userId);
    const authDir = path.join(__dirname, 'data', '.wwebjs_auth', String(userId));
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    const cacheDir = path.join(__dirname, 'data', '.wwebjs_cache', String(userId));
    if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  formatPhone(phone) {
    let cleaned = String(phone).replace(/[^0-9]/g, '');
    if (!cleaned.startsWith('91') && cleaned.length === 10) {
      cleaned = '91' + cleaned;
    }
    return cleaned + '@c.us';
  }

  renderTemplate(template, contact) {
    return template
      .replace(/\{name\}/g, contact.name || '')
      .replace(/\{phone\}/g, contact.phone || '')
      .replace(/\{custom1\}/g, contact.custom1 || '')
      .replace(/\{custom2\}/g, contact.custom2 || '');
  }

  addMessageVariation(message) {
    const chars = ['.', '!', '✨', '🙏', '😊', '👍', ''];
    return message.trim() + ' ' + chars[Math.floor(Math.random() * chars.length)];
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async sendWithProtection(userId, contacts, templateId, limit = null, onProgress = null) {
    const state = this._getClientState(userId);
    if (!state.connected || !state.client) throw new Error('WhatsApp not connected');

    const config = db.getConfig();
    const template = db.getTemplate(templateId);
    if (!template) throw new Error('Template not found');

    const minDelay = (config.min_delay_sec || 45) * 1000;
    const maxDelay = (config.max_delay_sec || 90) * 1000;
    const batchPauseAfter = config.batch_pause_after || 10;
    const batchPauseMin = (config.batch_pause_min_sec || 180) * 1000;
    const batchPauseMax = (config.batch_pause_max_sec || 300) * 1000;
    const typingSim = config.typing_simulation !== false;
    const dailyLimit = config.daily_limit || 100;

    const todaySent = db.getSentToday();
    let remainingToday = dailyLimit - todaySent;
    if (remainingToday <= 0) throw new Error('Daily limit reached');

    let targetContacts = contacts.slice(0, Math.min(contacts.length, remainingToday));
    if (limit && limit > 0) targetContacts = targetContacts.slice(0, Math.min(targetContacts.length, limit));

    const total = targetContacts.length;
    let sent = 0;
    let failed = 0;
    state.sending = true;
    state.paused = false;
    state.abortSend = false;
    const startTime = Date.now();

    for (let i = 0; i < targetContacts.length; i++) {
      if (state.abortSend) { logger.warn(`[SEND] Aborted for user ${userId}`); break; }

      while (state.paused && !state.abortSend) await this.sleep(1000);
      if (state.abortSend) break;

      const contact = targetContacts[i];
      const message = this.renderTemplate(template.content, contact);
      const variedMessage = this.addMessageVariation(message);

      if (onProgress) onProgress({ sent, failed, total, current_contact: contact.phone, status: 'sending' });

      try {
        // Typing simulation
        if (typingSim) {
          try {
            const chatId = this.formatPhone(contact.phone);
            const chat = await state.client.getChatById(chatId);
            if (chat) {
              await chat.sendStateTyping();
              await this.sleep(this.randomBetween(1500, 3500));
            }
          } catch (e) { /* non-critical */ }
        }

        // Thinking pause (35%)
        if (Math.random() < 0.35) await this.sleep(this.randomBetween(2000, 5000));

        // Send
        const chatId = this.formatPhone(contact.phone);
        const result = await state.client.sendMessage(chatId, variedMessage);

        if (result && result.id) {
          sent++;
          db.addLog(contact.phone, contact.name, variedMessage.substring(0, 100), templateId, 'success');
          this.emit('send:message', { phone: contact.phone, name: contact.name, status: 'success', preview: variedMessage.substring(0, 100) }, userId);
        } else {
          failed++;
          db.addLog(contact.phone, contact.name, variedMessage.substring(0, 100), templateId, 'failed');
          this.emit('send:message', { phone: contact.phone, name: contact.name, status: 'failed', preview: variedMessage.substring(0, 100) }, userId);
        }
      } catch (err) {
        failed++;
        db.addLog(contact.phone, contact.name, variedMessage.substring(0, 100), templateId, 'failed');
        this.emit('send:message', { phone: contact.phone, name: contact.name, status: 'failed', preview: err.message.substring(0, 100) }, userId);
        logger.error(`[SEND] Failed for ${contact.phone}: ${err.message}`);
      }

      // Progress update with ETA
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (sent + failed) / Math.max(elapsed, 1);
      const eta = total > (sent + failed) ? Math.round((total - sent - failed) / Math.max(rate, 0.001)) : 0;
      if (onProgress) onProgress({ sent, failed, total, current_contact: contact.phone, status: 'waiting', eta });

      // Batch pause or regular delay
      const messageIndex = sent + failed;
      if (messageIndex > 0 && messageIndex % batchPauseAfter === 0 && i < targetContacts.length - 1) {
        const pauseMs = this.randomBetween(batchPauseMin, batchPauseMax);
        logger.info(`[SEND] Batch pause: ${Math.round(pauseMs / 1000)}s after ${messageIndex} msgs (user ${userId})`);
        const pauseStart = Date.now();
        while (Date.now() - pauseStart < pauseMs && !state.abortSend && !state.paused) await this.sleep(1000);
        while (state.paused && !state.abortSend) await this.sleep(1000);
      } else {
        const delay = this.randomBetween(minDelay, maxDelay);
        logger.debug(`[SEND] Delay: ${Math.round(delay / 1000)}s (user ${userId})`);
        await this.sleep(delay);
      }
    }

    state.sending = false;
    state.paused = false;
    const result = { sent, failed, total };
    this.emit('send:complete', result, userId);
    return result;
  }

  pause(userId) {
    const state = this._getClientState(userId);
    state.paused = true;
  }

  resume(userId) {
    const state = this._getClientState(userId);
    state.paused = false;
  }

  abort(userId) {
    const state = this._getClientState(userId);
    state.abortSend = true;
    state.paused = false;
  }

  getStatus(userId) {
    if (userId) {
      const state = this._getClientState(userId);
      return {
        connected: state.connected,
        sessionActive: state.sessionActive,
        qr: state.qrCode,
        sending: state.sending,
        paused: state.paused,
      };
    }
    // Return all statuses
    const statuses = {};
    for (const [uid, state] of this.clients.entries()) {
      statuses[uid] = {
        connected: state.connected,
        sessionActive: state.sessionActive,
        sending: state.sending,
        paused: state.paused,
      };
    }
    return statuses;
  }

  getAllStatuses() {
    return this.getStatus();
  }
}

module.exports = new WhatsAppManager();
