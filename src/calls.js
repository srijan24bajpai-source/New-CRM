// Calling: the employee queue (one lead at a time), phone service (demo or Twilio), call feedback and dashboard stats.
const crypto = require('node:crypto');
const { q, one, exec, tx } = require('./db');
const { HttpError, now, clip, safeEqual, allSettings, audit } = require('./security');
const { scrub, normPhone, TEMPS } = require('./leads');

const RETRY_MIN = Number(process.env.RETRY_MINUTES || 120);   // wait before re-dialling an unanswered lead
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 4);   // after this many calls a lead becomes "unreachable"
const CONNECTED = ['interested', 'site_visit', 'callback', 'not_interested'];
const DISPOSITIONS = [...CONNECTED, 'no_answer', 'busy', 'switched_off', 'wrong_number'];
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };

// ---------- telephony settings ----------
async function cfg() {
  const s = await allSettings();
  const publicUrl = (s.public_url || process.env.PUBLIC_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '')).replace(/\/+$/, '');
  const c = {
    sid: s.twilio_account_sid || process.env.TWILIO_ACCOUNT_SID || '', token: s.twilio_auth_token || process.env.TWILIO_AUTH_TOKEN || '',
    from: s.twilio_from || process.env.TWILIO_FROM || '', publicUrl, record: s.record_calls === '1', cc: s.default_country_code || '91',
    direct: s.allow_direct_dial === '1',
  };
  c.mode = s.telephony_mode || (c.sid && c.token ? 'twilio' : 'simulate');
  c.ready = c.mode === 'simulate' || (c.mode === 'twilio' && !!(c.sid && c.token && c.from && /^https?:\/\/[^/]+/.test(c.publicUrl)));
  return c;
}
const e164 = (norm, c) => `+${c.cc}${norm}`;
const STALE_CALL_MS = 30 * 60000;
const sessionById = (id, t) => one('SELECT * FROM call_sessions WHERE id = ?', [id], t);
const publicSession = (s) => s && ({ id: s.id, status: s.status, end_reason: s.end_reason, answered_at: s.answered_at, ended_at: s.ended_at, talk_sec: s.talk_sec, server_now: now() });

