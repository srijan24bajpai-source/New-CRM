// Local / VPS entry point. (On Vercel the same handler runs from api/index.js.)
const http = require('node:http');
const { handle } = require('./src/app');
const { ensureReady, IS_PROD } = require('./src/setup');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // set HOST=0.0.0.0 in containers

const server = http.createServer((req, res) => handle(req, res, { static: true }));
server.requestTimeout = 120000; server.headersTimeout = 20000; // drop slow or stalled clients

ensureReady().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`PropCall CRM listening on ${HOST}:${PORT} (${IS_PROD ? 'production' : 'development'})`);
    if (!IS_PROD) console.log('  Demo logins: admin@crm.local / Admin@123   manager@crm.local / Manager@123   emp1@crm.local / Employee@123');
  });
}).catch((e) => { console.error(e.message); process.exit(1); });

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e?.message || e));
const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
module.exports = server;
