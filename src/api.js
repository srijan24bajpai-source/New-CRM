// HTTP API (/api/*) and inbound lead webhooks (/hooks/*).
//   employee   -> /api/queue/*  (one assigned lead at a time, no phone numbers)
//   management -> everything except user admin, integrations, security and deletes
//   admin      -> everything
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { q, one, exec, tx } = require('./db');
const S = require('./security');
const L = require('./leads');
const C = require('./calls');
const { readRaw, parseJson, send, sendText } = require('./http');
const { HttpError, now, clip, randHex, safeEqual } = S;

const num = (v) => Number(v);
const BIG = 30e6; // chunked imports are kept small by the client; this is only the ceiling

// ---------- inbound lead webhooks (Meta, Google Ads, generic: Sheets / portals / website) ----------
async function fetchMetaLead(v) {
  const token = await S.getSetting('meta_page_token');
  if (!token) throw new Error('meta_page_token not configured');
  const r = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(v.leadgen_id)}?access_token=${encodeURIComponent(token)}`);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'Graph API error');
  const row = {};
  for (const f of data.field_data || []) row[f.name] = (f.values || []).join(', ');
  row.campaign = data.ad_name || data.campaign_name || (v.form_id ? `Form ${v.form_id}` : undefined);
  const out = await L.importRows([row], 'meta', { bucketName: row.campaign ? `Meta - ${row.campaign}` : undefined, mode: 'round_robin' });
  if (out.invalid) throw new Error(out.errors[0]);
}
async function handleHook(req, res, url) {
  const which = url.pathname.split('/')[2];
  const key = await S.getSetting('webhook_key');
  const raw = req.method === 'POST' ? await readRaw(req, 2e6) : '';

  if (which === 'meta') {
    if (req.method === 'GET') { // Meta's one-time subscription handshake
      const p = url.searchParams;
      if (p.get('hub.mode') === 'subscribe' && safeEqual(p.get('hub.verify_token') || '', await S.getSetting('meta_verify_token'))) return sendText(res, 200, p.get('hub.challenge') || '');
      return sendText(res, 403, 'Forbidden');
    }
    const secret = await S.getSetting('meta_app_secret');
    if (secret) {
      const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
      if (!safeEqual(req.headers['x-hub-signature-256'] || '', expected)) return sendText(res, 401, 'Bad signature');
    }
    const payload = parseJson(raw);
    const jobs = [];
    for (const entry of payload.entry || []) for (const ch of entry.changes || []) {
      if (ch.field === 'leadgen' && ch.value?.leadgen_id) jobs.push(fetchMetaLead(ch.value).catch((e) => console.error('Meta lead fetch failed:', e.message)));
    }
    await Promise.all(jobs); // serverless functions stop after responding, so finish the work first
    return send(res, 200, { ok: true });
  }
  if (which === 'twilio') {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const params = Object.fromEntries(new URLSearchParams(raw));
    await C.verifyTwilio(req, url, params);
    const twiml = await C.handleTwilioEvent(url.pathname.split('/')[3], Number(url.searchParams.get('s')), params);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${twiml || ''}</Response>`);
  }
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  const body = parseJson(raw);
  if (which === 'google') { // Google Ads lead form webhook; it sends the key in the body as google_key
    if (!safeEqual(body.google_key || url.searchParams.get('key') || '', key)) throw new HttpError(401, 'Invalid key');
    const row = {};
    for (const c of body.user_column_data || []) row[c.column_id || c.column_name] = c.string_value;
    row.campaign = body.campaign_id ? `Campaign ${body.campaign_id}` : body.form_id ? `Form ${body.form_id}` : undefined;
    const out = await L.importRows([row], 'google', { mode: 'round_robin' });
    if (out.invalid) throw new HttpError(400, out.errors[0]);
    return send(res, 200, { result: out.inserted ? 'inserted' : 'duplicate' });
  }
  if (which === 'lead') { // generic: Google Sheets Apps Script, Zapier, portals, website forms
    if (!safeEqual(req.headers['x-api-key'] || url.searchParams.get('key') || '', key)) throw new HttpError(401, 'Invalid key');
    const rows = Array.isArray(body) ? body : Array.isArray(body.leads) ? body.leads : [body];
    return send(res, 200, await L.importRows(rows.slice(0, 5000), L.slug(url.searchParams.get('source') || body.source || 'website'), { mode: 'round_robin' }));
  }
  throw new HttpError(404, 'Not found');
}

