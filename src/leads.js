// Leads: privacy masking, import/normalisation, buckets, round-robin distribution, queries and bulk actions.
const { q, one, exec, tx } = require('./db');
const { HttpError, now, clip, invalidateSettings } = require('./security');

// ---------- privacy ----------
const maskPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(0, 2) + '••••••' + d.slice(-2) : '••••••'; };
const maskEmail = (e) => (e ? String(e).replace(/^(.).*(@.*)$/, '$1•••$2') : null);
// Free text (enquiry messages, old remarks) can contain numbers or emails: scrub them for non-admins.
const scrub = (t) => (t == null ? t : String(t).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[hidden]').replace(/\+?\d[\d\s\-().]{6,}\d/g, '[hidden]'));
function leadForRole(l, role) {
  if (!l) return l;
  const { phone_norm, status_before, locked_at, ...rest } = l;
  if (role === 'admin') return rest;
  const { extra, ...safe } = rest;
  return { ...safe, phone: maskPhone(l.phone), email: maskEmail(l.email), notes: scrub(l.notes) };
}

// ---------- normalisation (Excel/CSV/Sheets/Meta/Google/webhooks all funnel through here) ----------
const SYNONYMS = {
  name: ['name', 'fullname', 'leadname', 'customername', 'clientname', 'contactname'],
  first: ['firstname'], last: ['lastname'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'mobileno', 'contact', 'contactnumber', 'contactno', 'whatsapp', 'whatsappnumber', 'cell', 'telephone', 'phoneno'],
  email: ['email', 'emailid', 'emailaddress', 'mail'],
  city: ['city', 'town', 'currentcity'],
  location_pref: ['location', 'preferredlocation', 'locality', 'area', 'preferredarea'],
  property_type: ['propertytype', 'property', 'typeofproperty', 'interestedin'],
  bhk: ['bhk', 'bedrooms', 'configuration', 'unittype'],
  budget: ['budget', 'pricerange', 'budgetrange'],
  purpose: ['purpose', 'lookingto', 'intent'],
  timeline: ['timeline', 'whenplanning'],
  campaign: ['campaign', 'campaignname', 'adname', 'adsetname', 'formname', 'project', 'projectname', 'campaignid', 'adid', 'formid'],
  notes: ['message', 'comments', 'remarks', 'notes', 'note', 'requirement', 'query'],
  source: ['source', 'leadsource', 'platform'],
};
const KEY_TO_FIELD = {};
for (const [field, keys] of Object.entries(SYNONYMS)) for (const k of keys) KEY_TO_FIELD[k] = field;
const FUZZY = [['budget', 'budget'], ['phone', 'phone'], ['mobile', 'phone'], ['email', 'email'], ['bhk', 'bhk'], ['city', 'city'], ['location', 'location_pref']];
function fieldFor(rawKey) {
  const nk = String(rawKey).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (KEY_TO_FIELD[nk]) return KEY_TO_FIELD[nk];
  for (const [frag, f] of FUZZY) if (nk.includes(frag)) return f;
  return nk.endsWith('name') ? 'name' : null;
}
function normPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length > 10) d = d.slice(-10);
  return d.length === 10 ? d : null;
}
// "50-80 lakh", "1.2 cr", "75L", "5000000" -> [min, max] in rupees
function parseBudget(v) {
  if (v == null || v === '') return null;
  const s = String(v).toLowerCase().replace(/[_,₹]|rs\.?|inr/g, ' ');
  const found = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(cr|crore|crores|l|lac|lacs|lakh|lakhs|k)?\b/g)].map((m) => ({ n: Number(m[1]), unit: m[2] }));
  if (!found.length) return null;
  const mult = (u) => (!u ? null : u.startsWith('c') ? 1e7 : u === 'k' ? 1e3 : 1e5);
  const lastUnit = [...found].reverse().find((f) => f.unit)?.unit;
  const vals = found.map((f) => f.n * (mult(f.unit || lastUnit) ?? (f.n < 1000 ? 1e5 : 1)));
  return [Math.min(...vals), Math.max(...vals)];
}
const slug = (v) => String(v || 'other').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'other';
const sourceLabel = (s) => String(s).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const TEMPS = ['hot', 'warm', 'cold'];
const STATUSES = ['new', 'retry', 'callback', 'interested', 'site_visit', 'not_interested', 'invalid', 'unreachable'];