async function finishSession(id, reason, twilioSeconds) {
  const s = await sessionById(id);
  if (!s || s.status === 'ended') return;
  const t = now();
  let talk = s.answered_at ? Math.max(0, Math.round((Date.parse(t) - Date.parse(s.answered_at)) / 1000)) : 0;
  if (s.answered_at && Number.isFinite(twilioSeconds)) talk = twilioSeconds;
  await exec("UPDATE call_sessions SET status = 'ended', ended_at = ?, talk_sec = ?, end_reason = ? WHERE id = ? AND status != 'ended'", [t, talk, reason, id]);
}
// Demo calls are stateless: where a simulated call "is" depends only on how long ago it started.
async function advanceSim(s) {
  const el = Date.now() - Date.parse(s.created_at);
  const target = el >= 4500 ? 'in_call' : el >= 2600 ? 'ringing_lead' : el >= 1200 ? 'agent_connected' : 'dialing_agent';
  if (target === s.status) return s;
  const answered = target === 'in_call' ? new Date(Date.parse(s.created_at) + 4500).toISOString() : null;
  await exec('UPDATE call_sessions SET status = ?, ringing_at = COALESCE(ringing_at, ?), answered_at = COALESCE(answered_at, ?) WHERE id = ? AND status != \'ended\'',
    [target, target === 'ringing_lead' || target === 'in_call' ? new Date(Date.parse(s.created_at) + 2600).toISOString() : null, answered, s.id]);
  return sessionById(s.id);
}
async function liveSession(id) {
  let s = await sessionById(id);
  if (!s || s.status === 'ended') return s;
  if (Date.now() - Date.parse(s.created_at) > STALE_CALL_MS) { await finishSession(id, 'failed'); return sessionById(id); }
  if (s.provider_sid === 'SIM') s = await advanceSim(s);
  return s;
}
async function twilioRequest(c, method, p, pairs) {
  const body = new URLSearchParams();
  for (const [k, v] of pairs) body.append(k, v);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/${p}`, {
    method, body, headers: { Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64') },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, `Phone service error: ${j.message || r.status}`);
  return j;
}
async function lockedLeadFor(user, leadId) {
  const lead = await one('SELECT * FROM leads WHERE id = ?', [Number(leadId)]);
  if (!lead || lead.status !== 'in_call' || lead.locked_by !== user.id) throw new HttpError(409, 'This lead is not currently assigned to you');
  return lead;
}
// Flow: ring the employee's own phone first; when they answer, bridge to the lead. The lead's number is only
// used server-side, so it never reaches the employee's screen or phone.
async function startDial(user, body, req) {
  const c = await cfg();
  if (!c.ready) throw new HttpError(400, 'Calling is not set up yet. Ask your admin.');
  const lead = await lockedLeadFor(user, body.lead_id);
  let agentPhone = null;
  if (c.mode === 'twilio') {
    agentPhone = normPhone((await one('SELECT phone FROM users WHERE id = ?', [user.id]))?.phone);
    if (!agentPhone) throw new HttpError(400, 'Add your phone number first. We call you, then connect the lead.');
  }
  const busy = await one("SELECT id FROM call_sessions WHERE user_id = ? AND status != 'ended' AND created_at > ?", [user.id, new Date(Date.now() - STALE_CALL_MS).toISOString()]);
  if (busy) throw new HttpError(409, 'A call is already in progress');
  const id = (await one('INSERT INTO call_sessions (lead_id,user_id,created_at,provider_sid) VALUES (?,?,?,?) RETURNING id', [lead.id, user.id, now(), c.mode === 'simulate' ? 'SIM' : null])).id;
  await audit(user, 'call.dial', `lead:${lead.id}`, c.mode, req);
  if (c.mode === 'simulate') return publicSession(await sessionById(id));
  try {
    const call = await twilioRequest(c, 'POST', 'Calls.json', [
      ['To', e164(agentPhone, c)], ['From', c.from], ['Timeout', '30'],
      ['Url', `${c.publicUrl}/hooks/twilio/connect?s=${id}`], ['Method', 'POST'],
      ['StatusCallback', `${c.publicUrl}/hooks/twilio/agent?s=${id}`], ['StatusCallbackMethod', 'POST'],
      ...['initiated', 'ringing', 'answered', 'completed'].map((e) => ['StatusCallbackEvent', e]),
    ]);
    await exec('UPDATE call_sessions SET provider_sid = ? WHERE id = ?', [call.sid, id]);
  } catch (e) { await finishSession(id, 'failed'); throw e; }
  return publicSession(await sessionById(id));
}
async function hangup(user, sessionId) {
  const s = await liveSession(Number(sessionId));
  if (!s || s.user_id !== user.id) throw new HttpError(404, 'Call not found');
  if (s.status === 'ended') return publicSession(s);
  if (s.provider_sid && s.provider_sid !== 'SIM') {
    try { await twilioRequest(await cfg(), 'POST', `Calls/${s.provider_sid}.json`, [['Status', 'completed']]); }
    catch { await finishSession(s.id, s.answered_at ? 'completed' : 'canceled'); }
  } else await finishSession(s.id, s.answered_at ? 'completed' : 'canceled');
  return publicSession(await sessionById(s.id));
}

// ---------- Twilio webhooks ----------
async function verifyTwilio(req, url, params) {
  const c = await cfg();
  if (!c.token || !c.publicUrl) throw new HttpError(403, 'Telephony not configured');
  const data = c.publicUrl + url.pathname + url.search + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', c.token).update(data).digest('base64');
  if (!safeEqual(req.headers['x-twilio-signature'] || '', expected)) throw new HttpError(403, 'Bad signature');
}
const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
const FINAL = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];
const LEAD_RESULT = { busy: 'busy', 'no-answer': 'no_answer', failed: 'failed', canceled: 'no_answer' };
async function handleTwilioEvent(sub, id, p) { // returns TwiML for /connect and /dialend, otherwise null
  const s = await sessionById(id);
  if (!s) return null;
  const c = await cfg();
  if (sub === 'connect') {
    const lead = await one('SELECT phone_norm FROM leads WHERE id = ?', [s.lead_id]);
    const rec = c.record ? ` record="record-from-answer-dual" recordingStatusCallback="${c.publicUrl}/hooks/twilio/recording?s=${id}" recordingStatusCallbackEvent="completed"` : '';
    return `<Dial callerId="${xmlEsc(c.from)}" answerOnBridge="true" timeout="30"${rec} action="${c.publicUrl}/hooks/twilio/dialend?s=${id}">`
      + `<Number statusCallback="${c.publicUrl}/hooks/twilio/leg?s=${id}" statusCallbackEvent="initiated ringing answered completed">${xmlEsc(e164(lead.phone_norm, c))}</Number></Dial>`;
  }
  if (sub === 'agent') {
    if (p.CallStatus === 'in-progress' && s.status === 'dialing_agent') await exec("UPDATE call_sessions SET status = 'agent_connected' WHERE id = ?", [id]);
    else if (FINAL.includes(p.CallStatus)) await finishSession(id, s.answered_at ? 'completed' : s.status === 'dialing_agent' ? 'agent_no_answer' : 'no_answer');
  } else if (sub === 'leg') {
    if (p.CallSid && !s.lead_sid) await exec('UPDATE call_sessions SET lead_sid = ? WHERE id = ?', [p.CallSid, id]);
    if (['initiated', 'ringing'].includes(p.CallStatus) && ['dialing_agent', 'agent_connected'].includes(s.status)) {
      await exec("UPDATE call_sessions SET status = 'ringing_lead', ringing_at = ? WHERE id = ?", [now(), id]);
    } else if (p.CallStatus === 'in-progress' && s.status !== 'ended') {
      await exec("UPDATE call_sessions SET status = 'in_call', answered_at = COALESCE(answered_at, ?) WHERE id = ?", [now(), id]);
    } else if (FINAL.includes(p.CallStatus)) {
      await finishSession(id, s.answered_at || p.CallStatus === 'completed' ? 'completed' : LEAD_RESULT[p.CallStatus] || 'failed', p.CallDuration ? Number(p.CallDuration) : undefined);
    }
  } else if (sub === 'dialend') {
    if (s.status !== 'ended') await finishSession(id, s.answered_at ? 'completed' : LEAD_RESULT[p.DialCallStatus] || 'no_answer');
    return '<Hangup/>';
  } else if (sub === 'recording' && p.RecordingUrl) {
    await exec('UPDATE call_sessions SET recording_url = ?, recording_sec = ? WHERE id = ?', [p.RecordingUrl, Number(p.RecordingDuration) || null, id]);
  }
  return null;
}

// ---------- queue: what an employee sees (exactly one of THEIR leads) ----------
const PENDING = `l.status IN ('new','callback','retry') AND (l.next_action_at IS NULL OR l.next_action_at <= ?) AND (b.id IS NULL OR b.status = 'active')`;
// A lead stays locked to its employee until feedback is submitted (or management releases it). The claim is a single
// atomic statement (SKIP LOCKED + a unique index), so two quick clicks or two servers can never hand out two leads.
async function claimNext(uid) {
  const current = () => one("SELECT * FROM leads WHERE status = 'in_call' AND locked_by = ?", [uid]);
  let lead = await current();
  if (lead) return lead;
  const t = now();
  try {
    lead = (await q(`UPDATE leads SET status_before = status, status = 'in_call', locked_by = ?, locked_at = ?, updated_at = ?
      WHERE id = (SELECT l.id FROM leads l LEFT JOIN buckets b ON b.id = l.bucket_id WHERE l.assigned_to = ? AND ${PENDING}
        ORDER BY CASE l.status WHEN 'callback' THEN 0 WHEN 'retry' THEN 1 ELSE 2 END, COALESCE(l.next_action_at, l.created_at), l.id
        LIMIT 1 FOR UPDATE OF l SKIP LOCKED) RETURNING *`, [uid, t, t, uid, t]))[0];
  } catch (e) { if (e.code === '23505') return current(); throw e; }
  return lead || null;
}
function employeeLead(l, direct) { // deliberately omits phone, email and raw import columns
  const { phone, phone_norm, email, extra, status_before, locked_by, locked_at, assigned_to, bucket_id, ...rest } = l;
  const out = { ...rest, notes: scrub(l.notes) };
  if (direct) out.phone = phone;
  return out;
}
async function queueState(uid) {
  const [c, lead] = await Promise.all([cfg(), claimNext(uid)]);
  const t = now(), today = startOfToday();
  const [session, history, remaining, todayStats, me] = await Promise.all([
    lead ? one('SELECT id FROM call_sessions WHERE lead_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', [lead.id, uid]) : null,
    lead ? q('SELECT disposition, temperature, notes, created_at, follow_up_at FROM calls WHERE lead_id = ? ORDER BY id DESC', [lead.id]) : [],
    one(`SELECT COUNT(*) AS n FROM leads l LEFT JOIN buckets b ON b.id = l.bucket_id WHERE l.assigned_to = ? AND ${PENDING}`, [uid, t]),
    one(`SELECT COUNT(*) AS calls, COALESCE(SUM((disposition IN ('interested','site_visit','callback','not_interested'))::int),0) AS connected,
      COALESCE(SUM((disposition = 'site_visit')::int),0) AS site_visits FROM calls WHERE user_id = ? AND created_at >= ?`, [uid, today]),
    one('SELECT phone FROM users WHERE id = ?', [uid]),
  ]);
  return {
    lead: lead ? employeeLead(lead, c.direct) : null,
    session: session ? publicSession(await liveSession(session.id)) : null,
    telephony: { enabled: c.ready, mode: c.mode, record: c.record, direct: c.direct, agent_phone: me?.phone || null },
    history: history.map((h) => ({ ...h, notes: scrub(h.notes) })),
    remaining: remaining.n,
    today: todayStats,
  };
}

const PROFILE_FIELDS = ['name', 'purpose', 'property_type', 'bhk', 'city', 'location_pref', 'timeline'];
async function completeCall(user, body, req) {
  const c = await cfg();
  const lead = await lockedLeadFor(user, body.lead_id);
  const d = body.disposition;
  if (!DISPOSITIONS.includes(d)) throw new HttpError(400, 'Choose a call outcome');
  let followUp = null;
  if (body.follow_up_at) {
    followUp = new Date(body.follow_up_at);
    if (Number.isNaN(followUp.getTime())) throw new HttpError(400, 'Invalid follow-up time');
    followUp = followUp.toISOString();
  }
  if (d === 'callback' && !followUp) throw new HttpError(400, 'Set a callback time');
  let temp = body.temperature ? String(body.temperature) : null;
  if (temp && !TEMPS.includes(temp)) throw new HttpError(400, 'Invalid lead temperature');
  if (['interested', 'site_visit', 'callback'].includes(d) && !temp) throw new HttpError(400, 'Mark the lead Hot, Warm or Cold');
  if (d === 'not_interested') temp = 'cold';
  const remarks = clip(body.notes, 3000);
  if (CONNECTED.includes(d) && (remarks || '').length < 3) throw new HttpError(400, 'Remarks are required for a connected call');

  // Every outcome must be backed by a call placed through the CRM (employees have no other way to reach the lead).
  let session = null;
  if (body.session_id) {
    session = await sessionById(Number(body.session_id));
    if (!session || session.user_id !== user.id || session.lead_id !== lead.id) throw new HttpError(400, 'Unknown call');
    session = await liveSession(session.id);
    if (session.status !== 'ended') throw new HttpError(409, 'The call is still in progress. End it before saving.');
  }
  if (!c.direct) {
    if (!session) throw new HttpError(400, 'Place the call from the CRM first');
    if (CONNECTED.includes(d) && !(session.answered_at && session.talk_sec >= 5)) throw new HttpError(400, 'This call did not connect, so it cannot be marked as a conversation');
    if (['no_answer', 'busy', 'switched_off'].includes(d) && session.answered_at) throw new HttpError(400, `The call connected for ${session.talk_sec}s. Choose a connected outcome or wrong number`);
  }

  const attempts = lead.attempts + 1;
  let status, next = null;
  if (['no_answer', 'busy', 'switched_off'].includes(d)) {
    if (attempts >= MAX_ATTEMPTS) status = 'unreachable';
    else { status = 'retry'; next = new Date(Date.now() + RETRY_MIN * 60000).toISOString(); }
  } else if (d === 'wrong_number') status = 'invalid';
  else if (d === 'not_interested') status = 'not_interested';
  else if (followUp) { status = 'callback'; next = followUp; }
  else status = d === 'site_visit' ? 'site_visit' : d === 'interested' ? 'interested' : 'callback';

  const upd = { status, status_before: null, locked_by: null, locked_at: null, attempts, next_action_at: next, last_disposition: d, updated_at: now() };
  if (temp) upd.temperature = temp;
  for (const f of PROFILE_FIELDS) if (body[f] !== undefined) upd[f] = clip(body[f], f === 'name' ? 200 : 300) ?? (f === 'name' ? lead.name : null);
  for (const f of ['budget_min', 'budget_max']) {
    if (body[f] === undefined || body[f] === null || body[f] === '') continue;
    const n = Number(body[f]);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Invalid budget');
    upd[f] = n;
  }
  const keys = Object.keys(upd);
  await tx(async (t) => {
    await exec(`UPDATE leads SET ${keys.map((k) => k + ' = ?').join(',')} WHERE id = ?`, [...keys.map((k) => upd[k]), lead.id], t);
    const duration = session ? session.talk_sec || 0 : Math.max(0, Math.min(Number(body.duration_sec) || 0, 86400));
    await exec('INSERT INTO calls (lead_id,user_id,agent_name,disposition,temperature,notes,duration_sec,follow_up_at,created_at,session_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [lead.id, user.id, user.name, d, temp, remarks, duration, followUp, now(), session?.id ?? null], t);
  });
  await audit(user, 'call.feedback', `lead:${lead.id}`, `${d}${temp ? '/' + temp : ''}`, req);
}

// ---------- dashboard ----------
async function dashboardStats() {
  const today = startOfToday(), week = new Date(Date.now() - 7 * 86400000).toISOString(), t = now();
  const [counts, callToday, siteVisits, byStatus, bySource, byTemp, employees, riskRows, recentCalls] = await Promise.all([
    one(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status IN ('new','retry','callback')) AS pending,
      COUNT(*) FILTER (WHERE assigned_to IS NULL AND status IN ('new','retry','callback')) AS unassigned,
      COUNT(*) FILTER (WHERE status = 'in_call') AS in_call FROM leads`),
    one(`SELECT COUNT(*) AS calls, COALESCE(SUM((disposition IN ('interested','site_visit','callback','not_interested'))::int),0) AS connected,
      COALESCE(SUM(duration_sec),0) AS talk FROM calls WHERE created_at >= ?`, [today]),
    one("SELECT COUNT(*) AS n FROM calls WHERE disposition = 'site_visit'"),
    q('SELECT status, COUNT(*) AS count FROM leads GROUP BY status ORDER BY count DESC'),
    q('SELECT source, COUNT(*) AS count FROM leads GROUP BY source ORDER BY count DESC'),
    q('SELECT temperature, COUNT(*) AS count FROM leads WHERE temperature IS NOT NULL GROUP BY temperature'),
    q(`SELECT u.id, u.name, u.active, u.in_rotation,
      COALESCE(l.pending,0) AS pending, COALESCE(l.on_call,0) AS on_call, COALESCE(l.hot,0) AS hot,
      COALESCE(c.today,0) AS calls_today, COALESCE(c.total,0) AS calls_total, COALESCE(c.connected,0) AS connected,
      COALESCE(c.avg_talk,0) AS avg_talk, COALESCE(c.visits,0) AS site_visits
      FROM users u
      LEFT JOIN (SELECT assigned_to, COUNT(*) FILTER (WHERE status IN ('new','callback','retry')) AS pending, COUNT(*) FILTER (WHERE status = 'in_call') AS on_call,
        COUNT(*) FILTER (WHERE temperature = 'hot') AS hot FROM leads WHERE assigned_to IS NOT NULL GROUP BY assigned_to) l ON l.assigned_to = u.id
      LEFT JOIN (SELECT user_id, COUNT(*) FILTER (WHERE created_at >= ?) AS today, COUNT(*) AS total,
        COUNT(*) FILTER (WHERE disposition IN ('interested','site_visit','callback','not_interested')) AS connected,
        AVG(NULLIF(duration_sec,0)) AS avg_talk, COUNT(*) FILTER (WHERE disposition = 'site_visit') AS visits FROM calls GROUP BY user_id) c ON c.user_id = u.id
      WHERE u.role = 'employee' ORDER BY calls_total DESC`, [today]),
    // Unusual patterns worth a manager's attention (last 7 days)
    q(`SELECT u.id, u.name, COUNT(c.id) AS calls, COALESCE(SUM((c.disposition = 'wrong_number')::int),0) AS wrong,
      COALESCE(SUM((c.disposition IN ('interested','site_visit','callback','not_interested') AND c.duration_sec < 15)::int),0) AS short_connected,
      COALESCE(SUM((c.disposition IN ('interested','site_visit','callback','not_interested'))::int),0) AS connected
      FROM users u LEFT JOIN calls c ON c.user_id = u.id AND c.created_at >= ? WHERE u.role = 'employee' GROUP BY u.id, u.name`, [week]),
    q(`SELECT c.id, c.disposition, c.temperature, c.notes, c.created_at, c.duration_sec, s.answered_at, s.ended_at,
      s.recording_url IS NOT NULL AS has_recording, l.name AS lead, l.id AS lead_id, COALESCE(u.name, c.agent_name || ' (removed)') AS agent
      FROM calls c JOIN leads l ON l.id = c.lead_id LEFT JOIN users u ON u.id = c.user_id
      LEFT JOIN call_sessions s ON s.id = c.session_id ORDER BY c.id DESC LIMIT 8`),
  ]);
  const risk = riskRows.map((r) => {
    const flags = [];
    if (r.calls >= 10 && r.wrong / r.calls > 0.15) flags.push(`${Math.round((r.wrong / r.calls) * 100)}% wrong numbers`);
    if (r.connected >= 5 && r.short_connected / r.connected > 0.4) flags.push(`${Math.round((r.short_connected / r.connected) * 100)}% very short conversations`);
    return { id: r.id, name: r.name, calls: r.calls, flags };
  }).filter((r) => r.flags.length);
  void t;
  return {
    totalLeads: counts.total, unassigned: counts.unassigned, pending: counts.pending, inCall: counts.in_call,
    callsToday: callToday.calls, connectedToday: callToday.connected, talkSecToday: callToday.talk, siteVisits: siteVisits.n,
    byStatus, bySource, byTemp, employees, risk, recentCalls,
  };
}

module.exports = {
  CONNECTED, DISPOSITIONS, cfg, sessionById, liveSession, finishSession, startDial, hangup, verifyTwilio, handleTwilioEvent,
  claimNext, queueState, completeCall, dashboardStats, startOfToday,
};
