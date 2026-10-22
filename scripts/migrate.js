// Creates / upgrades the database schema and the first admin. Runs automatically during a Vercel build ("vercel-build").
if (process.env.VERCEL && !(process.env.DATABASE_URL || process.env.POSTGRES_URL)) {
  console.warn('DATABASE_URL is not set yet, skipping database setup. Add a Postgres database in Vercel, then redeploy.');
  process.exit(0);
}
require('../src/setup').ensureReady()
  .then(() => { console.log('Database is ready.'); process.exit(0); })
  .catch((e) => { console.error(e.message); process.exit(1); });
