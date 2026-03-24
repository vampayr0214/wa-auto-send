/**
 * WhatsApp Manager — Stealth + Navigation-Safe
 * 
 * Strategy:
 * 1. Inject puppeteer-extra into require.cache (stealth plugin)
 * 2. After client creation, monkey-patch pupPage.evaluate to retry on navigation errors
 */
const path = require('path');
const fs = require('fs');

// Step 1: Stealth injection via require.cache
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

let puppeteerRealPath;
try {
  const wwebPath = require.resolve('whatsapp-web.js');
  const wwebDir = path.dirname(wwebPath);
  puppeteerRealPath = require.resolve('puppeteer', { paths: [wwebDir] });
} catch {
  try { puppeteerRealPath = require.resolve('puppeteer'); }
  catch { puppeteerRealPath = path.join(__dirname, 'node_modules', 'puppeteer', 'lib', 'cjs', 'puppeteer', 'puppeteer.js'); }
}
require.cache[puppeteerRealPath] = { id: puppeteerRealPath, filename: puppeteerRealPath, loaded: true, exports: puppeteerExtra };

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
let logger;
try { logger = require('./logger'); } catch { logger = console; }

class WhatsAppManager {
  constructor() {
    this.clients = new Map();
    this.io = null;
    this.maxSessions = parseInt(process.env.MAX_SESSIONS) || 10;
  }

  setIO(io) { this.io = io; }

  emit(event, data, userId) {
    if (this.io) {
      if (userId) this.io.to(`user_${userId}`).emit(event, data);
      else this.io.emit(event, data);
    }
  }

  _getClientState(userId) {
    if (!this.clients.has(userId)) {
      this.clients.set(userId, {
        client: null, connected: false, sessionActive: false,
        qrCode: null, sending: false, paused: false, abortSend: false,
      });
    }
    return this.clients.get(userId);
  }

  _getChromePath() {
    let config;
    try { config = db.getConfig(); } catch { config = {}; }
    let chromePath = config.chrome_path || process.env.CHROME_PATH;
    if (!chromePath) {
      if (process.platform === 'win32') {
        chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      } else if (process.platform === 'darwin') {
        chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      } else {
        const paths = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
        for (const p of paths) { if (fs.existsSync(p)) { chromePath = p; break; } }
        if (!chromePath) chromePath = '/usr/bin/chromium';
      }
    }
    return chromePath;
  }

