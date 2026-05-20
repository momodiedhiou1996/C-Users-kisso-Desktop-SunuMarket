# SunuMarket Deployment Guide

## 1) Backend setup (server)

```powershell
cd server
npm install
```

Create your runtime env file:

```powershell
Copy-Item .env.example .env
```

Required minimum values in `.env`:

- `JWT_SECRET` (strong random string, 32+ chars)
- `FRONTEND_ORIGINS` (your real frontend domain)
- `DATABASE_PATH` (persistent path)

Recommended production values:

- `NODE_ENV=production`
- `TRUST_PROXY=true` (if behind Nginx/Caddy/Cloudflare)

## 2) Run with PM2

Install PM2 globally once:

```powershell
npm install -g pm2
```

Start API:

```powershell
cd server
npm run pm2:start
```

Useful PM2 commands:

```powershell
npm run pm2:logs
npm run pm2:restart
pm2 save
```

## 3) Reverse proxy (Nginx)

Ready config file:

- `deploy/nginx/sunumarket-api.conf`

Steps:

1. Replace `api.sunumarket.com` with your real API domain in `deploy/nginx/sunumarket-api.conf`.
2. Copy the file to your Nginx sites folder.
3. Enable the site and reload Nginx.

Example commands (Ubuntu):

```bash
sudo cp deploy/nginx/sunumarket-api.conf /etc/nginx/sites-available/sunumarket-api.conf
sudo ln -s /etc/nginx/sites-available/sunumarket-api.conf /etc/nginx/sites-enabled/sunumarket-api.conf
sudo nginx -t
sudo systemctl reload nginx
```

Then enable HTTPS (LetsEncrypt):

```bash
sudo certbot --nginx -d api.sunumarket.com
```

## 4) Reverse proxy (Caddy alternative)

Ready config file:

- `deploy/caddy/Caddyfile`

Steps:

1. Replace `api.sunumarket.com` with your real API domain in `deploy/caddy/Caddyfile`.
2. Copy it to `/etc/caddy/Caddyfile`.
3. Reload Caddy.

Example commands (Ubuntu):

```bash
sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy manages HTTPS automatically.

## 5) SQLite backup

Manual backup:

```powershell
cd server
npm run backup:db
```

Backups are stored by default in `server/backups`.

Optional env variables:

- `DB_BACKUP_DIR=./backups`
- `DB_BACKUP_RETENTION_DAYS=14`

## 6) Scheduled backup (Windows Task Scheduler)

Run once daily command:

```powershell
cd C:\Users\kisso\Desktop\SunuMarket\server; npm run backup:db
```

## 7) Smoke tests after deploy

- `GET /api/health` returns `{ ok: true }`
- Register new user
- Login returns token
- Create one product as seller

## 8) Security checklist before go-live

- Replace all test API keys with production keys
- Rotate JWT secret and third-party tokens
- Confirm `FRONTEND_ORIGINS` only contains trusted domains
- Keep `.env` out of git (already ignored)

## 9) Deploy via GitHub + Render

This repo includes a Render Blueprint file:

- `render.yaml`

Steps:

1. Push your project to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Connect your GitHub repository.
4. Render detects `render.yaml` and creates:
	- `sunumarket-api` (Node web service)
	- `sunumarket-web` (static site)
5. In the API service environment variables, set `FRONTEND_ORIGINS` to your static site URL (for example `https://sunumarket-web.onrender.com`), then redeploy the API.

Important:

- The backend uses a persistent disk mounted at `/var/data`.
- SQLite file path is `/var/data/sunumarket.db`.
- Health check endpoint is `/api/health`.

Frontend API URL:

- In local dev: frontend uses `http://localhost:4001/api`.
- In production (if not explicitly configured): frontend uses `https://sunumarket-api.onrender.com/api`.
- To override, define `window.SUNUMARKET_API_BASE` before loading `app.js` in `index.html`.