function normalizeRow(raw, defaultSource) {
  const f = {}, extra = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (v == null || String(v).trim() === '') continue;
    const field = fieldFor(k);
    if (field && f[field] === undefined) f[field] = v;
    else extra[k] = v;
  }
  const phoneNorm = normPhone(f.phone);
  if (!phoneNorm) return { error: 'Missing or invalid phone' };
  const budget = parseBudget(f.budget);
  const name = clip(f.name) || clip([f.first, f.last].filter(Boolean).join(' ')) || 'Unknown';
  return {
    lead: {
      name, phone: String(f.phone).trim().slice(0, 30), phone_norm: phoneNorm, email: clip(f.email), city: clip(f.city),
      source: slug(f.source || defaultSource), campaign: clip(f.campaign), purpose: clip(f.purpose, 40),
      property_type: clip(f.property_type, 60), bhk: clip(f.bhk, 30), location_pref: clip(f.location_pref),
      timeline: clip(f.timeline, 60), budget_min: budget?.[0] ?? null, budget_max: budget?.[1] ?? null,
      notes: clip(f.notes, 2000), extra: Object.keys(extra).length ? JSON.stringify(extra).slice(0, 4000) : null,
    },
  };
}
function parseCsv(text) {
  const rows = []; let row = [], cell = '', inq = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') inq = false; else cell += c;
    } else if (c === '"') inq = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