  _patchPageNavigation(page) {
    // Wrap evaluate to handle navigation errors
    const origEval = page.evaluate.bind(page);
    const patchedEval = async (fn, ...args) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          return await origEval(fn, ...args);
        } catch (err) {
          if (err.message && (
            err.message.includes('Execution context was destroyed') ||
            err.message.includes('Cannot find context') ||
            err.message.includes('Protocol error')
          )) {
            if (attempt < 7) {
              logger.info(`[WA] Navigation retry ${attempt + 1}/8 for evaluate`);
              await new Promise(r => setTimeout(r, 1500 + attempt * 500));
              continue;
            }
          }
          throw err;
        }
      }
    };
    page.evaluate = patchedEval;
  }

  async initialize(userId) {
    const state = this._getClientState(userId);
    if (state.client) return;
    if (this.clients.size > this.maxSessions) throw new Error('Max sessions reached');

    const chromePath = this._getChromePath();
    let headless = true;
    try { headless = db.getConfig().headless !== false; } catch {}

    const userAuthPath = path.join(__dirname, 'data', '.wwebjs_auth', String(userId));
    fs.mkdirSync(userAuthPath, { recursive: true });

    state.client = new Client({
      authStrategy: new LocalAuth({ dataPath: userAuthPath }),
      puppeteer: {
        headless: headless ? 'new' : false,
        executablePath: chromePath,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
          '--disable-gpu', '--disable-extensions',
          '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding', '--disable-blink-features=AutomationControlled',
          '--window-size=1280,720',
        ],
        defaultViewport: { width: 1280, height: 720 },
      },
      takeoverOnConflict: true,
      takeoverTimeoutMs: 10000,
    });

    // Patch pupPage.evaluate after browser launches but before inject runs
    state.client.on('qr', async (qr) => {
      logger.info(`[WA] QR Code received for user ${userId}`);
      // Patch the page when first QR arrives (page is available at this point)
      if (state.client.pupPage && !state.client.pupPage._navPatched) {
        this._patchPageNavigation(state.client.pupPage);
        state.client.pupPage._navPatched = true;
        logger.info(`[WA] Navigation safety patch applied for user ${userId}`);
      }
      try {
        const dataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        state.qrCode = dataUrl;
        state.connected = false;
        this.emit('wa:qr', dataUrl, userId);
        this.emit('wa:status', { connected: false, qr: dataUrl, sessionActive: false }, userId);
      } catch (err) { logger.error(`[WA] QR error: ${err.message}`); }
    });

    state.client.on('ready', () => {
      logger.info(`[WA] Client ready for user ${userId} (stealth ON)`);
      state.connected = true;
      state.sessionActive = true;
      state.qrCode = null;
      this.emit('wa:status', { connected: true, qr: null, sessionActive: true }, userId);
    });

    // Patch the page as soon as authenticated (before inject continues post-nav)
    state.client.on('authenticated', () => {
      logger.info(`[WA] Authenticated for user ${userId}`);
      // Re-patch after auth since page context may have changed
      if (state.client.pupPage) {
        this._patchPageNavigation(state.client.pupPage);
        logger.info(`[WA] Navigation patch re-applied after auth for user ${userId}`);
      }
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
      logger.warn(`[WA] Disconnected for user ${userId}: ${reason}`);
      state.connected = false;
      state.sessionActive = false;
      state.qrCode = null;
      this.emit('wa:status', { connected: false, qr: null, sessionActive: false }, userId);
    });

    try {
      await state.client.initialize();
      logger.info(`[WA] Initialization started for user ${userId}`);
    } catch (err) {
      logger.error(`[WA] Init error for user ${userId}: ${err.message}`);
      state.client = null;
      throw err;
    }
  }

  async disconnect(userId) {
    const state = this._getClientState(userId);
    if (state.client) {
      try { await state.client.logout(); } catch {}
      try { await state.client.destroy(); } catch {}
      state.client = null;
    }
    state.connected = false;
    state.sessionActive = false;
    state.qrCode = null;
    this.emit('wa:status', { connected: false, qr: null, sessionActive: false }, userId);
  }

  async clearSession(userId) {
    await this.disconnect(userId);
    const authDir = path.join(__dirname, 'data', '.wwebjs_auth', String(userId));
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
  }

  formatPhone(phone) {
    let cleaned = String(phone).replace(/[^0-9]/g, '');
    if (!cleaned.startsWith('91') && cleaned.length === 10) cleaned = '91' + cleaned;
    return cleaned + '@c.us';
  }

  renderTemplate(template, contact) {
    return template
      .replace(/\{name\}/g, contact.name || '').replace(/\{phone\}/g, contact.phone || '')
      .replace(/\{custom1\}/g, contact.custom1 || '').replace(/\{custom2\}/g, contact.custom2 || '');
  }

  addMessageVariation(message) {
    return message.trim() + ' ' + ['.', '!', ''][Math.floor(Math.random() * 3)];
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  randomBetween(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  async sendWithProtection(userId, contacts, templateId, limit = null, onProgress = null) {
    const state = this._getClientState(userId);
    if (!state.connected || !state.client) throw new Error('WhatsApp not connected');

    let config; try { config = db.getConfig(); } catch { config = {}; }
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

    let tc = contacts.slice(0, Math.min(contacts.length, remainingToday));
    if (limit && limit > 0) tc = tc.slice(0, Math.min(tc.length, limit));

    const total = tc.length;
    let sent = 0, failed = 0;
    state.sending = true; state.paused = false; state.abortSend = false;
    const startTime = Date.now();

    for (let i = 0; i < tc.length; i++) {
      if (state.abortSend) break;
      while (state.paused && !state.abortSend) await this.sleep(1000);
      if (state.abortSend) break;

      const contact = tc[i];
      const msg = this.addMessageVariation(this.renderTemplate(template.content, contact));
      if (onProgress) onProgress({ sent, failed, total, current_contact: contact.phone, status: 'sending' });

      try {
        if (typingSim) {
          try {
            const chat = await state.client.getChatById(this.formatPhone(contact.phone));
            if (chat) { await chat.sendStateTyping(); await this.sleep(this.randomBetween(1500, 3500)); }
          } catch {}
        }
        if (Math.random() < 0.35) await this.sleep(this.randomBetween(2000, 5000));

        const result = await state.client.sendMessage(this.formatPhone(contact.phone), msg);
        if (result?.id) {
          sent++;
          db.addLog(contact.phone, contact.name, msg.substring(0, 100), templateId, 'success');
          this.emit('send:message', { phone: contact.phone, name: contact.name, status: 'success', preview: msg.substring(0, 100) }, userId);
        } else { failed++; db.addLog(contact.phone, contact.name, msg.substring(0, 100), templateId, 'failed'); }
      } catch (err) {
        failed++;
        db.addLog(contact.phone, contact.name, msg.substring(0, 100), templateId, 'failed');
        logger.error(`[SEND] Failed ${contact.phone}: ${err.message}`);
      }

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (sent + failed) / Math.max(elapsed, 1);
      const eta = total > (sent + failed) ? Math.round((total - sent - failed) / Math.max(rate, 0.001)) : 0;
      if (onProgress) onProgress({ sent, failed, total, current_contact: contact.phone, status: 'waiting', eta });

      const mi = sent + failed;
      if (mi > 0 && mi % batchPauseAfter === 0 && i < tc.length - 1) {
        const pm = this.randomBetween(batchPauseMin, batchPauseMax);
        const ps = Date.now();
        while (Date.now() - ps < pm && !state.abortSend && !state.paused) await this.sleep(1000);
        while (state.paused && !state.abortSend) await this.sleep(1000);
      } else {
        await this.sleep(this.randomBetween(minDelay, maxDelay));
      }
    }

    state.sending = false; state.paused = false;
    const result = { sent, failed, total };
    this.emit('send:complete', result, userId);
    return result;
  }

  pause(userId) { this._getClientState(userId).paused = true; }
  resume(userId) { this._getClientState(userId).paused = false; }
  abort(userId) { const s = this._getClientState(userId); s.abortSend = true; s.paused = false; }

  getStatus(userId) {
    const s = this._getClientState(userId);
    return { connected: s.connected, sessionActive: s.sessionActive, qr: s.qrCode, sending: s.sending, paused: s.paused };
  }
}

module.exports = new WhatsAppManager();
