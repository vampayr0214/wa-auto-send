// Puppeteer wrapper with stealth plugin
// This file is loaded by whatsapp-web.js via require('puppeteer')
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

// Re-export with same API as puppeteer
module.exports = puppeteerExtra;
