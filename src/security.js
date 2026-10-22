// Passwords, sessions, access rules, throttling, settings and the audit log.
const crypto = require('node:crypto');
const { q, one, exec } = require('./db');

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const now = () => new Date().toISOString();
const randHex = (n) => crypto.randomBytes(n).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const clip = (v, n = 500) => (v == null ? null : String(v).trim().slice(0, n) || null);

// Sessions stay signed in for a working day by default; nothing forces anyone to change their password.
const IDLE_MS = Number(process.env.IDLE_MINUTES || 720) * 60000;
const ABS_MS = Number(process.env.SESSION_DAYS || 30) * 86400000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || !!process.env.VERCEL;

// ---------- settings (cached briefly so a request does not hit the database for every flag) ----------
let cache = null, cacheAt = 0;
async function allSettings() {
  if (!cache || Date.now() - cacheAt > 5000) {
    cache = Object.fromEntries((await q('SELECT key, value FROM settings')).map((r) => [r.key, r.value]));
    cacheAt = Date.now();
  }
  return cache;
}
const getSetting = async (k) => (await allSettings())[k] ?? '';
async function setSetting(k, v) {
  await exec('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
  cache = null;
}
const invalidateSettings = () => { cache = null; };

// ---------- passwords ----------
const hashPassword = (pw) => {
  const salt = randHex(16);
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
};
const verifyPassword = (pw, stored) => {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(hash, 'hex'));
};
const checkPassword = (pw) => {
  if (String(pw || '').length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpError(400, 'Password must be 8+ characters with letters and numbers');
};
const ROLES = ['employee', 'management', 'admin'];
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone || null });
const need = (user, min) => { if (ROLES.indexOf(user.role) < ROLES.indexOf(min)) throw new HttpError(403, 'You do not have access to this'); };

// ---------- request context ----------
const clientIp = (req) => {
  if (TRUST_PROXY) {
    const v = req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'];
    if (v) return String(v).split(',')[0].trim().replace(/^::ffff:/, '');
  }
  return (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
};
const isHttps = (req) => !!req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
const parseCookies = (h) => Object.fromEntries((h || '').split(';').map((c) => c.trim().split(/=(.*)/s)).filter((p) => p[0]).map((p) => [p[0], p[1] ?? '']));
const setSessionCookie = (req, res, token, maxAgeSec) => {
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`);
};

async function audit(user, action, target, detail, req) {
  await exec('INSERT INTO audit (ts,user_id,user_name,action,target,detail,ip) VALUES (?,?,?,?,?,?,?)',
    [now(), user?.id ?? null, user?.name ?? null, action, target == null ? null : String(target), detail == null ? null : String(detail).slice(0, 500), req ? clientIp(req) : null]);
}

// Employees can be limited to office IPs and working hours (Security settings).
async function checkEmployeeAccess(req) {
  const s = await allSettings();
  const ips = (s.employee_ips || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (ips.length && !ips.includes(clientIp(req))) throw new HttpError(403, 'Access is limited to the office network');
  const [a, b] = [s.employee_hours_start || '', s.employee_hours_end || ''];
  if (/^\d\d:\d\d$/.test(a) && /^\d\d:\d\d$/.test(b)) {
    const tz = s.timezone || process.env.TIMEZONE || 'Asia/Kolkata';
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':');
    const cur = Number(parts[0]) * 60 + Number(parts[1]);
    const m = (x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3));
    const inside = m(a) <= m(b) ? cur >= m(a) && cur < m(b) : cur >= m(a) || cur < m(b);
    if (!inside) throw new HttpError(403, `Access is allowed between ${a} and ${b}`);
  }
}

// ---------- sessions ----------
async function createSession(req, res, user) {
  if (user.role === 'employee') await exec('DELETE FROM sessions WHERE user_id = ?', [user.id]); // one device per employee: no credential sharing
  const token = randHex(32), t = Date.now();
  await exec('INSERT INTO sessions (token_hash,user_id,created_at,last_seen,ip) VALUES (?,?,?,?,?)', [sha256(token), user.id, t, t, clientIp(req)]);
  setSessionCookie(req, res, token, ABS_MS / 1000);
}
async function authUser(req) {
  const tok = parseCookies(req.headers.cookie).sid;
  if (!tok) return null;
  const h = sha256(tok);
  const row = await one(`SELECT u.*, s.created_at AS s_created, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND u.active = 1`, [h]);
  if (!row) return null;
  const t = Date.now();
  if (t - row.last_seen > IDLE_MS || t - row.s_created > ABS_MS) { await exec('DELETE FROM sessions WHERE token_hash = ?', [h]); return null; }
  if (row.role === 'employee') await checkEmployeeAccess(req);
  if (t - row.last_seen > 30000) await exec('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', [t, h]);
  return publicUser(row);
}
const sessionHash = (req) => sha256(parseCookies(req.headers.cookie).sid || '');

// ---------- login throttling (stored in the database so it holds across serverless instances) ----------
async function throttled(key) {
  const r = await one('SELECT until FROM login_attempts WHERE key = ?', [key]);
  return !!r && r.until > Date.now();
}
async function noteFailure(key, limit) {
  const t = Date.now();
  const r = await one(`INSERT INTO login_attempts (key,n,until,updated) VALUES (?,1,0,?)
    ON CONFLICT (key) DO UPDATE SET n = CASE WHEN login_attempts.updated < ? THEN 1 ELSE login_attempts.n + 1 END, updated = ? RETURNING n`,
  [key, t, t - 15 * 60000, t]);
  if (r.n >= limit) await exec('UPDATE login_attempts SET until = ?, n = 0 WHERE key = ?', [t + 15 * 60000, key]);
}
const clearFailures = (key) => exec('DELETE FROM login_attempts WHERE key = ?', [key]);

module.exports = {
  HttpError, now, randHex, sha256, safeEqual, clip, IDLE_MS, ABS_MS,
  allSettings, getSetting, setSetting, invalidateSettings,
  hashPassword, verifyPassword, checkPassword, ROLES, publicUser, need,
  clientIp, isHttps, parseCookies, setSessionCookie, audit, checkEmployeeAccess,
  createSession, authUser, sessionHash, throttled, noteFailure, clearFailures,
};
