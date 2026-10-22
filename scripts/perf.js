// Load check: imports 100,000 leads and times the screens that matter. `node scripts/perf.js [count]`
process.env.PGLITE_DIR = 'memory://'; process.env.PORT = '3916'; process.env.NODE_ENV = 'development';
delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL;
const server = require('../server');
const B = 'http://127.0.0.1:3916';
class C {
  constructor() { this.cookie = ''; }
  async call(m, p, body) {
    const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-CRM': '1', ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const t = await r.text(); try { return [r.status, JSON.parse(t)]; } catch { return [r.status, t]; }
  }
}
const time = async (label, fn) => { const t = performance.now(); const r = await fn(); console.log(label.padEnd(52), String(Math.round(performance.now() - t)).padStart(7), 'ms'); return r; };
(async () => {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  const mgr = new C(), emp = new C(), admin = new C();
  await mgr.call('POST', '/api/auth/login', { email: 'manager@crm.local', password: 'Manager@123' });
  await emp.call('POST', '/api/auth/login', { email: 'emp1@crm.local', password: 'Employee@123' });
  await admin.call('POST', '/api/auth/login', { email: 'admin@crm.local', password: 'Admin@123' });
  const N = Number(process.argv[2] || 100000), CH = 1500;
  const sources = ['excel', 'meta', 'google', '99acres', 'website'], cities = ['Lucknow', 'Kanpur', 'Unnao', 'Varanasi', 'Prayagraj'];
  let ins = 0;
  await time(`import ${N} leads (${Math.ceil(N / CH)} requests of ${CH}, round-robin)`, async () => {
    for (let i = 0; i < N; i += CH) {
      const rows = Array.from({ length: Math.min(CH, N - i) }, (_, k) => { const n = i + k; return { Name: 'Lead ' + n, Mobile: String(7000000000 + n), City: cities[n % 5], Budget: (30 + (n % 90)) + ' lakh', BHK: (1 + (n % 4)) + ' BHK', Campaign: 'Camp ' + (n % 20) }; });
      const r = (await mgr.call('POST', '/api/leads/import', { source: sources[(i / CH | 0) % 5], bucket_name: 'Bulk ' + ((i / CH | 0) % 10), mode: 'round_robin', rows }))[1];
      ins += r.inserted;
    }
  });
  console.log('inserted', ins);
  await time('re-import 1500 duplicates (all skipped)', () => mgr.call('POST', '/api/leads/import', { source: 'excel', bucket_name: 'Bulk 0', rows: Array.from({ length: 1500 }, (_, n) => ({ Name: 'Lead ' + n, Mobile: String(7000000000 + n) })) }));
  const l = await time('leads page 1', () => mgr.call('GET', '/api/leads?limit=50')); console.log('   total', l[1].total);
  await time('leads page 1000 (deep pagination)', () => mgr.call('GET', '/api/leads?limit=50&page=1000'));
  await time('leads filter status+source', () => mgr.call('GET', '/api/leads?status=new&source=meta&limit=50'));
  await time('leads text search "Lead 99"', () => mgr.call('GET', '/api/leads?q=Lead%2099&limit=50'));
  await time('admin search by phone', () => admin.call('GET', '/api/leads?q=7000050000&limit=50'));
  const st = await time('dashboard stats', () => mgr.call('GET', '/api/stats')); console.log('   pending', st[1].pending, st[1].employees.map((e) => e.name + ':' + e.pending).join(' '));
  await time('buckets list with stats', () => mgr.call('GET', '/api/buckets'));
  await time('employee: claim next lead', () => emp.call('GET', '/api/queue/current'));
  await time('employee: queue state again', () => emp.call('GET', '/api/queue/current'));
  const r1 = await time('bulk: round-robin ALL leads of one source', () => mgr.call('POST', '/api/leads/bulk', { filter: { source: 'excel' }, action: 'distribute' })); console.log('   ->', r1[1].count);
  const r2 = await time('bulk: requeue ALL leads matching "Lucknow"', () => mgr.call('POST', '/api/leads/bulk', { filter: { q: 'Lucknow' }, action: 'requeue' })); console.log('   ->', r2[1].count);
  const r3 = await time("redistribute one employee's pending leads", () => admin.call('POST', '/api/users/3/redistribute')); console.log('   ->', r3[1].moved);
  console.log('server memory MB', Math.round(process.memoryUsage().rss / 1e6));
  server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
