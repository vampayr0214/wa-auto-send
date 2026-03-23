# WA Auto Send — Deployment Guide

## Deploy to Railway (Recommended — Free)

### Step 1: Push to GitHub
```bash
cd "D:\projects\wa-auto send"
git init
git add .
git commit -m "Initial commit - WA Auto Send SaaS"
gh repo create wa-auto-send --public --push --source .
```

### Step 2: Deploy on Railway
1. Go to https://railway.app → Sign in with GitHub
2. Click "New Project" → "Deploy from GitHub Repo"
3. Select `wa-auto-send` repo
4. Railway auto-detects Dockerfile and deploys

### Step 3: Set Environment Variables
In Railway dashboard → Variables tab, add:
```
NODE_ENV=production
JWT_SECRET=<generate-random-64-char-string>
CHROME_PATH=/usr/bin/chromium
MAX_SESSIONS=10
LOG_LEVEL=info
PORT=3000
```

Generate JWT_SECRET:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 4: Add Volume (Persistent Storage)
1. In Railway → Settings → Volume
2. Mount path: `/app/data`
3. This persists your SQLite database and WhatsApp sessions

### Step 5: Get Your URL
Railway gives you a free URL like: `https://wa-auto-send.up.railway.app`

### Step 6: Custom Domain (Optional)
1. Buy domain from Namecheap/Cloudflare (~$10/year)
2. In Railway → Settings → Domains → Custom Domain
3. Add your domain and follow DNS instructions

---

## Deploy with Docker (Any VPS)

```bash
# On any Linux VPS (Ubuntu/Debian)
git clone https://github.com/YOUR_USERNAME/wa-auto-send.git
cd wa-auto-send

# Set environment
cp .env.production .env
# Edit .env — change JWT_SECRET!

# Build and run
docker-compose up -d

# Check logs
docker-compose logs -f

# Your app is at http://YOUR_VPS_IP:3000
```

---

## Deploy with PM2 (VPS without Docker)

```bash
# On VPS
git clone https://github.com/YOUR_USERNAME/wa-auto-send.git
cd wa-auto-send
npm install
cp .env.production .env
# Edit .env — change JWT_SECRET and CHROME_PATH!

# Install Chrome
sudo apt install chromium-browser

# Start with PM2
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

---

## Post-Deployment Checklist

- [ ] Register first user (becomes admin)
- [ ] Set a strong JWT_SECRET
- [ ] Connect WhatsApp (scan QR)
- [ ] Upload contacts CSV
- [ ] Create message template
- [ ] Test send (limit 5 first)
- [ ] Set up SSL if using custom domain

## Free Domain Options

| Provider | Domain | Notes |
|----------|--------|-------|
| Railway | `*.up.railway.app` | Auto-assigned, free |
| Render | `*.onrender.com` | Auto-assigned, free |
| Fly.io | `*.fly.dev` | Auto-assigned, free |
| Freenom | `.tk/.ml/.ga` | Unreliable, avoid |
| Cloudflare | Buy `.com` for $10/yr | Best value paid option |
