# PropCall CRM

Real-estate calling CRM on Node.js + PostgreSQL. Deploys to Vercel or any VPS (see `DEPLOY.md`).

```
npm install
npm start             # http://localhost:3000, uses a built-in Postgres, no setup
npm test              # 72 end-to-end checks
```

Demo logins (local development only; production creates just your own admin from `ADMIN_EMAIL`):

| Role | Email | Password |
|---|---|---|
| Admin | admin@crm.local | Admin@123 |
| Management | manager@crm.local | Manager@123 |
| Employee | emp1@crm.local (also emp2, emp3) | Employee@123 |

## Who can do what

| | Employee | Management | Admin |
|---|---|---|---|
| Work one assigned lead, call via CRM, give feedback | yes | no | no |
| See phone / email of leads | never | masked (reveal is logged, 25/hour) | full |
| View all leads, buckets, call log, recordings, reports | no | yes | yes |
| Import Excel / Google Sheet, assign, redistribute, pause buckets | no | yes | yes |
| Edit a lead's phone number, delete leads | no | no | yes |
| Users, integrations, security rules, audit log | no | no | yes |

## How leads flow

1. Leads arrive from Excel/CSV, Google Sheets, Meta Lead Ads, Google Ads forms, portals or website forms (webhooks). Each import becomes a **bucket**.
2. Every new lead goes to the next employee in a **round-robin** (employees marked "gets new leads"). Imports can also target selected employees, or stay unassigned.
3. An employee is served one lead at a time. The next lead appears only after feedback is saved.
4. Feedback captures outcome, **Hot / Warm / Cold**, remarks, requirement details, and a follow-up time. Duration and call start/end come from the phone service.

## Environment variables (optional)

`DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CRON_SECRET`, `PORT`, `RETRY_MINUTES` (default 120), `MAX_ATTEMPTS` (4), `IDLE_MINUTES` (720), `SESSION_DAYS` (30), `TIMEZONE` (Asia/Kolkata, used for employee working hours), `TRUST_PROXY=1` (VPS behind a proxy), `PUBLIC_URL`, `TWILIO_*`.

## Security notes

- Serve over HTTPS in production (the session cookie becomes `Secure` automatically behind HTTPS).
- Lead data lives in your Postgres database; use a provider with encryption at rest (Neon does) and restrict who can access it.
- Passwords never expire and nobody is forced to change them; people can change their own whenever they want, and admins can reset or permanently delete accounts.
- No export feature exists by design. Screenshots and what an employee hears on a call cannot be prevented by software.
