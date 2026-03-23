# WA Auto Send
WhatsApp Bulk Messaging SaaS with ban protection.

## Features
- 🚀 Bulk WhatsApp messaging via web dashboard
- 🛡️ Anti-ban: Stealth plugin, typing sim, randomized delays
- 👥 Multi-user auth (JWT + bcrypt)
- 📊 Real-time progress via Socket.IO
- 📁 CSV contact upload
- 📝 Template system with placeholders
- 🔒 Rate limiting, input validation, error handling

## Quick Start
```bash
npm install
cp .env.example .env   # Edit JWT_SECRET!
npm start
# Open http://localhost:3000
```

## Deploy
See [DEPLOY.md](DEPLOY.md) for Railway, Docker, and PM2 deployment.

## Tech Stack
- Node.js + Express + EJS
- SQLite (sql.js) — no native deps
- whatsapp-web.js + puppeteer-extra stealth
- Socket.IO for real-time updates
- Tailwind CSS (dark theme)

## ⚠️ Disclaimer
Uses whatsapp-web.js (unofficial API). Account bans are possible. Use responsibly.
