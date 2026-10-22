// PropCall CRM frontend.
//   employee   -> single-lead calling screen (never sees phone numbers)
//   management -> console: dashboard, leads (masked numbers), buckets & import, call log, team
//   admin      -> everything above + integrations, security & audit log
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const app = $('#app');

const OUTCOMES = [
  ['interested', 'Interested'], ['site_visit', 'Site visit booked'], ['callback', 'Call back later'], ['not_interested', 'Not interested'],
  ['no_answer', 'No answer'], ['busy', 'Busy'], ['switched_off', 'Switched off'], ['wrong_number', 'Wrong number'],
];
const CONNECTED = ['interested', 'site_visit', 'callback', 'not_interested'];
const STATUS_LABEL = {
  new: 'New', retry: 'Retry', callback: 'Callback', interested: 'Interested', site_visit: 'Site visit', not_interested: 'Not interested',
  invalid: 'Wrong number', unreachable: 'Unreachable', in_call: 'In call',
};
const SOURCES = { excel: 'Excel', google: 'Google', google_sheet: 'Google Sheet', meta: 'Meta', '99acres': '99acres', magicbricks: 'MagicBricks',
  housing: 'Housing.com', website: 'Website', referral: 'Referral', walk_in: 'Walk-in', manual: 'Manual', other: 'Other' };
const PROPERTY_TYPES = ['Apartment', 'Villa', 'Plot', 'Commercial', 'Other'];
const TIMELINES = ['Immediate', '1-3 months', '3-6 months', '6+ months', 'Just exploring'];
const PURPOSES = ['Buy', 'Rent', 'Invest'];
const TEMPS = [['hot', 'Hot'], ['warm', 'Warm'], ['cold', 'Cold']];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const srcLabel = (s) => SOURCES[s] || String(s || 'other').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const lakh = (n) => (n == null || n === '' ? '' : +(n / 1e5).toFixed(2));
const inr = (n) => {
  if (n == null) return '';
  if (n >= 1e7) return '₹' + +(n / 1e7).toFixed(2) + ' Cr';
  if (n >= 1e5) return '₹' + +(n / 1e5).toFixed(2) + ' L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};
const budgetText = (l) => (l.budget_min && l.budget_max && l.budget_min !== l.budget_max ? `${inr(l.budget_min)} – ${inr(l.budget_max)}` : inr(l.budget_max || l.budget_min));
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '…');
const fmtSec = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const opts = (list, sel, blank) => (blank ? `<option value="">${blank}</option>` : '') +
  list.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(l)}</option>`; }).join('');
const pill = (cls, text) => `<span class="pill s-${cls}">${esc(text)}</span>`;
const tempPill = (t) => (t ? pill(t, t[0].toUpperCase() + t.slice(1)) : '<span class="sub">—</span>');
const outcomeLabel = (v) => (OUTCOMES.find((o) => o[0] === v) || [0, v])[1];

const state = { user: null, view: 'dashboard', theme: localStorage.getItem('crm_theme') || 'light' };
document.documentElement.dataset.theme = state.theme;

// ---------- API / helpers ----------
async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method, headers: { 'Content-Type': 'application/json', 'X-CRM': '1' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user) { showLogin('Your session ended. Please sign in again.'); throw new Error('Session ended'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = 'toast'), 3200);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('crm_theme', state.theme); document.documentElement.dataset.theme = state.theme;
}

// ---------- auth ----------
let pollTimer, timerInt;
const stopTimers = () => { clearTimeout(pollTimer); clearInterval(timerInt); };
async function logout() {
  stopTimers();
  await api('POST', '/auth/logout').catch(() => {});
  showLogin();
}
function showLogin(message) {
  stopTimers(); state.user = null; $('#modal-root').innerHTML = '';
  app.innerHTML = `<div class="login-wrap"><form class="tile login" id="login-form">
    <h1>PropCall</h1><p>${esc(message || 'Sign in to continue')}</p>
    <input class="field" name="email" type="email" placeholder="Email" required autofocus autocomplete="username">
    <input class="field" name="password" type="password" placeholder="Password" required autocomplete="current-password">
    <button class="btn primary">Sign in</button></form></div>`;
  $('#login-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    const r = await api('POST', '/auth/login', Object.fromEntries(new FormData(e.target)));
    state.user = r.user; state.view = 'dashboard';
    start();
  });
}
function renderChangePassword() {
  stopTimers();
  app.innerHTML = `<div class="login-wrap"><form class="tile login" id="pw-form">
    <h1>Change password</h1><p>Optional. Choose a new password whenever you like.</p>
    <input class="field" name="current" type="password" placeholder="Current password" required autocomplete="current-password">
    <input class="field" name="password" type="password" placeholder="New password (8+, letters and numbers)" required minlength="8" autocomplete="new-password">
    <input class="field" name="confirm" type="password" placeholder="Repeat new password" required autocomplete="new-password">
    <button class="btn primary">Save password</button><button type="button" class="link" id="pw-out">Cancel</button></form></div>`;
  $('#pw-out').onclick = () => start();
  $('#pw-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (fd.password !== fd.confirm) throw new Error('The new passwords do not match');
    await api('POST', '/auth/password', { current: fd.current, password: fd.password });
    toast('Password updated'); start();
  });
}
const start = () => (state.user.role === 'employee' ? renderEmployee() : renderConsole());

// ---------- modal ----------
function openModal(title, bodyHtml, onSubmit, onDelete, wide) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><form class="tile modal ${wide ? 'wide' : ''}"><h2>${title}</h2>${bodyHtml}
    <div class="modal-actions">${onDelete ? '<button type="button" class="btn danger" id="m-del" style="margin-right:auto">Delete</button>' : ''}
    <button type="button" class="btn" id="m-cancel">Cancel</button><button class="btn primary">Save</button></div></form></div>`;
  const close = () => (root.innerHTML = '');
  $('.overlay', root).onmousedown = (e) => { if (e.target.classList.contains('overlay')) close(); };
  $('#m-cancel').onclick = close;
  if (onDelete) $('#m-del').onclick = guard(async () => { if (confirm('Delete permanently?')) { await onDelete(); close(); } });
  $('form', root).onsubmit = guard(async (e) => { e.preventDefault(); await onSubmit(Object.fromEntries(new FormData(e.target))); close(); });
  const first = $('input:not([type=hidden]),select,textarea', root); if (first) first.focus();
  return close;
}
const input = (name, label, v = '', type = 'text', extra = '') =>
  `<div><label>${label}</label><input class="field" name="${name}" type="${type}" value="${esc(v)}" ${extra}></div>`;
const select = (name, label, list, v, blank) => `<div><label>${label}</label><select class="field" name="${name}">${opts(list, v, blank)}</select></div>`;