// ---------- buckets & round-robin ----------
async function getBucket(name, source, userId, t) {
  name = clip(name, 120) || `${sourceLabel(source)} ${new Date().toISOString().slice(0, 10)}`;
  return (await one(`INSERT INTO buckets (name,source,created_by,created_at) VALUES (?,?,?,?)
    ON CONFLICT (name, source) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name, source, userId ?? null, now()], t)).id;
}
// Fair rotation: each new lead goes to the next employee in id order, remembering where we stopped.
async function rrPicker(pool, exclude, t) {
  let ids = pool?.length
    ? (await q("SELECT id FROM users WHERE role = 'employee' AND active = 1 AND id = ANY(?::int[]) ORDER BY id", [pool], t)).map((r) => r.id)
    : (await q("SELECT id FROM users WHERE role = 'employee' AND active = 1 AND in_rotation = 1 ORDER BY id", [], t)).map((r) => r.id);
  if (exclude) ids = ids.filter((i) => i !== exclude);
  const key = 'rr_' + (pool?.length ? ids.join('-') : 'all');
  let last = Number((await one('SELECT value FROM settings WHERE key = ?', [key], t))?.value || 0);
  const rotated = () => { const i = ids.findIndex((x) => x > last); return i < 0 ? ids : [...ids.slice(i), ...ids.slice(0, i)]; };
  return {
    available: ids.length > 0,
    next() { if (!ids.length) return null; last = ids.find((i) => i > last) ?? ids[0]; return last; },
    order: rotated,
    advance(count) { if (ids.length && count) last = rotated()[(count - 1) % ids.length]; },
    async commit(tt) {
      if (!ids.length) return;
      await exec('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, String(last)], tt);
      invalidateSettings();
    },
  };
}

const LEAD_COLS = ['name', 'phone', 'phone_norm', 'email', 'source', 'campaign', 'city', 'purpose', 'property_type', 'bhk',
  'budget_min', 'budget_max', 'location_pref', 'timeline', 'notes', 'extra'];
// opts: { bucketName, mode: 'round_robin' | 'selected' | 'unassigned', pool: [employee ids], userId }
// Works in batches of 300 rows per statement so tens of thousands of leads import in a couple of seconds, even on a remote database.
async function importRows(rows, source, opts = {}) {
  const res = { inserted: 0, duplicates: 0, invalid: 0, errors: [], assigned: 0, bucket_id: null };
  const valid = [], seen = new Set();
  rows.forEach((row, i) => {
    const { lead, error } = normalizeRow(row, source);
    if (error) { res.invalid++; if (res.errors.length < 10) res.errors.push(`Row ${i + 2}: ${error}`); return; }
    if (seen.has(lead.phone_norm)) { res.duplicates++; return; }
    seen.add(lead.phone_norm); valid.push(lead);
  });
  return tx(async (t) => {
    res.bucket_id = await getBucket(opts.bucketName, source, opts.userId, t);
    if (!valid.length) return res;
    const picker = opts.mode === 'unassigned' ? null : await rrPicker(opts.mode === 'selected' ? opts.pool : null, null, t);
    const existing = new Set((await q('SELECT phone_norm FROM leads WHERE phone_norm = ANY(?::text[])', [valid.map((l) => l.phone_norm)], t)).map((r) => r.phone_norm));
    const fresh = valid.filter((l) => { if (existing.has(l.phone_norm)) { res.duplicates++; return false; } return true; });
    const ts = now(), width = LEAD_COLS.length + 4;
    for (let i = 0; i < fresh.length; i += 300) {
      const batch = fresh.slice(i, i + 300), params = [];
      const tuples = batch.map((lead) => {
        const to = picker ? picker.next() : null;
        params.push(...LEAD_COLS.map((c) => lead[c] ?? null), to, res.bucket_id, ts, ts);
        return '(' + Array(width).fill('?').join(',') + ')';
      });
      const r = await exec(`INSERT INTO leads (${LEAD_COLS.join(',')}, assigned_to, bucket_id, created_at, updated_at) VALUES ${tuples.join(',')}
        ON CONFLICT (phone_norm) DO NOTHING`, params, t);
      res.inserted += r.rowCount; res.duplicates += batch.length - r.rowCount;
    }
    if (picker?.available) res.assigned = res.inserted;
    await picker?.commit(t);
    return res;
  });
}

// ---------- queries ----------
function leadWhere(qs, role) {
  const where = [], args = [];
  if (qs.q) {
    const like = `%${qs.q}%`;
    const cols = role === 'admin' ? ['l.name', 'l.phone', 'l.phone_norm', 'l.email', 'l.city', 'l.campaign'] : ['l.name', 'l.city', 'l.campaign'];
    where.push('(' + cols.map((c) => `${c} ILIKE ?`).join(' OR ') + ')');
    cols.forEach(() => args.push(like));
  }
  for (const f of ['status', 'source', 'temperature']) if (qs[f]) { where.push(`l.${f} = ?`); args.push(qs[f]); }
  if (qs.bucket_id) { where.push('l.bucket_id = ?'); args.push(Number(qs.bucket_id)); }
  if (qs.assigned_to === 'none') where.push('l.assigned_to IS NULL');
  else if (qs.assigned_to) { where.push('l.assigned_to = ?'); args.push(Number(qs.assigned_to)); }
  return { w: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}
async function listLeads(qs, role) {
  const { w, args } = leadWhere(qs, role);
  const limit = Math.min(Number(qs.limit) || 50, 200), page = Math.max(Number(qs.page) || 1, 1);
  const [total, rows] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM leads l ${w}`, args),
    q(`SELECT l.*, u.name AS assignee, b.name AS bucket FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
      LEFT JOIN buckets b ON b.id = l.bucket_id ${w} ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...args, limit, (page - 1) * limit]),
  ]);
  return { total: total.n, rows: rows.map((l) => leadForRole(l, role)) };
}

// SQL fragment that frees a lead held by an employee (puts it back in the state it was in before the call)
const RELEASE = `status = CASE WHEN status = 'in_call' THEN COALESCE(status_before, 'new') ELSE status END,
  status_before = CASE WHEN status = 'in_call' THEN NULL ELSE status_before END, locked_by = NULL, locked_at = NULL`;

const LEAD_EDIT = ['name', 'phone', 'email', 'source', 'campaign', 'city', 'purpose', 'property_type', 'bhk', 'budget_min', 'budget_max',
  'location_pref', 'timeline', 'temperature', 'status', 'assigned_to', 'notes', 'next_action_at'];
async function editLead(id, body, role) {
  const upd = {};
  for (const f of LEAD_EDIT) {
    if (body[f] === undefined) continue;
    if ((f === 'phone' || f === 'email') && role !== 'admin') continue; // only admins may change contact details
    let v = typeof body[f] === 'string' ? body[f].trim() : body[f];
    if (v === '') v = null;
    if (f === 'name' && !v) throw new HttpError(400, 'Name is required');
    if (f === 'phone') {
      const pn = normPhone(v);
      if (!pn) throw new HttpError(400, 'Invalid phone number');
      if (await one('SELECT 1 AS x FROM leads WHERE phone_norm = ? AND id != ?', [pn, id])) throw new HttpError(409, 'Another lead already has this phone');
      upd.phone_norm = pn;
    }
    if (f === 'status' && !STATUSES.includes(v)) throw new HttpError(400, 'Invalid status');
    if (f === 'temperature' && v !== null && !TEMPS.includes(v)) throw new HttpError(400, 'Invalid temperature');
    if (f === 'source') v = slug(v);
    if (f === 'assigned_to' && v !== null) {
      v = Number(v);
      if (!(await one("SELECT 1 AS x FROM users WHERE id = ? AND active = 1 AND role = 'employee'", [v]))) throw new HttpError(400, 'Choose an active employee');
    }
    if (f === 'budget_min' || f === 'budget_max') { if (v !== null) { v = Number(v); if (!Number.isFinite(v) || v < 0) throw new HttpError(400, 'Invalid budget'); } }
    upd[f] = v;
  }
  const raw = [];
  if (upd.status) {
    Object.assign(upd, { status_before: null, locked_by: null, locked_at: null });
    if (upd.status === 'new') Object.assign(upd, { attempts: 0, next_action_at: null });
  } else if ('assigned_to' in upd) raw.push(RELEASE); // reassigning pulls the lead away from whoever was holding it
  upd.updated_at = now();
  const keys = Object.keys(upd);
  await exec(`UPDATE leads SET ${[...keys.map((k) => k + ' = ?'), ...raw].join(', ')} WHERE id = ?`, [...keys.map((k) => upd[k]), id]);
}

// ---------- set-based bulk operations (one statement, however many leads) ----------
const MAX_BULK = 100000;
// Hand every lead matched by `sub` (a SELECT id ... subquery) out to the employees in the picker, in rotation.
async function distributeWhere(t, sub, subParams, picker) {
  const order = picker.order(), n = order.length;
  const r = await exec(`UPDATE leads l SET assigned_to = (?::int[])[1 + ((x.rn - 1) % ?::int)], ${RELEASE},
    updated_at = ? FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM leads WHERE id IN (${sub})) x WHERE l.id = x.id`,
  [order, n, now(), ...subParams], t);
  picker.advance(r.rowCount);
  await picker.commit(t);
  return r.rowCount;
}
// Move an employee's open leads to the rest of the team (when they leave, are deleted or go on leave).
async function redistributeFrom(uid, t, includeLocked = false) {
  const picker = await rrPicker(null, uid, t);
  if (!picker.available) return 0;
  const sts = includeLocked ? "'new','callback','retry','in_call'" : "'new','callback','retry'";
  return distributeWhere(t, `SELECT id FROM leads WHERE assigned_to = ? AND status IN (${sts})`, [uid], picker);
}
async function releaseLocksOf(uid, t) {
  await exec(`UPDATE leads SET ${RELEASE}, updated_at = ? WHERE locked_by = ? AND status = 'in_call'`, [now(), uid], t);
}
async function bulk(user, body) {
  const isAdmin = user.role === 'admin';
  let sub, params;
  if (body.filter) { const { w, args } = leadWhere(body.filter, user.role); sub = `SELECT l.id FROM leads l ${w} LIMIT ${MAX_BULK}`; params = args; }
  else {
    const ids = (body.ids || []).map(Number).filter(Number.isInteger).slice(0, MAX_BULK);
    if (!ids.length) throw new HttpError(400, 'Select at least one lead');
    sub = 'SELECT UNNEST(?::int[])'; params = [ids];
  }
  const action = body.action;
  if (action === 'delete' && !isAdmin) throw new HttpError(403, 'Only admins can delete leads');
  if (action === 'status' && !STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid status');
  let assignTo = null;
  if (action === 'assign' && body.assigned_to) {
    assignTo = Number(body.assigned_to);
    if (!(await one("SELECT 1 AS x FROM users WHERE id = ? AND active = 1 AND role = 'employee'", [assignTo]))) throw new HttpError(400, 'Choose an active employee');
  }
  return tx(async (t) => {
    const ts = now();
    switch (action) {
      case 'distribute': {
        const picker = await rrPicker(null, null, t);
        if (!picker.available) throw new HttpError(400, 'No employees are available for leads');
        return distributeWhere(t, sub, params, picker);
      }
      case 'assign': return (await exec(`UPDATE leads SET assigned_to = ?, ${RELEASE}, updated_at = ? WHERE id IN (${sub})`, [assignTo, ts, ...params], t)).rowCount;
      case 'release': return (await exec(`UPDATE leads SET ${RELEASE}, updated_at = ? WHERE status = 'in_call' AND id IN (${sub})`, [ts, ...params], t)).rowCount;
      case 'requeue': return (await exec(`UPDATE leads SET status = 'new', attempts = 0, next_action_at = NULL, status_before = NULL, locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id IN (${sub})`, [ts, ...params], t)).rowCount;
      case 'status': return (await exec(`UPDATE leads SET status = ?, status_before = NULL, locked_by = NULL, locked_at = NULL${body.status === 'new' ? ', attempts = 0, next_action_at = NULL' : ''}, updated_at = ? WHERE id IN (${sub})`, [body.status, ts, ...params], t)).rowCount;
      case 'delete': return (await exec(`DELETE FROM leads WHERE id IN (${sub})`, params, t)).rowCount;
      default: throw new HttpError(400, 'Unknown action');
    }
  });
}

module.exports = {
  maskPhone, maskEmail, scrub, leadForRole, normalizeRow, normPhone, parseCsv, slug, sourceLabel, TEMPS, STATUSES,
  getBucket, rrPicker, importRows, listLeads, editLead, bulk, redistributeFrom, releaseLocksOf, distributeWhere, RELEASE,
};
