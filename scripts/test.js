// End-to-end regression suite. Starts the real server in-process on an in-memory Postgres (PGlite): `npm test`
process.env.PGLITE_DIR = 'memory://';
process.env.PORT = process.env.TEST_PORT || '3915';
process.env.NODE_ENV = 'development';
delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL;
const B = `http://127.0.0.1:${process.env.PORT}`;
const server = require('../server');

let failed = 0, passed = 0;
const ok = (c, msg) => { c ? passed++ : failed++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
class Client {
  constructor() { this.cookie = ''; }
  async call(m, p, body, headers = {}) {
    const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-CRM': '1', ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return [r.status, j, r];
  }
  login(email, pw) { return this.call('POST', '/api/auth/login', { email, password: pw }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { /* starting */ } await sleep(200); }
  const admin = new Client(), mgr = new Client(), e1 = new Client(), e2 = new Client(), e3 = new Client();

  // ----- auth -----
  const [ls, lj, lr] = await admin.login('admin@crm.local', 'Admin@123');
  ok(ls === 200 && !lj.user.must_change, 'sign in works straight away, no forced password change');
  ok(/HttpOnly/i.test(lr.headers.get('set-cookie')) && /SameSite=Strict/i.test(lr.headers.get('set-cookie')), 'session cookie is HttpOnly + SameSite=Strict');
  await mgr.login('manager@crm.local', 'Manager@123'); await e1.login('emp1@crm.local', 'Employee@123');
  await e2.login('emp2@crm.local', 'Employee@123'); await e3.login('emp3@crm.local', 'Employee@123');
  ok((await new Client().login('emp1@crm.local', 'wrong'))[0] === 401, 'wrong password rejected');
  ok((await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403, 'CSRF header required');
  const idx = await fetch(B + '/api/me'); ok(idx.headers.get('content-security-policy') && idx.headers.get('x-frame-options') === 'DENY', 'security headers present');
  ok((await e1.call('POST', '/api/auth/password', { current: 'Employee@123', password: 'short' }))[0] === 400, 'weak new password rejected');
  ok((await e1.call('POST', '/api/auth/password', { current: 'Employee@123', password: 'Employee@1234' }))[0] === 200, 'voluntary password change works');
  ok((await new Client().login('emp1@crm.local', 'Employee@1234'))[0] === 200, 'new password works');
  await e1.login('emp1@crm.local', 'Employee@1234');
  const brute = new Client(); let last; for (let i = 0; i < 9; i++) last = (await brute.login('admin@crm.local', 'nope' + i))[0];
  ok(last === 429, 'brute force is throttled (stored in the database)');
  ok((await new Client().login('manager@crm.local', 'Manager@123'))[0] === 200, 'other accounts are unaffected by the lockout');

  // ----- role isolation -----
  for (const p of ['/api/leads', '/api/stats', '/api/users', '/api/calls', '/api/buckets', '/api/audit']) ok((await e1.call('GET', p))[0] === 403, 'employee blocked from ' + p);
  ok((await mgr.call('GET', '/api/audit'))[0] === 403, 'management blocked from audit');
  ok((await mgr.call('GET', '/api/integrations'))[0] === 403, 'management blocked from integrations');
  ok((await mgr.call('POST', '/api/users', { name: 'x', email: 'x@x.com', password: 'Abcdef12' }))[0] === 403, 'management cannot create users');
  ok((await mgr.call('GET', '/api/queue/current'))[0] === 403, 'management has no calling queue');

  // ----- round robin -----
  const users = (await admin.call('GET', '/api/users'))[1];
  const emp = users.filter((u) => u.role === 'employee');
  ok(emp.length === 3 && emp.every((u) => u.pending === 4), 'seed leads distributed evenly: ' + emp.map((u) => u.name + '=' + u.pending).join(', '));

  // ----- employee sees one lead, no contact details -----
  const q = (await e1.call('GET', '/api/queue/current'))[1];
  const keys = Object.keys(q.lead);
  ok(!keys.includes('phone') && !keys.includes('email') && !keys.includes('phone_norm') && !keys.includes('extra'), 'employee lead has no phone/email');
  ok(!JSON.stringify(q).match(/9000000\d\d|9876501234|\+91|@/), 'no numbers or emails anywhere in the employee payload');
  ok((await e1.call('GET', '/api/queue/current'))[1].lead.id === q.lead.id, 'same lead until feedback is submitted');
  const racers = await Promise.all([1, 2, 3, 4, 5].map(() => e2.call('GET', '/api/queue/current')));
  const ids = new Set(racers.map((r) => r[1].lead?.id));
  const held = (await admin.call('GET', '/api/leads?status=in_call&assigned_to=' + emp.find((u) => u.email === 'emp2@crm.local').id))[1];
  ok(ids.size === 1 && held.total === 1, 'five simultaneous requests still give an employee exactly one lead');

  // ----- call flow (demo calling mode) -----
  ok((await e1.call('POST', '/api/queue/complete', { lead_id: q.lead.id, disposition: 'interested', temperature: 'hot', notes: 'fake call' }))[0] === 400, 'cannot give feedback without calling');
  const d = (await e1.call('POST', '/api/queue/dial', { lead_id: q.lead.id }))[1];
  ok(d.status === 'dialing_agent', 'dial started');
  ok((await e1.call('POST', '/api/queue/complete', { lead_id: q.lead.id, disposition: 'not_interested', session_id: d.id, notes: 'nope nope' }))[0] === 409, 'cannot save mid-call');
  await sleep(5200);
  const s = (await e1.call('GET', '/api/queue/session/' + d.id))[1];
  ok(s.status === 'in_call' && s.answered_at, 'call connected, start time recorded');
  await sleep(5200);
  await e1.call('POST', '/api/queue/hangup', { session_id: d.id });
  const s2 = (await e1.call('GET', '/api/queue/session/' + d.id))[1];
  ok(s2.status === 'ended' && s2.talk_sec >= 5, 'call ended, talk time ' + s2.talk_sec + 's');
  ok((await e1.call('POST', '/api/queue/complete', { lead_id: q.lead.id, disposition: 'no_answer', session_id: d.id }))[0] === 400, 'cannot claim no-answer on a connected call');
  ok((await e1.call('POST', '/api/queue/complete', { lead_id: q.lead.id, disposition: 'interested', session_id: d.id, notes: 'Wants 3BHK' }))[0] === 400, 'Hot/Warm/Cold required');
  ok((await e1.call('POST', '/api/queue/complete', { lead_id: q.lead.id, disposition: 'interested', temperature: 'hot', session_id: d.id, notes: '' }))[0] === 400, 'remarks required');
  const done = (await e1.call('POST', '/api/queue/complete', { lead_id: q.lead.id, disposition: 'interested', temperature: 'hot', session_id: d.id, notes: 'Wants 3BHK in Gomti Nagar' }))[1];
  ok(done.lead && done.lead.id !== q.lead.id, 'feedback saved, next lead served: ' + done.lead?.name);
  ok((await e1.call('POST', '/api/queue/complete', { lead_id: done.lead.id, disposition: 'wrong_number' }))[0] === 400, 'wrong number also needs a real call');

  // ----- management view -----
  const ml = (await mgr.call('GET', '/api/leads?limit=5'))[1];
  ok(ml.rows.every((r) => r.phone.includes('•') && !/\d{8}/.test(r.phone)), 'management sees masked phones: ' + ml.rows[0].phone);
  ok((await mgr.call('GET', '/api/leads?q=9000000001'))[1].total === 0, 'management cannot search by phone number');
  ok(/^\d/.test((await mgr.call('POST', '/api/leads/' + q.lead.id + '/reveal'))[1].phone), 'management reveal works (and is logged)');
  ok((await admin.call('GET', '/api/leads?q=9000000001'))[1].total === 1, 'admin can search by phone');
  ok((await mgr.call('DELETE', '/api/leads/' + q.lead.id))[0] === 403, 'management cannot delete leads');
  await mgr.call('PATCH', '/api/leads/' + q.lead.id, { phone: '9111111111' });
  const lead = (await admin.call('GET', '/api/leads/' + q.lead.id))[1];
  ok(lead.phone !== '9111111111', 'management cannot change a phone number');
  ok(lead.temperature === 'hot' && lead.calls[0].duration_sec >= 5 && lead.calls[0].temperature === 'hot' && lead.calls[0].notes, 'lead is HOT; duration, remarks tracked');
  const calls = (await mgr.call('GET', '/api/calls?temperature=hot'))[1];
  ok(calls.total === 1 && calls.rows[0].lead_phone.includes('•'), 'call log filters by temperature, numbers masked');
  const st = (await mgr.call('GET', '/api/stats'))[1];
  ok(st.byTemp[0]?.temperature === 'hot' && st.employees.length === 3 && st.callsToday === 1, 'dashboard stats');

  // ----- buckets & distribution -----
  const bk = (await mgr.call('GET', '/api/buckets'))[1];
  ok(bk.length === 4 && bk[0].total >= 1, 'buckets listed: ' + bk.map((b) => b.name).join(' | '));
  const paused = bk.find((b) => b.name.includes('Excel'));
  await mgr.call('PATCH', '/api/buckets/' + paused.id, { status: 'paused' });
  const q3 = (await e3.call('GET', '/api/queue/current'))[1];
  const lead3 = (await admin.call('GET', '/api/leads/' + q3.lead.id))[1];
  ok(lead3.bucket !== paused.name, 'paused bucket is not served to employees (got ' + lead3.bucket + ')');
  await mgr.call('PATCH', '/api/buckets/' + paused.id, { status: 'active' });
  const rows = Array.from({ length: 6 }, (_, i) => ({ Name: 'T' + i, Mobile: '98000000' + String(10 + i) }));
  const imp = (await mgr.call('POST', '/api/leads/import', { source: 'excel', bucket_name: 'Test batch', mode: 'selected', pool: [emp[0].id, emp[1].id], rows }))[1];
  ok(imp.inserted === 6 && imp.assigned === 6, 'import to selected employees');
  const l2 = (await admin.call('GET', '/api/leads?bucket_id=' + imp.bucket_id + '&limit=50'))[1].rows;
  const counts = {}; l2.forEach((r) => (counts[r.assignee] = (counts[r.assignee] || 0) + 1));
  ok(Object.keys(counts).length === 2 && Object.values(counts).every((c) => c === 3), 'split 3/3 between the two chosen: ' + JSON.stringify(counts));
  const again = (await mgr.call('POST', '/api/leads/import', { source: 'excel', bucket_name: 'Test batch', mode: 'selected', pool: [emp[0].id], rows: [...rows, { Name: 'Same phone twice', Mobile: '9800000010' }, { Name: 'Bad', Mobile: '12' }] }))[1];
  ok(again.inserted === 0 && again.duplicates === 7 && again.invalid === 1, 'duplicates (existing + within file) and invalid rows are skipped');
  const un = (await mgr.call('POST', '/api/leads/import', { source: 'excel', bucket_name: 'Unassigned batch', mode: 'unassigned', rows: [{ Name: 'U1', Mobile: '9700000001' }, { Name: 'U2', Mobile: '9700000002' }] }))[1];
  ok(un.assigned === 0, 'unassigned import');
  const ub = (await mgr.call('GET', '/api/buckets'))[1].find((b) => b.name === 'Unassigned batch');
  ok(ub.unassigned === 2 && (await mgr.call('POST', `/api/buckets/${ub.id}/distribute`))[1].count === 2, 'distribute unassigned round-robin');

  // ----- bulk actions over a whole filter -----
  const bulkRes = (await mgr.call('POST', '/api/leads/bulk', { filter: { bucket_id: imp.bucket_id }, action: 'distribute' }))[1];
  ok(bulkRes.count === 6, 'bulk round-robin on every lead matching a filter');
  const spread = (await admin.call('GET', '/api/leads?bucket_id=' + imp.bucket_id + '&limit=50'))[1].rows.reduce((a, r) => ((a[r.assignee] = (a[r.assignee] || 0) + 1), a), {});
  ok(Object.values(spread).every((c) => c === 2) && Object.keys(spread).length === 3, 'redistributed evenly across all three: ' + JSON.stringify(spread));

  // ----- webhook + account lifecycle -----
  const key = (await admin.call('GET', '/api/integrations'))[1].webhook_key;
  const hk = await fetch(B + '/hooks/lead?source=website&key=' + key, { method: 'POST', body: JSON.stringify([{ name: 'W1', phone: '9600000001' }, { name: 'W2', phone: '9600000002' }, { name: 'W3', phone: '9600000003' }]) });
  ok((await hk.json()).inserted === 3, 'generic webhook inserts and round-robins');
  ok((await fetch(B + '/hooks/lead?key=wrong', { method: 'POST', body: '{}' })).status === 401, 'webhook needs the key');
  const e3id = emp.find((u) => u.email === 'emp3@crm.local').id;
  ok((await admin.call('PATCH', '/api/users/' + e3id, { active: false }))[0] === 200, 'deactivate an employee');
  ok((await admin.call('GET', '/api/users'))[1].find((u) => u.id === e3id).pending === 0, 'their open leads were redistributed');
  ok((await e3.call('GET', '/api/queue/current'))[0] === 401, 'deactivated employee is signed out');
  const e2id = emp.find((u) => u.email === 'emp2@crm.local').id;
  const delRes = await admin.call('DELETE', '/api/users/' + e2id);
  ok(delRes[0] === 200 && delRes[1].moved > 0, 'permanently delete an employee who left; ' + delRes[1].moved + ' open leads reassigned');
  ok((await admin.call('GET', '/api/users'))[1].every((u) => u.id !== e2id), 'deleted user is gone');
  ok((await e2.call('GET', '/api/queue/current'))[0] === 401, 'deleted user is signed out');
  ok((await admin.call('DELETE', '/api/users/1'))[0] === 400, 'admin cannot delete their own account');
  ok((await mgr.call('DELETE', '/api/users/' + e3id))[0] === 403, 'management cannot delete users');
  const stuck = (await admin.call('GET', '/api/leads?status=in_call&limit=50'))[1].rows.filter((r) => !r.assignee);
  ok(stuck.length === 0, 'no lead is left locked to a removed user');
  const hist = (await admin.call('GET', '/api/calls'))[1];
  ok(hist.total >= 1 && hist.rows.every((r) => r.agent), 'call history keeps the employee name');

  // ----- security rules -----
  ok((await admin.call('PUT', '/api/security', { employee_ips: '203.0.113.9' }))[0] === 200, 'set office IP allow-list');
  ok((await e1.call('GET', '/api/queue/current'))[0] === 403, 'employee outside allowed IP is blocked');
  ok((await new Client().login('emp1@crm.local', 'Employee@1234'))[0] === 403, 'employee login blocked from other IPs');
  ok((await mgr.call('GET', '/api/stats'))[0] === 200, 'management unaffected by the IP list');
  await admin.call('PUT', '/api/security', { employee_ips: '' });
  const e1b = new Client(); await e1b.login('emp1@crm.local', 'Employee@1234');
  ok((await e1.call('GET', '/api/queue/current'))[0] === 401 && (await e1b.call('GET', '/api/queue/current'))[0] === 200, "new login signs out the employee's other session");
  const au = (await admin.call('GET', '/api/audit'))[1];
  ok(['lead.reveal', 'login.fail', 'call.dial', 'user.delete', 'lead.import'].every((a) => au.some((x) => x.action === a)), 'audit log captured reveals, failed logins, dials, deletions, imports (' + au.length + ' entries)');
  ok((await fetch(B + '/api/cron')).status === 401, 'cron endpoint is closed without the secret');

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close(); process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
