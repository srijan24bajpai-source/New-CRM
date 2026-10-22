# Deploying PropCall CRM

PropCall is a Node.js app with a PostgreSQL database. The same code runs on **Vercel** (serverless + Neon Postgres) or on **any VPS** (docker compose).

## Deploy on Vercel (recommended for easy updates)

### One-time setup (about 10 minutes)

1. **Put the code on GitHub.** In this folder:
   ```
   git init
   git add .
   git commit -m "PropCall CRM"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
   Make the repository **private**. `.gitignore` already keeps data and secrets out.
2. **Import it in Vercel:** vercel.com → Add New → Project → pick the repo. Leave the framework as *Other* and the build settings as they are (`vercel.json` configures everything). Don't deploy yet if it offers a choice.
3. **Add the database:** in the project → Storage → Create Database → **Neon (Postgres)** → connect it to the project. This adds `DATABASE_URL` automatically.
4. **Add environment variables** (Settings → Environment Variables, all environments):
   | Name | Value |
   |---|---|
   | `ADMIN_EMAIL` | your email, used for the first admin account |
   | `ADMIN_PASSWORD` | a strong password (8+ characters with letters and numbers) |
   | `CRON_SECRET` | any long random string (protects the nightly cleanup job) |
5. **Deploy.** The build creates the tables and the admin account automatically. Open the project URL and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
6. Sign in as admin → **Integrations**: set calling to *Twilio* when you have an account (or keep *Demo*), and add the Meta page token if you use Lead Ads. The public URL for webhooks is your Vercel domain.
7. Optional: Vercel → Settings → Domains to use your own domain (HTTPS is automatic).

### Making changes later

Edit the code, then `git push`. Vercel builds and deploys it automatically (every branch also gets its own preview URL to test before merging). Database changes are safe too: add a new entry to the end of `MIGRATIONS` in `src/db.js` and it is applied once during the build, keeping existing data.

Handy commands: `npm start` (run locally with a built-in database, no setup), `npm test` (72 end-to-end checks), `node scripts/perf.js` (100,000-lead load check).

### Things to know on Vercel

- Vercel's **Hobby** plan is for non-commercial use; a business CRM belongs on **Pro**.
- Requests are limited to ~4.5 MB; the importer already splits big Excel files into small requests automatically.
- The nightly job (`/api/cron`) removes expired sessions and old audit rows. Backups come from the database provider (Neon keeps point-in-time history; check the retention on your plan).

## Deploy on a VPS instead

1. Point a DNS record (e.g. `crm.yourcompany.com`) at the server and install Docker.
2. `cp .env.example .env`, fill in `DOMAIN`, `DB_PASSWORD`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
3. `docker compose up -d --build`. Caddy obtains the HTTPS certificate automatically; only Caddy is exposed.
4. Back up the `pg-data` volume (for example a nightly `pg_dump`) to storage off the server.

## Scale

Tested with 100,000 leads: importing takes about 6 seconds even on the slower embedded test database, and lists, search, dashboard, the employee queue and whole-filter bulk actions all answer in well under a second. Indexes cover every filter. The database guarantees an employee holds only one lead at a time even under simultaneous requests, so it is safe to run many servers or serverless instances. Several lakh leads work the same way; Neon's free tier (0.5 GB) holds well over a lakh leads.

## Hardening checklist

- Admin → Security: set the office IP list and working hours for employees; keep "show numbers to employees" off.
- Set the Meta **app secret** so Meta webhooks are signature-checked; rotate the webhook key if it leaks.
- Rotate `ADMIN_PASSWORD` after first sign-in (Change password), and use unique strong passwords for every user.
- Restrict who can open the Vercel project and the Neon database; they hold all lead data.
- Review the audit log regularly (Admin → Security & audit).
