// Vercel serverless entry: every /api/*, /hooks/* and /healthz request is rewritten here (see vercel.json).
const { handle } = require('../src/app');

module.exports = (req, res) => handle(req, res);