// =====================================================================
// EMPLOYEE: one assigned lead at a time, calls only through the CRM
// =====================================================================
const CALL_STATE = { dialing_agent: 'Calling your phone… pick up to connect', agent_connected: 'Connected. Dialling the lead…', ringing_lead: 'Ringing the lead…', in_call: 'On call' };
const END_TEXT = {
  busy: 'The lead’s line was busy', no_answer: 'The lead did not answer', failed: 'The call could not be placed',
  agent_no_answer: 'Your phone did not pick up. Try again.', canceled: 'Call cancelled before the lead answered',
};
function phoneModal(done) {
  openModal('Your phone number', `<p class="sub" style="margin-top:0">When you tap <b>Call now</b>, we ring this number first and then connect the lead. This is your own number; the lead's number is never shown.</p>
    ${input('phone', 'Your mobile number', state.user.phone, 'tel', 'required pattern="[0-9 +\\-]{10,16}"')}`,
  async (fd) => { const me = await api('PATCH', '/me', { phone: fd.phone }); state.user.phone = me.phone; toast('Phone saved'); done?.(); });
}
function renderEmployee() {
  stopTimers();
  app.innerHTML = `<div class="agent-shell"><header class="agent-top">
      <div class="brand"><div class="logo"></div>PropCall</div><div class="agent-stats" id="astats"></div>
      <div class="actions"><span class="sub">${esc(state.user.name)}</span><span id="demo"></span>
        <button class="btn sm" id="myphone" hidden></button>
        <button class="btn sm" id="theme">${state.theme === 'dark' ? 'Light' : 'Dark'}</button><button class="btn sm" id="logout">Sign out</button></div>
    </header><div id="stage"></div></div>`;
  $('#logout').onclick = () => logout();
  $('#theme').onclick = () => { toggleTheme(); renderEmployee(); };
  guard(() => loadQueue())();
}
async function loadQueue(data) {
  stopTimers();
  const r = data || (await api('GET', '/queue/current'));
  $('#astats').innerHTML = `<span><b>${r.today.calls}</b> calls</span><span><b>${r.today.connected}</b> connected</span>
    <span><b>${r.today.site_visits}</b> site visits</span><span><b>${r.remaining}</b> in your queue</span>`;
  $('#demo').innerHTML = r.telephony.mode === 'simulate' ? '<span class="demo-tag" title="Calls are simulated. An admin can connect a real phone service.">Demo calling</span>' : '';
  const mp = $('#myphone');
  mp.hidden = r.telephony.mode !== 'twilio';
  mp.textContent = state.user.phone ? 'My phone ' + state.user.phone : 'Set my phone';
  mp.onclick = () => phoneModal(() => (mp.textContent = 'My phone ' + state.user.phone));
  if (!r.lead) {
    $('#stage').innerHTML = `<div class="tile empty-state"><h2>You're all caught up</h2>
      <p class="sub">No leads are waiting for you right now. New leads and your scheduled callbacks appear here automatically.</p>
      <button class="btn primary" id="refresh">Check for leads</button></div>`;
    $('#refresh').onclick = guard(() => loadQueue());
    pollTimer = setTimeout(() => guard(() => loadQueue())(), 30000);
    return;
  }
  renderCall(r);
}
function renderCall({ lead: l, history, telephony, session }) {
  const live = telephony.enabled;
  const facts = [
    ['City', l.city], ['Looking to', l.purpose], ['Property', [l.property_type, l.bhk].filter(Boolean).join(' · ')],
    ['Budget', budgetText(l)], ['Location', l.location_pref], ['Timeline', l.timeline], ['Received', when(l.created_at)],
  ].filter(([, v]) => v);
  const direct = !!l.phone; // only when an admin enabled the insecure direct-dial option
  $('#stage').innerHTML = `<div class="call-grid">
    <section class="tile lead-card">
      <div class="meta-row"><span class="badge">${esc(srcLabel(l.source))}</span>${l.campaign ? `<span class="sub">${esc(l.campaign)}</span>` : ''}
        ${l.temperature ? tempPill(l.temperature) : ''}<span class="sub" style="margin-left:auto">Attempt ${l.attempts + 1}</span></div>
      <h1 class="lead-name">${esc(l.name)}</h1>
      ${direct ? `<a class="dial" href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}">${esc(l.phone)}</a>`
        : '<div class="hidden-num"><span>•••• ••• •••</span><small>Number is protected. Calls are placed through PropCall.</small></div>'}
      ${live ? `<div class="callbar"><button class="btn primary big" id="callbtn" type="button">Call now</button>
        <button class="btn danger big" id="endbtn" type="button" hidden>End call</button>
        <div class="callinfo"><div id="callstate" class="sub">Ready. ${telephony.mode === 'twilio' ? 'We ring your phone first, then connect the lead.' : 'Demo mode: the call is simulated.'}</div>
        <div class="timer big-timer" id="timer"></div></div></div>
        ${telephony.record ? '<div class="sub">This call is recorded.</div>' : ''}`
        : '<div class="notice" style="margin:8px 0 16px">Calling isn’t set up yet. Please ask your admin to enable the phone service.</div>'}
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      ${l.notes ? `<div class="quote">${esc(l.notes)}</div>` : ''}
      ${history.length ? `<h3 class="hist-title">Previous calls</h3>${history.map((h) => `<div class="hist">
        <div>${pill(h.disposition, outcomeLabel(h.disposition))} ${h.temperature ? tempPill(h.temperature) : ''} <span class="sub">${when(h.created_at)}</span></div>
        ${h.notes ? `<div class="sub">${esc(h.notes)}</div>` : ''}</div>`).join('')}` : ''}
    </section>
    <form class="tile" id="callform">
      <h3>How did the call go?</h3>
      <div class="chips" id="outcomes">${OUTCOMES.map(([v, t]) => `<label class="chip"><input type="radio" name="disposition" value="${v}" required><span>${t}</span></label>`).join('')}</div>
      <div id="temp" hidden style="margin-top:16px"><label>Lead status</label>
        <div class="chips tchips">${TEMPS.map(([v, t]) => `<label class="chip t-${v}"><input type="radio" name="temperature" value="${v}" ${l.temperature === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div></div>
      <div id="fu" hidden class="form-grid" style="margin-top:16px">
        <div class="full"><label id="fu-label">Follow-up time</label><input class="field" type="datetime-local" name="follow_up_at"></div></div>
      <div id="qual" hidden>
        <h3 style="margin:22px 0 12px">Requirement</h3>
        <div class="form-grid">
          ${input('name', 'Name', l.name)}${select('purpose', 'Looking to', PURPOSES, l.purpose, '—')}
          ${select('property_type', 'Property type', PROPERTY_TYPES, l.property_type, '—')}${input('bhk', 'BHK / size', l.bhk)}
          ${input('city', 'City', l.city)}${select('timeline', 'Buying timeline', TIMELINES, l.timeline, '—')}
          ${input('budget_min', 'Budget min (₹ lakh)', lakh(l.budget_min), 'number', 'min="0" step="any"')}${input('budget_max', 'Budget max (₹ lakh)', lakh(l.budget_max), 'number', 'min="0" step="any"')}
          <div class="full">${input('location_pref', 'Preferred location', l.location_pref)}</div>
        </div></div>
      <div style="margin-top:18px"><label id="rem-label">Remarks</label><textarea class="field" name="notes" placeholder="What did they say? Next step?"></textarea></div>
      <div class="modal-actions"><span class="sub" style="margin-right:auto">Ctrl + Enter to save</span>
        <button class="btn primary" id="save">Save &amp; next lead →</button></div>
    </form></div>`;

  const form = $('#callform');
  let sess = null, skew = 0;
  if (live) {
    const paint = (s) => {
      sess = s; skew = Date.parse(s.server_now) - Date.now();
      const active = s.status !== 'ended';
      $('#callbtn').hidden = active; $('#endbtn').hidden = !active;
      $('#callbtn').textContent = 'Call again';
      $('#callstate').textContent = active ? CALL_STATE[s.status] : s.end_reason === 'completed' ? 'Call ended. Record the outcome below.' : END_TEXT[s.end_reason] || 'Call ended';
      if (!active) {
        clearInterval(timerInt);
        $('#timer').textContent = s.talk_sec ? `Talk time ${fmtSec(s.talk_sec)}` : '';
        const auto = { busy: 'busy', no_answer: 'no_answer' }[s.end_reason];
        if (auto && !form.disposition.value) {
          const radio = $(`input[name=disposition][value=${auto}]`, form);
          radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    };
    const tick = guard(async () => {
      if (!sess || sess.status === 'ended') return clearInterval(timerInt);
      if (sess.status === 'in_call') $('#timer').textContent = fmtSec(Math.max(0, Math.floor((Date.now() + skew - Date.parse(sess.answered_at)) / 1000)));
      paint(await api('GET', `/queue/session/${sess.id}`));
    });
    const watch = () => { clearInterval(timerInt); timerInt = setInterval(tick, 1000); };
    $('#callbtn').onclick = guard(async () => {
      if (telephony.mode === 'twilio' && !state.user.phone) return phoneModal(() => $('#callbtn').click());
      $('#callbtn').disabled = true;
      try { $('#timer').textContent = ''; paint(await api('POST', '/queue/dial', { lead_id: l.id })); watch(); }
      finally { $('#callbtn').disabled = false; }
    });
    $('#endbtn').onclick = guard(async () => { $('#endbtn').disabled = true; try { paint(await api('POST', '/queue/hangup', { session_id: sess.id })); } finally { $('#endbtn').disabled = false; } });
    if (session) { paint(session); if (session.status !== 'ended') watch(); }
  }

  form.onchange = () => {
    const d = form.disposition.value;
    $('#qual').hidden = !CONNECTED.includes(d);
    $('#temp').hidden = !['interested', 'site_visit', 'callback'].includes(d);
    $('#fu').hidden = !['interested', 'site_visit', 'callback'].includes(d);
    form.follow_up_at.required = d === 'callback';
    $('#fu-label').textContent = d === 'site_visit' ? 'Site visit date & time' : d === 'callback' ? 'Call back at (required)' : 'Follow-up call (optional)';
    form.notes.required = CONNECTED.includes(d);
    $('#rem-label').textContent = CONNECTED.includes(d) ? 'Remarks (required)' : 'Remarks';
  };
  form.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); };
  form.onsubmit = guard(async (e) => {
    e.preventDefault();
    const btn = $('#save');
    const fd = Object.fromEntries(new FormData(form));
    const d = fd.disposition;
    if (['interested', 'site_visit', 'callback'].includes(d) && !fd.temperature) throw new Error('Mark the lead Hot, Warm or Cold');
    const payload = { lead_id: l.id, disposition: d, notes: fd.notes };
    if (sess) payload.session_id = sess.id;
    if (!$('#temp').hidden && fd.temperature) payload.temperature = fd.temperature;
    if (!$('#fu').hidden && fd.follow_up_at) payload.follow_up_at = new Date(fd.follow_up_at).toISOString();
    if (CONNECTED.includes(d)) {
      for (const f of ['name', 'purpose', 'property_type', 'bhk', 'city', 'location_pref', 'timeline']) payload[f] = fd[f];
      for (const f of ['budget_min', 'budget_max']) if (fd[f] !== '') payload[f] = Number(fd[f]) * 1e5;
    }
    btn.disabled = true;
    try { await loadQueue(await api('POST', '/queue/complete', payload)); toast('Saved. Next lead loaded'); window.scrollTo(0, 0); }
    finally { btn.disabled = false; }
  });
}

// =====================================================================
// CONSOLE (management + admin)
// =====================================================================
const NAV_MGMT = [['dashboard', 'Dashboard'], ['leads', 'Leads'], ['buckets', 'Buckets & import'], ['calls', 'Call log'], ['team', 'Team']];
const NAV_ADMIN = [['integrations', 'Integrations'], ['security', 'Security & audit']];
const isAdmin = () => state.user.role === 'admin';
function renderConsole() {
  const nav = [...NAV_MGMT, ...(isAdmin() ? NAV_ADMIN : [])];
  if (!nav.some(([k]) => k === state.view)) state.view = 'dashboard';
  app.innerHTML = `<div class="shell"><aside class="sidebar">
      <div class="brand"><div class="logo"></div>PropCall</div>
      ${nav.map(([k, l]) => `<button class="nav-btn ${state.view === k ? 'active' : ''}" data-view="${k}">${l}</button>`).join('')}
      <div class="spacer"></div>
      <div class="user-box"><b>${esc(state.user.name)}</b>${esc(state.user.email)}<br><span class="role-tag">${state.user.role}</span></div>
      <button class="nav-btn" id="chpw">Change password</button>
      <button class="nav-btn" id="theme">${state.theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
      <button class="nav-btn" id="logout">Sign out</button></aside><main id="main"></main></div>`;
  $$('[data-view]').forEach((b) => (b.onclick = () => { state.view = b.dataset.view; renderConsole(); }));
  $('#logout').onclick = () => logout();
  $('#chpw').onclick = () => renderChangePassword();
  $('#theme').onclick = () => { toggleTheme(); renderConsole(); };
  guard(views[state.view])();
}
let usersCache = [];
const loadUsers = async () => (usersCache = await api('GET', '/users'));
const employees = () => usersCache.filter((u) => u.role === 'employee' && u.active);
const empOpts = (sel, blank) => opts(employees().map((u) => [String(u.id), u.name]), String(sel ?? ''), blank);

const bars = (rows, key, labelFn) => {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return rows.length ? rows.map((r) => `<div class="bar-row"><span>${esc(labelFn(r[key]))}</span>
    <div class="track"><div class="fill" style="width:${(r.count / max) * 100}%"></div></div><span>${r.count}</span></div>`).join('') : '<div class="sub">No data yet</div>';
};
const callMeta = (c) => (c.answered_at ? `Call ${clock(c.answered_at)} → ${clock(c.ended_at)} · ${fmtSec(c.duration_sec || 0)}` : c.duration_sec ? `Call ${fmtSec(c.duration_sec)}` : '');
const recBtn = (c) => (c.has_recording ? ` <button type="button" class="btn sm" data-rec="${c.id}">Play recording</button>` : '');
document.addEventListener('click', (e) => { // recordings stream from an authenticated endpoint
  const b = e.target.closest('[data-rec]');
  if (!b) return;
  const a = document.createElement('audio');
  a.controls = true; a.autoplay = true; a.src = `/api/calls/${b.dataset.rec}/recording`;
  a.onerror = () => toast('Recording is not available', true);
  b.replaceWith(a);
});

const views = {
  async dashboard() {
    const s = await api('GET', '/stats');
    const rate = s.callsToday ? Math.round((s.connectedToday / s.callsToday) * 100) + '%' : '—';
    const t = Object.fromEntries(s.byTemp.map((x) => [x.temperature, x.count]));
    $('#main').innerHTML = `<div class="topbar"><h1>Dashboard</h1></div>
      <div class="bento">
        <div class="tile t-lime"><div class="eyebrow">Waiting to be called</div><div class="num">${s.pending}</div><div class="note">${s.unassigned} unassigned · ${s.inCall} on a call now</div></div>
        <div class="tile"><div class="eyebrow">Calls today</div><div class="num">${s.callsToday}</div><div class="note sub">${rate} connected</div></div>
        <div class="tile"><div class="eyebrow">Talk time today</div><div class="num">${Math.round(s.talkSecToday / 60)}<span class="unit"> min</span></div><div class="note sub">${s.siteVisits} site visits booked in total</div></div>
        <div class="tile"><div class="eyebrow">Lead status</div>
          <div class="temps"><div><b class="tc-hot">${t.hot || 0}</b>Hot</div><div><b class="tc-warm">${t.warm || 0}</b>Warm</div><div><b class="tc-cold">${t.cold || 0}</b>Cold</div></div></div>
        <div class="tile span-2"><h3>Employees</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>Employee</th><th>Queue</th><th>Today</th><th>Connected</th><th>Avg talk</th><th>Hot</th><th>Visits</th></tr></thead><tbody>
          ${s.employees.map((a) => `<tr><td>${esc(a.name)}${a.active ? '' : ' <span class="sub">(inactive)</span>'}${a.on_call ? ' <span class="live-dot" title="On a lead"></span>' : ''}</td><td>${a.pending}</td><td>${a.calls_today}</td>
            <td>${a.calls_total ? Math.round((a.connected / a.calls_total) * 100) + '%' : '—'}</td><td>${a.avg_talk ? fmtSec(Math.round(a.avg_talk)) : '—'}</td><td>${a.hot}</td><td>${a.site_visits}</td></tr>`).join('')}
        </tbody></table></div></div>
        <div class="tile span-2"><h3>Needs a look (last 7 days)</h3>
          ${s.risk.length ? s.risk.map((r) => `<div class="hist"><b>${esc(r.name)}</b> <span class="sub">${r.calls} calls</span><div class="flag">${r.flags.map(esc).join(' · ')}</div></div>`).join('')
            : '<div class="sub">Nothing unusual. Flags appear for high wrong-number rates or very short “conversations”.</div>'}</div>
        <div class="tile span-2"><h3>Leads by source</h3>${bars(s.bySource, 'source', srcLabel)}</div>
        <div class="tile span-2"><h3>Leads by status</h3>${bars(s.byStatus, 'status', (k) => STATUS_LABEL[k] || k)}</div>
        <div class="tile span-4"><h3>Recent calls</h3>${s.recentCalls.map((c) => `<div class="hist"><div><a href="#" data-lead="${c.lead_id}"><b>${esc(c.lead)}</b></a>
          ${pill(c.disposition, outcomeLabel(c.disposition))} ${c.temperature ? tempPill(c.temperature) : ''}
          <span class="sub">${esc(c.agent || '')} · ${when(c.created_at)}</span>${recBtn(c)}</div>${callMeta(c) ? `<div class="sub">${callMeta(c)}</div>` : ''}${c.notes ? `<div class="sub">${esc(c.notes)}</div>` : ''}</div>`).join('') || '<div class="sub">No calls yet</div>'}</div>
      </div>`;
    $$('[data-lead]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); guard(() => openLead(a.dataset.lead))(); }));
  },

  async leads() {
    const [, buckets] = await Promise.all([loadUsers(), api('GET', '/buckets')]);
    const f = (views.leads.f ||= { q: '', status: '', source: '', temperature: '', bucket_id: '', assigned_to: '', page: 1 });
    const selected = new Set();
    let allMatching = false, lastTotal = 0; // "select all N results" works across pages (up to 100,000)
    $('#main').innerHTML = `<div class="topbar"><h1>Leads</h1><button class="btn primary" id="add">+ Add lead</button></div>
      <div class="filters">
        <input class="field search" id="q" placeholder="${isAdmin() ? 'Search name, phone, email, city…' : 'Search name, city, campaign…'}" value="${esc(f.q)}">
        <select class="field" id="fs">${opts(Object.entries(STATUS_LABEL), f.status, 'All statuses')}</select>
        <select class="field" id="ft">${opts(TEMPS, f.temperature, 'Hot / Warm / Cold')}</select>
        <select class="field" id="fsrc">${opts(Object.entries(SOURCES), f.source, 'All sources')}</select>
        <select class="field" id="fb">${opts(buckets.map((b) => [String(b.id), b.name]), f.bucket_id, 'All buckets')}</select>
        <select class="field" id="fa">${opts([['none', 'Unassigned'], ...usersCache.filter((u) => u.role === 'employee').map((u) => [String(u.id), u.name])], f.assigned_to, 'All employees')}</select></div>
      <div class="bulk" id="bulk" hidden><b id="bcount"></b><button class="btn sm" id="ball" hidden></button>
        <select class="field" id="bassign" style="width:180px">${empOpts('', 'Assign to…')}</select>
        <button class="btn sm" id="bapply">Assign</button><button class="btn sm" id="bdist">Round-robin</button><button class="btn sm" id="brequeue">Requeue</button>
        <button class="btn sm" id="brelease">Release lock</button>${isAdmin() ? '<button class="btn sm danger" id="bdel">Delete</button>' : ''}</div>
      <div class="tile table-tile"><div class="table-wrap"><table class="tbl"><thead><tr><th><input type="checkbox" id="all"></th><th>Lead</th><th>Source / bucket</th><th>Lead status</th><th>Pipeline</th><th>Assigned</th><th>Tries</th><th>Next call</th></tr></thead>
        <tbody id="rows"></tbody></table></div><div class="pager" id="pager"></div></div>`;

    const draw = async () => {
      const { rows, total } = await api('GET', '/leads?' + new URLSearchParams({ ...f, limit: 50 }));
      selected.clear(); allMatching = false; lastTotal = total; syncBulk();
      $('#rows').innerHTML = rows.length ? rows.map((l) => `<tr data-id="${l.id}"><td><input type="checkbox" data-sel="${l.id}"></td>
        <td><b>${esc(l.name)}</b><div class="sub">${esc(l.phone)}${l.city ? ' · ' + esc(l.city) : ''}</div></td>
        <td>${esc(srcLabel(l.source))}<div class="sub">${esc(l.bucket || '')}</div></td>
        <td>${tempPill(l.temperature)}</td><td>${pill(l.status, STATUS_LABEL[l.status] || l.status)}</td><td>${esc(l.assignee || '—')}</td><td>${l.attempts}</td>
        <td class="sub">${when(l.next_action_at) || '—'}</td></tr>`).join('')
        : '<tr><td colspan="8" class="empty">No leads match</td></tr>';
      const pages = Math.max(1, Math.ceil(total / 50));
      $('#pager').innerHTML = `<span class="sub">${total} leads</span><span><button class="btn sm" id="prev" ${f.page <= 1 ? 'disabled' : ''}>Prev</button>
        <span class="sub"> ${f.page} / ${pages} </span><button class="btn sm" id="next" ${f.page >= pages ? 'disabled' : ''}>Next</button></span>`;
      $('#prev').onclick = () => { f.page--; guard(draw)(); };
      $('#next').onclick = () => { f.page++; guard(draw)(); };
      $$('#rows tr[data-id]').forEach((tr) => (tr.onclick = (e) => { if (!e.target.matches('input')) guard(() => openLead(tr.dataset.id))(); }));
      $$('[data-sel]').forEach((c) => (c.onchange = () => { c.checked ? selected.add(+c.dataset.sel) : selected.delete(+c.dataset.sel); syncBulk(); }));
    };
    function syncBulk() {
      $('#bulk').hidden = !selected.size && !allMatching;
      $('#bcount').textContent = allMatching ? `All ${lastTotal} matching leads selected` : `${selected.size} selected`;
      const all = $('#ball'); all.hidden = allMatching || selected.size < 2 || lastTotal <= selected.size;
      all.textContent = `Select all ${lastTotal} matching`;
    }
    const reload = () => { f.page = 1; guard(draw)(); };
    let timer; $('#q').oninput = (e) => { f.q = e.target.value; clearTimeout(timer); timer = setTimeout(reload, 250); };
    for (const [id, key] of [['fs', 'status'], ['ft', 'temperature'], ['fsrc', 'source'], ['fb', 'bucket_id'], ['fa', 'assigned_to']]) $('#' + id).onchange = (e) => { f[key] = e.target.value; reload(); };
    $('#ball').onclick = () => { allMatching = true; syncBulk(); };
    $('#all').onchange = (e) => $$('[data-sel]').forEach((c) => { c.checked = e.target.checked; c.onchange(); });
    $('#add').onclick = () => leadForm();
    const bulk = (action, extra = {}, confirmMsg) => guard(async () => {
      if (confirmMsg && !confirm(confirmMsg)) return;
      await api('POST', '/leads/bulk', { ...(allMatching ? { filter: { ...f, page: undefined } } : { ids: [...selected] }), action, ...extra }); toast('Done'); await draw();
    });
    $('#bapply').onclick = () => { const v = $('#bassign').value; if (!v) return toast('Choose an employee', true); bulk('assign', { assigned_to: v })(); };
    $('#bdist').onclick = bulk('distribute', {}, 'Hand the selected leads out round-robin?');
    $('#brequeue').onclick = bulk('requeue', {}, 'Reset selected leads to New with 0 attempts?');
    $('#brelease').onclick = bulk('release');
    if (isAdmin()) $('#bdel').onclick = () => bulk('delete', {}, `Delete ${allMatching ? lastTotal : selected.size} lead(s) permanently?`)();
    views.leads.refresh = draw;
    await draw();
  },

  async buckets() {
    await loadUsers();
    const bks = await api('GET', '/buckets');
    const srcOpts = (sel) => opts(Object.entries(SOURCES).filter(([k]) => !['manual', 'google_sheet'].includes(k)), sel);
    const distro = `<div class="distro"><label>Distribute to</label>
      <label class="radio"><input type="radio" name="mode" value="round_robin" checked> Round-robin, all employees who are available</label>
      <label class="radio"><input type="radio" name="mode" value="selected"> Round-robin, only selected employees</label>
      <div class="pool" id="pool" hidden>${employees().map((u) => `<label class="radio"><input type="checkbox" name="pool" value="${u.id}"> ${esc(u.name)}</label>`).join('')}</div>
      <label class="radio"><input type="radio" name="mode" value="unassigned"> Keep unassigned (assign later)</label></div>`;
    $('#main').innerHTML = `<div class="topbar"><h1>Buckets &amp; import</h1></div>
      <div class="bento">
        <div class="tile span-2"><h3>New bucket from Excel / CSV</h3>
          <div class="form-grid"><div class="full"><label>Bucket name</label><input class="field" id="ibname" placeholder="e.g. Diwali expo – Excel"></div>
            <div><label>Lead source</label><select class="field" id="isrc">${srcOpts('excel')}</select></div></div>
          <label style="margin-top:16px">File (.xlsx, .xls, .csv)</label>
          <input class="field" type="file" id="file" accept=".xlsx,.xls,.csv">
          <div id="preview" class="sub" style="margin-top:12px"></div>${distro}
          <div class="modal-actions"><button class="btn primary" id="go" disabled>Import into bucket</button></div></div>
        <div class="tile span-2"><h3>New bucket from a Google Sheet link</h3>
          <p class="sub">Share the sheet as <b>Anyone with the link → Viewer</b>. The first row must be headers.</p>
          <div class="form-grid"><div class="full"><label>Sheet URL</label><input class="field" id="gurl" placeholder="https://docs.google.com/spreadsheets/d/…"></div>
            <div><label>Bucket name</label><input class="field" id="gbname" placeholder="e.g. Google Sheet – Oct"></div>
            <div><label>Lead source</label><select class="field" id="gsrc">${srcOpts('google')}</select></div></div>
          <div class="modal-actions"><button class="btn primary" id="ggo">Import sheet</button></div>
          <div id="result" class="sub" style="margin-top:12px">Nothing imported yet.</div>
          <p class="sub" style="margin-top:12px">Columns are detected from headers like <b>Name, Phone / Mobile, Email, City, Budget, BHK, Location, Campaign, Message</b>. Budgets such as “50-80 lakh” or “1.2 cr” are understood. Duplicate numbers are skipped.</p></div>
        <div class="tile table-tile span-4"><div class="table-wrap"><table class="tbl"><thead><tr><th>Bucket</th><th>Source</th><th>Leads</th><th>Pending</th><th>Called</th><th>Hot</th><th>Warm</th><th>Cold</th><th>Unassigned</th><th></th></tr></thead><tbody>
          ${bks.map((b) => `<tr><td><b>${esc(b.name)}</b><div class="sub">${when(b.created_at)}${b.status === 'paused' ? ' · paused' : ''}</div></td><td>${esc(srcLabel(b.source))}</td><td>${b.total}</td><td>${b.pending}</td><td>${b.called}</td>
            <td class="tc-hot">${b.hot}</td><td class="tc-warm">${b.warm}</td><td class="tc-cold">${b.cold}</td><td>${b.unassigned}</td>
            <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-view-b="${b.id}">View</button>
              ${b.unassigned ? `<button class="btn sm" data-dist="${b.id}">Distribute</button>` : ''}
              <button class="btn sm" data-toggle="${b.id}" data-st="${b.status}">${b.status === 'active' ? 'Pause' : 'Resume'}</button></td></tr>`).join('') || '<tr><td colspan="10" class="empty">No buckets yet. Import a file to create one.</td></tr>'}
        </tbody></table></div></div></div>`;
    const syncPool = () => { $('#pool').hidden = $('input[name=mode]:checked').value !== 'selected'; };
    $$('input[name=mode]').forEach((r) => (r.onchange = syncPool));
    const dist = () => {
      const mode = $('input[name=mode]:checked').value, pool = $$('input[name=pool]:checked').map((c) => +c.value);
      if (mode === 'selected' && !pool.length) throw new Error('Tick at least one employee');
      return { mode, pool };
    };
    const showResult = (r) => {
      $('#result').innerHTML = `<div class="result-nums"><div><b>${r.inserted}</b> added</div><div><b>${r.assigned}</b> assigned</div><div><b>${r.duplicates}</b> duplicates</div><div><b>${r.invalid}</b> invalid</div></div>` +
        (r.errors?.length ? `<div class="sub" style="margin-top:8px">${r.errors.map(esc).join('<br>')}</div>` : '');
    };
    let rows = [];
    $('#file').onchange = guard(async (e) => {
      const file = e.target.files[0]; rows = []; $('#go').disabled = true;
      if (!file) return;
      if (!$('#ibname').value) $('#ibname').value = file.name.replace(/\.[^.]+$/, '');
      $('#preview').textContent = 'Reading file…';
      if (!window.XLSX) await new Promise((res, rej) => {
        const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = res; s.onerror = () => rej(new Error('Could not load the spreadsheet reader (check your internet connection)')); document.head.append(s);
      });
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
      if (!rows.length) { $('#preview').textContent = 'No data rows found.'; return; }
      $('#preview').innerHTML = `<b>${rows.length}</b> rows · columns: ${Object.keys(rows[0]).map(esc).join(', ')}`;
      $('#go').disabled = false;
    });
    $('#go').onclick = guard(async () => {
      const total = { inserted: 0, assigned: 0, duplicates: 0, invalid: 0, errors: [] }, d = dist();
      $('#go').disabled = true;
      try {
        // Chunks are capped by rows (1,500) and by size (~2.5 MB), so even very wide sheets stay under hosting request limits.
        for (let i = 0; i < rows.length;) {
          let size = 0, j = i;
          while (j < rows.length && j - i < 1500 && (size += JSON.stringify(rows[j]).length) < 2.5e6) j++;
          if (j === i) j = i + 1;
          const r = await api('POST', '/leads/import', { source: $('#isrc').value, bucket_name: $('#ibname').value, ...d, rows: rows.slice(i, j) });
          for (const k of ['inserted', 'assigned', 'duplicates', 'invalid']) total[k] += r[k];
          total.errors.push(...r.errors.map((m) => m.replace(/Row (\d+)/, (_, n) => 'Row ' + (+n + i))));
          i = j;
          $('#result').textContent = `Importing… ${i} / ${rows.length}`;
        }
        showResult(total); toast(`${total.inserted} leads added`);
      } finally { $('#go').disabled = false; }
      views.buckets();
    });
    $('#ggo').onclick = guard(async () => {
      const d = dist();
      $('#ggo').disabled = true;
      try { const r = await api('POST', '/leads/import-url', { url: $('#gurl').value, source: $('#gsrc').value, bucket_name: $('#gbname').value, ...d }); showResult(r); toast(`${r.inserted} leads added`); }
      finally { $('#ggo').disabled = false; }
    });
    $$('[data-toggle]').forEach((b) => (b.onclick = guard(async () => { await api('PATCH', `/buckets/${b.dataset.toggle}`, { status: b.dataset.st === 'active' ? 'paused' : 'active' }); views.buckets(); })));
    $$('[data-dist]').forEach((b) => (b.onclick = guard(async () => { const r = await api('POST', `/buckets/${b.dataset.dist}/distribute`); toast(`${r.count} leads handed out`); views.buckets(); })));
    $$('[data-view-b]').forEach((b) => (b.onclick = () => { (views.leads.f ||= {}).bucket_id = b.dataset.viewB; Object.assign(views.leads.f, { q: '', status: '', source: '', temperature: '', assigned_to: '', page: 1 }); state.view = 'leads'; renderConsole(); }));
  },

  async calls() {
    await loadUsers();
    const f = (views.calls.f ||= { employee: '', disposition: '', temperature: '', from: '', to: '', page: 1 });
    $('#main').innerHTML = `<div class="topbar"><h1>Call log</h1></div>
      <div class="filters">
        <select class="field" id="ce">${opts(usersCache.filter((u) => u.role === 'employee').map((u) => [String(u.id), u.name]), f.employee, 'All employees')}</select>
        <select class="field" id="cd">${opts(OUTCOMES, f.disposition, 'All outcomes')}</select>
        <select class="field" id="ct">${opts(TEMPS, f.temperature, 'Hot / Warm / Cold')}</select>
        <input class="field" type="date" id="cf" value="${f.from}" title="From"><input class="field" type="date" id="cto" value="${f.to}" title="To"></div>
      <div class="tile table-tile"><div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>Employee</th><th>Lead</th><th>Outcome</th><th>Lead status</th><th>Duration</th><th>Remarks</th></tr></thead><tbody id="rows"></tbody></table></div><div class="pager" id="pager"></div></div>`;
    const draw = async () => {
      const { rows, total } = await api('GET', '/calls?' + new URLSearchParams(f));
      $('#rows').innerHTML = rows.length ? rows.map((c) => `<tr><td class="sub">${when(c.created_at)}</td><td>${esc(c.agent || '—')}</td>
        <td><a href="#" data-lead="${c.lead_id}"><b>${esc(c.lead)}</b></a><div class="sub">${esc(c.lead_phone)}</div></td>
        <td>${pill(c.disposition, outcomeLabel(c.disposition))}</td><td>${tempPill(c.temperature)}</td>
        <td>${c.duration_sec ? fmtSec(c.duration_sec) : '—'}${c.answered_at ? `<div class="sub">${clock(c.answered_at)} → ${clock(c.ended_at)}</div>` : ''}${recBtn(c)}</td>
        <td class="sub" style="max-width:320px">${esc(c.notes || '')}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">No calls match</td></tr>';
      const pages = Math.max(1, Math.ceil(total / 50));
      $('#pager').innerHTML = `<span class="sub">${total} calls</span><span><button class="btn sm" id="prev" ${f.page <= 1 ? 'disabled' : ''}>Prev</button><span class="sub"> ${f.page} / ${pages} </span><button class="btn sm" id="next" ${f.page >= pages ? 'disabled' : ''}>Next</button></span>`;
      $('#prev').onclick = () => { f.page--; guard(draw)(); };
      $('#next').onclick = () => { f.page++; guard(draw)(); };
      $$('[data-lead]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); guard(() => openLead(a.dataset.lead))(); }));
    };
    for (const [id, key] of [['ce', 'employee'], ['cd', 'disposition'], ['ct', 'temperature'], ['cf', 'from'], ['cto', 'to']]) $('#' + id).onchange = (e) => { f[key] = e.target.value; f.page = 1; guard(draw)(); };
    await draw();
  },

  async team() {
    await loadUsers();
    $('#main').innerHTML = `<div class="topbar"><h1>Team</h1>${isAdmin() ? '<button class="btn primary" id="add">+ Add user</button>' : ''}</div>
      <div class="tile table-tile"><div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Role</th><th>Phone</th><th>Status</th><th>Gets new leads</th><th>Open leads</th><th></th></tr></thead><tbody>
      ${usersCache.map((u) => `<tr><td><b>${esc(u.name)}</b><div class="sub">${esc(u.email)}</div></td><td><span class="role-tag">${u.role}</span></td><td>${esc(u.phone || '—')}</td>
        <td>${u.active ? pill('interested', 'Active') : pill('invalid', 'Inactive')}</td>
        <td>${u.role === 'employee' ? `<input type="checkbox" data-rot="${u.id}" ${u.in_rotation ? 'checked' : ''} ${u.active ? '' : 'disabled'}>` : '—'}</td>
        <td>${u.role === 'employee' ? u.pending : '—'}</td>
        <td style="text-align:right;white-space:nowrap">${u.role === 'employee' && u.active && u.pending ? `<button class="btn sm" data-redist="${u.id}">Redistribute leads</button> ` : ''}
          ${isAdmin() ? `<button class="btn sm" data-edit="${u.id}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>
      <p class="sub" style="margin-top:14px"><b>Gets new leads</b> controls the round-robin: untick it when someone is on leave. <b>Redistribute</b> moves their uncalled leads to the rest of the team.</p>`;
    $$('[data-rot]').forEach((c) => (c.onchange = guard(async () => { await api('POST', `/users/${c.dataset.rot}/rotation`, { in_rotation: c.checked }); toast(c.checked ? 'Back in rotation' : 'Paused for new leads'); })));
    $$('[data-redist]').forEach((b) => (b.onclick = guard(async () => {
      if (!confirm('Move this employee’s uncalled leads to the rest of the team?')) return;
      const r = await api('POST', `/users/${b.dataset.redist}/redistribute`); toast(`${r.moved} leads moved`); views.team();
    })));
    if (!isAdmin()) return;
    $('#add').onclick = () => openModal('Add user', `<div class="form-grid">${input('name', 'Name', '', 'text', 'required')}${input('email', 'Email', '', 'email', 'required')}
      ${input('password', 'Temporary password', '', 'text', 'required minlength="8"')}${select('role', 'Role', [['employee', 'Employee'], ['management', 'Management'], ['admin', 'Admin']], 'employee')}
      ${input('phone', 'Phone (rings first on calls)', '', 'tel')}</div><p class="sub">They must choose their own password at first sign-in.</p>`,
    async (fd) => { await api('POST', '/users', fd); toast('User added'); views.team(); });
    $$('[data-edit]').forEach((b) => (b.onclick = () => {
      const u = usersCache.find((x) => x.id == b.dataset.edit);
      openModal('Edit user', `<div class="form-grid">${input('name', 'Name', u.name, 'text', 'required')}
        ${select('role', 'Role', [['employee', 'Employee'], ['management', 'Management'], ['admin', 'Admin']], u.role)}
        ${select('active', 'Status', [['1', 'Active'], ['0', 'Inactive']], String(u.active))}
        ${input('phone', 'Phone (rings first on calls)', u.phone || '', 'tel')}
        <div class="full">${input('password', 'Reset password (optional)', '', 'text', 'minlength="8"')}</div></div>
        <p class="sub">Deactivating an employee signs them out and hands their uncalled leads to the team. <b>Delete</b> removes the account for good (their call history stays, with their name).</p>`,
      async (fd) => {
        const body = { name: fd.name, role: fd.role, active: fd.active === '1', phone: fd.phone };
        if (fd.password) body.password = fd.password;
        await api('PATCH', `/users/${u.id}`, body); toast('User updated'); views.team();
      }, async () => { // permanently remove someone who has left
        const r = await api('DELETE', `/users/${u.id}`);
        toast(`${u.name} was deleted${r.moved ? `, ${r.moved} open leads moved to the team` : ''}`); views.team();
      });
    }));
  },

  async integrations() {
    const i = await api('GET', '/integrations');
    const t = i.telephony, o = location.origin;
    const generic = `${o}/hooks/lead?source=website&key=${i.webhook_key}`;
    const script = `// Google Sheets: Extensions > Apps Script. Run sendNewLeads, then add a time-driven trigger (every 5 min).
function sendNewLeads() {
  const sh = SpreadsheetApp.getActiveSheet();
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty('lastRow') || 1);
  const rows = sh.getDataRange().getValues();
  if (rows.length <= last) return;
  const head = rows[0];
  const leads = rows.slice(last).map(r => Object.fromEntries(head.map((h, k) => [h, r[k]])));
  const res = UrlFetchApp.fetch('${o}/hooks/lead?source=google&key=${i.webhook_key}', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(leads), muteHttpExceptions: true });
  if (res.getResponseCode() === 200) props.setProperty('lastRow', String(rows.length));
}`;
    const row = (label, val) => `<div class="kv"><label>${label}</label><div class="copyrow"><code>${esc(val)}</code><button class="btn sm" data-copy="${esc(val)}">Copy</button></div></div>`;
    $('#main').innerHTML = `<div class="topbar"><h1>Integrations</h1></div>
      <div class="notice">Meta, Google and Twilio must reach your server over public HTTPS. <code>localhost</code> won't work: deploy the app or use a tunnel (Cloudflare Tunnel, ngrok) and open this page from that address.</div>
      <div class="bento">
        <div class="tile span-4"><h3>Phone calling ${t.ready ? pill('interested', t.mode === 'simulate' ? 'Demo mode' : 'Live') : pill('retry', 'Off')}</h3>
          <form id="tel" class="form-grid tel-grid">
            ${select('telephony_mode', 'Calling mode', [['simulate', 'Demo (simulated calls)'], ['twilio', 'Twilio (real calls)'], ['off', 'Off']], t.mode)}
            ${input('twilio_account_sid', 'Twilio Account SID', t.twilio_account_sid, 'text', 'autocomplete="off" placeholder="AC…"')}
            ${input('twilio_auth_token', 'Auth token ' + (t.twilio_token_set ? '(saved)' : ''), '', 'password', 'autocomplete="off" placeholder="' + (t.twilio_token_set ? 'Leave blank to keep' : 'Paste token') + '"')}
            ${input('twilio_from', 'Twilio phone number', t.twilio_from, 'text', 'placeholder="+1…"')}
            ${input('public_url', 'Public HTTPS URL of this app', t.public_url || (location.hostname === 'localhost' ? '' : o), 'url', 'placeholder="https://crm.example.com"')}
            ${select('record_calls', 'Record calls', [['0', 'No'], ['1', 'Yes (inform callers)']], t.record_calls ? '1' : '0')}
            ${input('default_country_code', 'Country code', t.default_country_code, 'text', 'placeholder="91"')}
            <div class="full"><button class="btn primary">Save phone settings</button></div></form>
          <p class="sub"><b>Why this protects your leads:</b> employees never see a lead's number. When they tap Call now, Twilio rings the employee's own phone, then dials the lead and joins the two. The lead sees your company number, not the employee's.
            Start, answer and end times, talk time and recordings are captured automatically. Recording calls may require consent under local law. On a Twilio trial, both numbers must be verified.</p></div>
        <div class="tile span-2"><h3>Meta (Facebook / Instagram Lead Ads)</h3>
          ${row('Callback URL', o + '/hooks/meta')}${row('Verify token', i.meta_verify_token)}
          <form id="meta" class="form-grid" style="margin-top:12px">
            ${input('meta_page_token', 'Page access token ' + (i.meta_page_token_set ? '(saved)' : ''), '', 'password', 'autocomplete="off" placeholder="' + (i.meta_page_token_set ? 'Leave blank to keep' : 'Paste token') + '"')}
            ${input('meta_app_secret', 'App secret ' + (i.meta_app_secret_set ? '(saved)' : ''), '', 'password', 'autocomplete="off" placeholder="' + (i.meta_app_secret_set ? 'Leave blank to keep' : 'Verifies Meta signatures') + '"')}
            <div class="full"><button class="btn primary">Save Meta settings</button></div></form>
          <p class="sub">In your Meta app: Webhooks → Page → subscribe to <b>leadgen</b> with the URL and token above. The page token needs <b>leads_retrieval</b> and <b>pages_manage_metadata</b>.</p></div>
        <div class="tile span-2"><h3>Google Ads lead forms</h3>
          ${row('Webhook URL', o + '/hooks/google')}${row('Key', i.webhook_key)}
          <p class="sub">Lead form extension → Lead delivery → Webhook: paste the URL and key.</p>
          <h3 style="margin-top:22px">Other sources &amp; website forms</h3>${row('Generic webhook (POST JSON)', generic)}
          <p class="sub">Send a JSON object or array with name, phone, email, budget… Change <code>source=</code> to 99acres, magicbricks… Works with Zapier, Make and forms. Every webhook lead is handed to the next employee in the round-robin automatically.</p>
          <button class="btn sm danger" id="rotate">Rotate webhook key</button></div>
        <div class="tile span-4"><h3>Google Sheets auto-sync (Apps Script)</h3><pre class="code">${esc(script)}</pre>
          <button class="btn sm" data-copy="${esc(script)}">Copy script</button></div>
      </div>`;
    $$('[data-copy]').forEach((b) => (b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied'))));
    $('#tel').onsubmit = guard(async (e) => { e.preventDefault(); await api('PUT', '/integrations', Object.fromEntries(new FormData(e.target))); toast('Phone settings saved'); views.integrations(); });
    $('#meta').onsubmit = guard(async (e) => { e.preventDefault(); await api('PUT', '/integrations', Object.fromEntries(new FormData(e.target))); toast('Saved'); views.integrations(); });
    $('#rotate').onclick = guard(async () => { if (confirm('Existing webhooks will stop working until updated. Continue?')) { await api('POST', '/integrations/rotate'); views.integrations(); } });
  },

  async security() {
    const [sec, users] = await Promise.all([api('GET', '/security'), loadUsers()]);
    const f = (views.security.f ||= { action: '', user: '' });
    $('#main').innerHTML = `<div class="topbar"><h1>Security &amp; audit</h1></div>
      <div class="bento">
        <div class="tile span-2"><h3>Employee access rules</h3>
          <form id="sec" class="form-grid">
            <div class="full"><label>Allowed IP addresses (comma separated, blank = anywhere)</label><input class="field" name="employee_ips" value="${esc(sec.employee_ips)}" placeholder="e.g. 203.0.113.10, 203.0.113.11"></div>
            ${input('employee_hours_start', 'Working hours start', sec.employee_hours_start, 'time')}${input('employee_hours_end', 'Working hours end', sec.employee_hours_end, 'time')}
            <div class="full"><label class="radio"><input type="checkbox" name="allow_direct_dial" ${sec.allow_direct_dial ? 'checked' : ''}> Show lead numbers to employees (NOT recommended: they can copy and call privately)</label></div>
            <div class="full"><button class="btn primary">Save</button> <span class="sub">Your current IP: ${esc(sec.your_ip)}. Rules apply to employees only. Hours use the server's clock.</span></div></form></div>
        <div class="tile span-2"><h3>What protects your leads</h3><ul class="plain">
          <li><b>Numbers stay hidden.</b> Employees see a name and requirement, never the phone or email. Calls go through the CRM.</li>
          <li><b>One lead at a time</b>, assigned round-robin. No browsing, searching or exporting.</li>
          <li><b>Management sees masked numbers.</b> Revealing one is logged and limited to 25 per hour.</li>
          <li><b>No export button exists.</b> Leads can only be viewed inside the CRM.</li>
          <li><b>Every outcome needs a real call</b> placed through the CRM, with duration, remarks and Hot/Warm/Cold.</li>
          <li><b>One device per employee</b>, auto sign-out when idle, forced password change, login throttling.</li>
          <li><b>Audit log</b> of logins, reveals, imports, reassignments and edits.</li></ul></div>
        <div class="tile table-tile span-4"><div class="filters" style="padding:16px 16px 0"><h3 style="margin:0;align-self:center">Audit log</h3><span style="flex:1"></span>
          <select class="field" id="aa">${opts([['login', 'Sign-ins'], ['login.fail', 'Failed sign-ins'], ['lead.reveal', 'Number reveals'], ['lead.import', 'Imports'], ['lead.bulk', 'Bulk changes'], ['lead.edit', 'Lead edits'], ['lead.delete', 'Deletions'], ['call', 'Calls'], ['user', 'User changes'], ['security', 'Security changes']], f.action, 'All actions')}</select>
          <select class="field" id="au">${opts(users.map((u) => [String(u.id), u.name]), f.user, 'All users')}</select></div>
          <div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th></tr></thead><tbody id="arows"></tbody></table></div></div>
      </div>`;
    const draw = async () => {
      const rows = await api('GET', '/audit?' + new URLSearchParams(f));
      $('#arows').innerHTML = rows.map((a) => `<tr><td class="sub" style="white-space:nowrap">${when(a.at)}</td><td>${esc(a.user_name || '—')}</td><td><code>${esc(a.action)}</code></td>
        <td class="sub">${esc(a.target || '')}</td><td class="sub">${esc(a.detail || '')}</td><td class="sub">${esc(a.ip || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nothing logged</td></tr>';
    };
    $('#aa').onchange = (e) => { f.action = e.target.value; guard(draw)(); };
    $('#au').onchange = (e) => { f.user = e.target.value; guard(draw)(); };
    $('#sec').onsubmit = guard(async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      if (fd.allow_direct_dial && !confirm('Employees will be able to see and copy every lead number they are given. Continue?')) return;
      await api('PUT', '/security', { employee_ips: fd.employee_ips, employee_hours_start: fd.employee_hours_start, employee_hours_end: fd.employee_hours_end, allow_direct_dial: !!fd.allow_direct_dial });
      toast('Security settings saved');
    });
    await draw();
  },
};

// ----- lead form (management + admin) -----
async function openLead(id) {
  await loadUsers();
  leadForm(await api('GET', `/leads/${id}`));
}
function leadForm(l) {
  const isNew = !l, admin = isAdmin();
  const masked = !isNew && !admin;
  const body = `<div class="form-grid">
    ${input('name', 'Name', l?.name, 'text', 'required')}
    ${isNew || admin ? input('phone', 'Phone', l?.phone, 'text', 'required') : `<div><label>Phone</label><div class="copyrow"><input class="field" id="phoneview" value="${esc(l.phone)}" readonly><button type="button" class="btn sm" id="reveal">Reveal</button></div></div>`}
    ${isNew || admin ? input('email', 'Email', l?.email, 'email') : `<div><label>Email</label><input class="field" id="emailview" value="${esc(l.email || '—')}" readonly></div>`}
    ${input('city', 'City', l?.city)}
    <div><label>Source</label><input class="field" name="source" list="srcs" value="${esc(l?.source || 'manual')}"><datalist id="srcs">${Object.keys(SOURCES).map((s) => `<option value="${s}">`).join('')}</datalist></div>
    ${input('campaign', 'Campaign', l?.campaign)}
    ${select('purpose', 'Looking to', PURPOSES, l?.purpose, '—')}${select('property_type', 'Property type', PROPERTY_TYPES, l?.property_type, '—')}
    ${input('bhk', 'BHK / size', l?.bhk)}${select('timeline', 'Timeline', TIMELINES, l?.timeline, '—')}
    ${input('budget_min', 'Budget min (₹ lakh)', lakh(l?.budget_min), 'number', 'min="0" step="any"')}${input('budget_max', 'Budget max (₹ lakh)', lakh(l?.budget_max), 'number', 'min="0" step="any"')}
    <div class="full">${input('location_pref', 'Preferred location', l?.location_pref)}</div>
    ${isNew ? '' : select('temperature', 'Lead status', TEMPS, l.temperature, 'Not rated')}
    ${isNew ? '' : select('status', 'Pipeline status', Object.entries(STATUS_LABEL).filter(([k]) => k !== 'in_call' || l.status === 'in_call'), l.status)}
    <div class="full"><label>Assigned to</label><select class="field" name="assigned_to">${empOpts(l?.assigned_to, isNew ? 'Next in round-robin' : 'Unassigned')}</select></div>
    <div class="full"><label>Enquiry message</label><textarea class="field" name="notes">${esc(l?.notes)}</textarea></div></div>
    ${l?.status === 'in_call' ? '<p class="sub">Currently being called. Reassigning or changing the status releases the employee’s lock.</p>' : ''}
    ${l?.calls?.length ? `<h3 class="hist-title">Call history</h3>${l.calls.map((c) => `<div class="hist"><div>${pill(c.disposition, outcomeLabel(c.disposition))} ${c.temperature ? tempPill(c.temperature) : ''}
      <span class="sub">${esc(c.agent || '')} · ${when(c.created_at)}</span>${recBtn(c)}</div>${callMeta(c) ? `<div class="sub">${callMeta(c)}</div>` : ''}${c.notes ? `<div class="sub">${esc(c.notes)}</div>` : ''}</div>`).join('')}` : ''}`;
  openModal(isNew ? 'Add lead' : esc(l.name), body, async (fd) => {
    const payload = { ...fd };
    for (const f of ['budget_min', 'budget_max']) payload[f] = fd[f] === '' ? null : Number(fd[f]) * 1e5;
    payload.assigned_to = fd.assigned_to || null;
    if (masked) { delete payload.phone; delete payload.email; }
    if (!isNew && fd.status === l.status) delete payload.status; // unchanged status must not reset attempts or free an employee's lock
    if (isNew) await api('POST', '/leads', payload); else await api('PATCH', `/leads/${l.id}`, payload);
    toast('Lead saved');
    if (state.view === 'leads') views.leads.refresh?.(); else if (state.view === 'dashboard') views.dashboard();
  }, !isNew && admin ? async () => {
    await api('DELETE', `/leads/${l.id}`); toast('Lead deleted');
    if (state.view === 'leads') views.leads.refresh?.();
  } : null, true);
  if (masked) {
    $('#reveal').onclick = guard(async () => {
      const r = await api('POST', `/leads/${l.id}/reveal`);
      $('#phoneview').value = r.phone; $('#emailview').value = r.email || '—'; $('#reveal').remove(); toast('Number revealed. This is logged.');
    });
  }
}

// ---------- boot ----------
(async () => {
  try {
    state.user = await api('GET', '/me');
    start();
  } catch { showLogin(); }
})();