// ---------- housekeeping (called daily by a scheduled job) ----------
async function housekeeping() {
  const t = Date.now();
  await exec('DELETE FROM sessions WHERE last_seen < ? OR created_at < ?', [t - S.IDLE_MS, t - S.ABS_MS]);
  await exec('DELETE FROM login_attempts WHERE updated < ?', [t - 86400000]);
  await exec('DELETE FROM audit WHERE ts < ?', [new Date(t - 365 * 86400000).toISOString()]);
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const [, , r0, r1, r2] = url.pathname.split('/'); // ['', 'api', r0, r1, r2]
  const method = req.method;

  if (r0 === 'cron') { // Vercel Cron sends "Authorization: Bearer $CRON_SECRET"
    const secret = process.env.CRON_SECRET;
    if (!secret || !safeEqual(req.headers.authorization || '', `Bearer ${secret}`)) throw new HttpError(401, 'Unauthorized');
    await housekeeping();
    return send(res, 200, { ok: true });
  }

  // CSRF: the session cookie is SameSite=Strict, and every state-changing call must also carry this header.
  if (!['GET', 'HEAD'].includes(method) && req.headers['x-crm'] !== '1') throw new HttpError(403, 'Bad request');
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? parseJson(await readRaw(req, url.pathname === '/api/leads/import' ? BIG : 1e6)) : {};

  if (r0 === 'auth' && r1 === 'login' && method === 'POST') {
    const email = String(body.email || '').toLowerCase().trim(), ip = S.clientIp(req);
    if ((await S.throttled(`${ip}|${email}`)) || (await S.throttled(`acct|${email}`))) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const u = await one('SELECT * FROM users WHERE email = ? AND active = 1', [email]);
    if (!u || !S.verifyPassword(String(body.password || ''), u.password_hash)) {
      await S.noteFailure(`${ip}|${email}`, 8); await S.noteFailure(`acct|${email}`, 25);
      await S.audit(null, 'login.fail', email, null, req);
      throw new HttpError(401, 'Invalid email or password');
    }
    if (u.role === 'employee') await S.checkEmployeeAccess(req);
    await S.createSession(req, res, u);
    await S.clearFailures(`${ip}|${email}`);
    await S.audit(u, 'login', null, null, req);
    return send(res, 200, { user: S.publicUser(u) });
  }

  const user = await S.authUser(req);
  if (!user) throw new HttpError(401, 'Unauthorized');
  if (r0 === 'auth' && r1 === 'logout' && method === 'POST') {
    await exec('DELETE FROM sessions WHERE token_hash = ?', [S.sessionHash(req)]);
    S.setSessionCookie(req, res, '', 0);
    await S.audit(user, 'logout', null, null, req);
    return send(res, 200, { ok: true });
  }
  if (r0 === 'auth' && r1 === 'password' && method === 'POST') { // optional: people may change their password whenever they like
    const row = await one('SELECT * FROM users WHERE id = ?', [user.id]);
    if (!S.verifyPassword(String(body.current || ''), row.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    S.checkPassword(body.password);
    if (body.password === body.current) throw new HttpError(400, 'Choose a different password');
    await exec('UPDATE users SET password_hash = ? WHERE id = ?', [S.hashPassword(body.password), user.id]);
    await exec('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [user.id, S.sessionHash(req)]); // sign out other devices
    await S.audit(user, 'password.change', null, null, req);
    return send(res, 200, { ok: true });
  }
  if (r0 === 'me') {
    if (method === 'PATCH') {
      const phone = body.phone ? L.normPhone(body.phone) : null;
      if (body.phone && !phone) throw new HttpError(400, 'Enter a valid 10-digit mobile number');
      await exec('UPDATE users SET phone = ? WHERE id = ?', [phone, user.id]);
    }
    return send(res, 200, S.publicUser(await one('SELECT * FROM users WHERE id = ?', [user.id])));
  }

  // ----- employee endpoints -----
  if (r0 === 'queue') {
    if (user.role !== 'employee') throw new HttpError(403, 'Employees only');
    if (r1 === 'dial' && method === 'POST') return send(res, 200, await C.startDial(user, body, req));
    if (r1 === 'hangup' && method === 'POST') return send(res, 200, await C.hangup(user, body.session_id));
    if (r1 === 'session' && method === 'GET') {
      const s = await C.liveSession(num(r2));
      if (!s || s.user_id !== user.id) throw new HttpError(404, 'Call not found');
      return send(res, 200, { id: s.id, status: s.status, end_reason: s.end_reason, answered_at: s.answered_at, ended_at: s.ended_at, talk_sec: s.talk_sec, server_now: now() });
    }
    if (r1 === 'current' && method === 'GET') return send(res, 200, await C.queueState(user.id));
    if (r1 === 'complete' && method === 'POST') { await C.completeCall(user, body, req); return send(res, 200, await C.queueState(user.id)); }
    throw new HttpError(404, 'Not found');
  }

  // ----- everything below: management + admin -----
  S.need(user, 'management');
  const isAdmin = user.role === 'admin';
  const id = num(r1);
  const validId = Number.isInteger(id) && id > 0;

  if (r0 === 'stats' && method === 'GET') return send(res, 200, await C.dashboardStats());

  if (r0 === 'leads') {
    if (!r1 && method === 'GET') return send(res, 200, await L.listLeads(Object.fromEntries(url.searchParams), user.role));
    if (!r1 && method === 'POST') {
      const { budget_min, budget_max, assigned_to, bucket_name, ...rest } = body;
      const row = { ...rest };
      const lo = budget_min === '' || budget_min == null ? null : Number(budget_min), hi = budget_max === '' || budget_max == null ? null : Number(budget_max);
      if (lo || hi) row.budget = [lo, hi].filter((x) => x).join('-');
      const out = await L.importRows([row], L.slug(body.source || 'manual'), {
        bucketName: bucket_name || 'Manual entries', userId: user.id, mode: assigned_to ? 'selected' : 'round_robin', pool: assigned_to ? [num(assigned_to)] : [],
      });
      if (out.invalid) throw new HttpError(400, out.errors[0].replace(/^Row \d+: /, ''));
      if (out.duplicates) throw new HttpError(409, 'A lead with this phone already exists');
      await S.audit(user, 'lead.create', rest.name || null, null, req);
      return send(res, 201, { ok: true });
    }
    if (r1 === 'import' && method === 'POST') {
      if (!Array.isArray(body.rows) || !body.rows.length) throw new HttpError(400, 'No rows to import');
      if (body.rows.length > 20000) throw new HttpError(400, 'Max 20,000 rows per request');
      const out = await L.importRows(body.rows, L.slug(body.source || 'excel'), { bucketName: body.bucket_name, mode: body.mode || 'round_robin', pool: (body.pool || []).map(num), userId: user.id });
      await S.audit(user, 'lead.import', body.bucket_name || body.source, `${out.inserted} added, ${out.duplicates} duplicates`, req);
      return send(res, 200, out);
    }
    if (r1 === 'import-url' && method === 'POST') {
      let target;
      try { target = new URL(String(body.url || '')); } catch { throw new HttpError(400, 'Invalid URL'); }
      if (target.hostname !== 'docs.google.com') throw new HttpError(400, 'Only Google Sheets links (docs.google.com) are supported');
      const sheetId = /\/spreadsheets\/d\/([\w-]+)/.exec(target.pathname)?.[1];
      let csvUrl;
      if (/\/pub/.test(target.pathname)) csvUrl = target.href;
      else if (sheetId && sheetId !== 'e') {
        const gid = target.hash.match(/gid=(\d+)/)?.[1] || target.searchParams.get('gid');
        csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gid ? '&gid=' + gid : ''}`;
      } else throw new HttpError(400, 'Could not read the sheet id from this link');
      const r = await fetch(csvUrl, { redirect: 'follow' });
      const text = await r.text();
      if (!r.ok || /^\s*<(!doctype|html)/i.test(text)) throw new HttpError(400, 'Could not read the sheet. Set sharing to "Anyone with the link can view".');
      const rows = L.parseCsv(text);
      if (!rows.length) throw new HttpError(400, 'The sheet has no data rows');
      const opts = { bucketName: body.bucket_name, mode: body.mode || 'round_robin', pool: (body.pool || []).map(num), userId: user.id };
      const total = { inserted: 0, duplicates: 0, invalid: 0, errors: [], assigned: 0 };
      for (let i = 0; i < Math.min(rows.length, 20000); i += 2000) {
        const o = await L.importRows(rows.slice(i, i + 2000), L.slug(body.source || 'google'), opts);
        for (const k of ['inserted', 'duplicates', 'invalid', 'assigned']) total[k] += o[k];
        total.errors.push(...o.errors.slice(0, 10 - total.errors.length));
      }
      await S.audit(user, 'lead.import', body.bucket_name || 'Google Sheet', `${total.inserted} added`, req);
      return send(res, 200, total);
    }
    if (r1 === 'bulk' && method === 'POST') {
      const count = await L.bulk(user, body);
      await S.audit(user, `lead.bulk.${body.action}`, body.filter ? 'filtered leads' : `${(body.ids || []).length} leads`, `${count} affected${body.assigned_to ? ', to user ' + body.assigned_to : ''}`, req);
      return send(res, 200, { ok: true, count });
    }
    if (validId) {
      const lead = await one(`SELECT l.*, u.name AS assignee, b.name AS bucket FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
        LEFT JOIN buckets b ON b.id = l.bucket_id WHERE l.id = ?`, [id]);
      if (!lead) throw new HttpError(404, 'Lead not found');
      if (r2 === 'reveal' && method === 'POST') { // management must explicitly unmask a number; every reveal is logged and rate-limited
        const used = (await one("SELECT COUNT(*) AS n FROM audit WHERE user_id = ? AND action = 'lead.reveal' AND ts >= ?", [user.id, new Date(Date.now() - 3600000).toISOString()])).n;
        if (!isAdmin && used >= 25) throw new HttpError(429, 'Reveal limit reached for this hour');
        await S.audit(user, 'lead.reveal', `lead:${id}`, lead.name, req);
        return send(res, 200, { phone: lead.phone, email: lead.email });
      }
      if (!r2 && method === 'GET') {
        const calls = await q(`SELECT c.*, COALESCE(u.name, c.agent_name || ' (removed)') AS agent, s.answered_at, s.ended_at,
          s.recording_url IS NOT NULL AS has_recording FROM calls c LEFT JOIN users u ON u.id = c.user_id
          LEFT JOIN call_sessions s ON s.id = c.session_id WHERE c.lead_id = ? ORDER BY c.id DESC`, [id]);
        return send(res, 200, { ...L.leadForRole(lead, user.role), calls: calls.map((c) => ({ ...c, notes: isAdmin ? c.notes : L.scrub(c.notes) })) });
      }
      if (!r2 && (method === 'PATCH' || method === 'PUT')) { await L.editLead(id, body, user.role); await S.audit(user, 'lead.edit', `lead:${id}`, Object.keys(body).join(','), req); return send(res, 200, { ok: true }); }
      if (!r2 && method === 'DELETE') {
        if (!isAdmin) throw new HttpError(403, 'Only admins can delete leads');
        await exec('DELETE FROM leads WHERE id = ?', [id]); await S.audit(user, 'lead.delete', `lead:${id}`, lead.name, req);
        return send(res, 200, { ok: true });
      }
    }
  }

  if (r0 === 'buckets') {
    if (!r1 && method === 'GET') {
      return send(res, 200, await q(`SELECT b.*, COUNT(l.id) AS total,
        COUNT(*) FILTER (WHERE l.status IN ('new','retry','callback')) AS pending, COUNT(*) FILTER (WHERE l.attempts > 0) AS called,
        COUNT(*) FILTER (WHERE l.temperature = 'hot') AS hot, COUNT(*) FILTER (WHERE l.temperature = 'warm') AS warm,
        COUNT(*) FILTER (WHERE l.temperature = 'cold') AS cold, COUNT(*) FILTER (WHERE l.id IS NOT NULL AND l.assigned_to IS NULL) AS unassigned
        FROM buckets b LEFT JOIN leads l ON l.bucket_id = b.id GROUP BY b.id ORDER BY b.id DESC`));
    }
    if (validId && method === 'PATCH') {
      if (body.status && !['active', 'paused'].includes(body.status)) throw new HttpError(400, 'Invalid status');
      if (body.status) await exec('UPDATE buckets SET status = ? WHERE id = ?', [body.status, id]);
      if (body.name && clip(body.name, 120)) await exec('UPDATE buckets SET name = ? WHERE id = ?', [clip(body.name, 120), id]);
      await S.audit(user, 'bucket.update', `bucket:${id}`, body.status || body.name, req);
      return send(res, 200, { ok: true });
    }
    if (validId && r2 === 'distribute' && method === 'POST') { // hand out the bucket's unassigned leads round-robin
      const count = await tx(async (t) => {
        const picker = await L.rrPicker(null, null, t);
        if (!picker.available) throw new HttpError(400, 'No employees are available for leads');
        return L.distributeWhere(t, "SELECT id FROM leads WHERE bucket_id = ? AND assigned_to IS NULL AND status IN ('new','retry','callback')", [id], picker);
      });
      await S.audit(user, 'bucket.distribute', `bucket:${id}`, `${count} leads`, req);
      return send(res, 200, { count });
    }
  }

  if (r0 === 'calls') {
    if (!r1 && method === 'GET') {
      const qs = Object.fromEntries(url.searchParams), where = [], args = [];
      if (qs.employee) { where.push('c.user_id = ?'); args.push(num(qs.employee)); }
      if (qs.disposition) { where.push('c.disposition = ?'); args.push(qs.disposition); }
      if (qs.temperature) { where.push('c.temperature = ?'); args.push(qs.temperature); }
      if (qs.from) { where.push('c.created_at >= ?'); args.push(new Date(qs.from).toISOString()); }
      if (qs.to) { where.push('c.created_at < ?'); args.push(new Date(new Date(qs.to).getTime() + 86400000).toISOString()); }
      const page = Math.max(num(qs.page) || 1, 1), w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [total, rows] = await Promise.all([
        one(`SELECT COUNT(*) AS n FROM calls c ${w}`, args),
        q(`SELECT c.id, c.disposition, c.temperature, c.notes, c.duration_sec, c.created_at, l.id AS lead_id, l.name AS lead, l.phone AS lead_phone,
          COALESCE(u.name, c.agent_name || ' (removed)') AS agent, s.answered_at, s.ended_at, s.recording_url IS NOT NULL AS has_recording FROM calls c
          JOIN leads l ON l.id = c.lead_id LEFT JOIN users u ON u.id = c.user_id LEFT JOIN call_sessions s ON s.id = c.session_id
          ${w} ORDER BY c.id DESC LIMIT 50 OFFSET ?`, [...args, (page - 1) * 50]),
      ]);
      return send(res, 200, { total: total.n, rows: rows.map((r) => ({ ...r, lead_phone: isAdmin ? r.lead_phone : L.maskPhone(r.lead_phone), notes: isAdmin ? r.notes : L.scrub(r.notes) })) });
    }
    if (validId && r2 === 'recording' && method === 'GET') {
      const row = await one('SELECT s.recording_url FROM calls c JOIN call_sessions s ON s.id = c.session_id WHERE c.id = ?', [id]);
      if (!row?.recording_url) throw new HttpError(404, 'No recording for this call');
      const c = await C.cfg();
      const r = await fetch(row.recording_url + '.mp3', { headers: { Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64') } });
      if (!r.ok) throw new HttpError(502, 'Recording is not available yet');
      await S.audit(user, 'recording.play', `call:${id}`, null, req);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return void Readable.fromWeb(r.body).pipe(res); // streamed, so long recordings are not limited by response size
    }
  }

  if (r0 === 'users') {
    if (!r1 && method === 'GET') {
      const rows = await q(`SELECT u.id,u.name,u.email,u.role,u.active,u.phone,u.in_rotation,u.created_at,
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.status IN ('new','callback','retry')) AS pending FROM users u
        ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'management' THEN 1 ELSE 2 END, u.name`);
      return send(res, 200, rows.map((u) => ({ ...u, email: isAdmin ? u.email : L.maskEmail(u.email), phone: isAdmin ? u.phone : u.phone ? L.maskPhone(u.phone) : null })));
    }
    if (validId && r2 === 'rotation' && method === 'POST') { // availability for new leads
      await exec("UPDATE users SET in_rotation = ? WHERE id = ? AND role = 'employee'", [body.in_rotation ? 1 : 0, id]);
      await S.audit(user, 'user.rotation', `user:${id}`, String(!!body.in_rotation), req);
      return send(res, 200, { ok: true });
    }
    if (validId && r2 === 'redistribute' && method === 'POST') {
      const moved = await tx((t) => L.redistributeFrom(id, t));
      await S.audit(user, 'user.redistribute', `user:${id}`, `${moved} leads`, req);
      return send(res, 200, { moved });
    }
    if (!isAdmin) throw new HttpError(403, 'Only admins manage users');
    if (!r1 && method === 'POST') {
      const name = clip(body.name, 100), email = String(body.email || '').toLowerCase().trim();
      if (!name || !/^\S+@\S+$/.test(email)) throw new HttpError(400, 'Name and a valid email are required');
      S.checkPassword(body.password);
      if (await one('SELECT 1 AS x FROM users WHERE email = ?', [email])) throw new HttpError(409, 'Email already in use');
      const role = S.ROLES.includes(body.role) ? body.role : 'employee';
      const phone = body.phone ? L.normPhone(body.phone) : null;
      await exec('INSERT INTO users (name,email,password_hash,role,phone,created_at) VALUES (?,?,?,?,?,?)', [name, email, S.hashPassword(body.password), role, phone, now()]);
      await S.audit(user, 'user.create', email, role, req);
      return send(res, 201, { ok: true });
    }
    if (validId && (method === 'PATCH' || method === 'PUT')) {
      const target = await one('SELECT * FROM users WHERE id = ?', [id]);
      if (!target) throw new HttpError(404, 'User not found');
      const upd = {};
      if (body.name !== undefined) upd.name = clip(body.name, 100) || target.name;
      if (body.role !== undefined) upd.role = S.ROLES.includes(body.role) ? body.role : target.role;
      if (body.active !== undefined) upd.active = body.active ? 1 : 0;
      if (body.phone !== undefined) {
        upd.phone = body.phone ? L.normPhone(body.phone) : null;
        if (body.phone && !upd.phone) throw new HttpError(400, 'Enter a valid 10-digit mobile number');
      }
      if (body.password) { S.checkPassword(body.password); upd.password_hash = S.hashPassword(String(body.password)); }
      const losesAdmin = target.role === 'admin' && ((upd.role && upd.role !== 'admin') || upd.active === 0);
      if (losesAdmin && id === user.id) throw new HttpError(400, 'You cannot demote or deactivate yourself');
      if (losesAdmin && (await one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?", [id])).n === 0) throw new HttpError(400, 'At least one active admin is required');
      const keys = Object.keys(upd);
      await tx(async (t) => {
        if (keys.length) await exec(`UPDATE users SET ${keys.map((k) => k + ' = ?').join(',')} WHERE id = ?`, [...keys.map((k) => upd[k]), id], t);
        if (upd.active === 0 || upd.password_hash || upd.role) await exec('DELETE FROM sessions WHERE user_id = ?', [id], t);
        if (target.role === 'employee' && (upd.active === 0 || (upd.role && upd.role !== 'employee'))) { await L.releaseLocksOf(id, t); await L.redistributeFrom(id, t); } // their open leads go to the team
      });
      await S.audit(user, 'user.update', target.email, Object.keys(body).filter((k) => k !== 'password').join(','), req);
      return send(res, 200, { ok: true });
    }
    if (validId && method === 'DELETE') { // permanently remove someone who has left; their open leads are handed to the team
      const target = await one('SELECT * FROM users WHERE id = ?', [id]);
      if (!target) throw new HttpError(404, 'User not found');
      if (id === user.id) throw new HttpError(400, 'You cannot delete your own account');
      if (target.role === 'admin' && (await one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?", [id])).n === 0) throw new HttpError(400, 'At least one active admin is required');
      const moved = await tx(async (t) => {
        await L.releaseLocksOf(id, t);
        const n = target.role === 'employee' ? await L.redistributeFrom(id, t) : 0;
        await exec('DELETE FROM users WHERE id = ?', [id], t); // sessions go with them; call history stays with their name kept
        return n;
      });
      await S.audit(user, 'user.delete', target.email, `${moved} open leads reassigned`, req);
      return send(res, 200, { ok: true, moved });
    }
  }

  // ----- admin only -----
  if (!isAdmin) throw new HttpError(403, 'Only admins can open this');
  if (r0 === 'audit' && method === 'GET') {
    const qs = Object.fromEntries(url.searchParams), where = [], args = [];
    if (qs.action) { where.push('action LIKE ?'); args.push(qs.action + '%'); }
    if (qs.user) { where.push('user_id = ?'); args.push(num(qs.user)); }
    return send(res, 200, await q(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`, args));
  }
  if (r0 === 'security') {
    if (method === 'GET') {
      const s = await S.allSettings();
      return send(res, 200, { employee_ips: s.employee_ips || '', employee_hours_start: s.employee_hours_start || '', employee_hours_end: s.employee_hours_end || '',
        allow_direct_dial: s.allow_direct_dial === '1', your_ip: S.clientIp(req), timezone: s.timezone || process.env.TIMEZONE || 'Asia/Kolkata' });
    }
    if (method === 'PUT') {
      if (typeof body.employee_ips === 'string') await S.setSetting('employee_ips', body.employee_ips.split(',').map((x) => x.trim()).filter(Boolean).join(','));
      for (const k of ['employee_hours_start', 'employee_hours_end']) {
        if (typeof body[k] === 'string') { if (body[k] && !/^\d\d:\d\d$/.test(body[k])) throw new HttpError(400, 'Use HH:MM for working hours'); await S.setSetting(k, body[k]); }
      }
      if (typeof body.timezone === 'string' && body.timezone) {
        try { new Intl.DateTimeFormat('en-GB', { timeZone: body.timezone }); } catch { throw new HttpError(400, 'Unknown timezone'); }
        await S.setSetting('timezone', body.timezone);
      }
      if (body.allow_direct_dial !== undefined) await S.setSetting('allow_direct_dial', body.allow_direct_dial ? '1' : '0');
      await S.audit(user, 'security.update', null, Object.keys(body).join(','), req);
      return send(res, 200, { ok: true });
    }
  }
  if (r0 === 'integrations') {
    if (!r1 && method === 'GET') {
      const c = await C.cfg(), s = await S.allSettings();
      return send(res, 200, {
        webhook_key: s.webhook_key, meta_verify_token: s.meta_verify_token,
        meta_page_token_set: !!s.meta_page_token, meta_app_secret_set: !!s.meta_app_secret,
        telephony: { ready: c.ready, mode: c.mode, twilio_account_sid: c.sid, twilio_from: c.from, twilio_token_set: !!c.token,
          public_url: c.publicUrl, record_calls: c.record, default_country_code: c.cc },
      });
    }
    if (!r1 && method === 'PUT') {
      for (const k of ['meta_verify_token', 'meta_page_token', 'meta_app_secret', 'twilio_auth_token']) if (typeof body[k] === 'string' && body[k].trim()) await S.setSetting(k, body[k].trim());
      for (const k of ['twilio_account_sid', 'twilio_from', 'public_url', 'record_calls', 'default_country_code', 'telephony_mode']) {
        if (typeof body[k] !== 'string') continue;
        let v = body[k].trim();
        if (k === 'public_url' && v && !/^https?:\/\/[^/\s]+/.test(v)) throw new HttpError(400, 'Public URL must start with https://');
        if (k === 'default_country_code') v = v.replace(/\D/g, '') || '91';
        if (k === 'record_calls') v = v === '1' ? '1' : '0';
        if (k === 'telephony_mode' && !['simulate', 'twilio', 'off'].includes(v)) throw new HttpError(400, 'Invalid calling mode');
        await S.setSetting(k, v);
      }
      await S.audit(user, 'integrations.update', null, Object.keys(body).filter((k) => !/token|secret/.test(k)).join(','), req);
      return send(res, 200, { ok: true });
    }
    if (r1 === 'rotate' && method === 'POST') { await S.setSetting('webhook_key', randHex(20)); await S.audit(user, 'integrations.rotate', null, null, req); return send(res, 200, { ok: true }); }
  }
  throw new HttpError(404, 'Not found');
}

module.exports = { handleApi, handleHook, housekeeping };
