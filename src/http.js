// Small HTTP helpers shared by the API and webhooks.
const { HttpError } = require('./security');

// Reads the request body. Some serverless runtimes read the body before our code runs, so fall back to req.body.
async function readRaw(req, limit = 1e6) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  let raw = Buffer.concat(chunks).toString('utf8');
  if (!raw && req.body != null) {
    const b = req.body;
    raw = Buffer.isBuffer(b) ? b.toString('utf8') : typeof b === 'string' ? b
      : String(req.headers['content-type'] || '').includes('urlencoded') ? new URLSearchParams(b).toString() : JSON.stringify(b);
  }
  return raw;
}
const parseJson = (raw) => {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
};
const send = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};
const sendText = (res, status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(text); };

module.exports = { readRaw, parseJson, send, sendText };
