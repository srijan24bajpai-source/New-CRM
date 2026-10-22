// First-run setup: schema, the first admin (production) or demo data (development).
const { one, exec, migrate } = require('./db');
const S = require('./security');
const L = require('./leads');

// Vercel does not always set NODE_ENV during builds, so treat any Vercel environment as production: demo accounts must never exist online.
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL || !!process.env.VERCEL_ENV;

// Production never ships demo accounts or sample leads: the first admin comes from ADMIN_EMAIL / ADMIN_PASSWORD.
async function bootstrapAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  if (!/^\S+@\S+$/.test(email)) throw new Error('First run: set ADMIN_EMAIL (and ADMIN_PASSWORD) to create the first admin account.');
  let pw = process.env.ADMIN_PASSWORD || '', generated = false;
  try { S.checkPassword(pw); } catch { pw = S.randHex(9) + 'Aa1'; generated = true; }
  await exec('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?) ON CONFLICT (email) DO NOTHING', ['Admin', email, S.hashPassword(pw), 'admin', S.now()]);
  console.log(`Created admin ${email}.` + (generated ? ` One-time password: ${pw}` : ''));
}

async function demoSeed() {
  const add = (name, email, pw, role) => exec('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?) ON CONFLICT (email) DO NOTHING', [name, email, S.hashPassword(pw), role, S.now()]);
  await add('Admin', 'admin@crm.local', 'Admin@123', 'admin');
  await add('Meera Kapoor', 'manager@crm.local', 'Manager@123', 'management');
  await add('Riya Sharma', 'emp1@crm.local', 'Employee@123', 'employee');
  await add('Karan Singh', 'emp2@crm.local', 'Employee@123', 'employee');
  await add('Anil Yadav', 'emp3@crm.local', 'Employee@123', 'employee');
  const o = (bucketName) => ({ bucketName, mode: 'round_robin' });
  await L.importRows([
    { name: 'Aarav Mehta', phone: '90000 00001', city: 'Lucknow', budget: '60-80 lakh', bhk: '3 BHK', location: 'Gomti Nagar', message: 'Wants ready-to-move flat', campaign: 'Gomti Heights' },
    { name: 'Sofia Rossi', phone: '+91 90000 00002', city: 'Lucknow', budget: '1.2 cr', property_type: 'Villa', location: 'Sushant Golf City' },
    { name: 'Liam Carter', phone: '9000000003', city: 'Kanpur', budget: '45L', bhk: '2 BHK' },
    { name: 'Priya Nair', phone: '9000000004', city: 'Lucknow', budget: '35 lakh', bhk: '2 BHK', location: 'Jankipuram' },
    { name: 'Rohit Verma', phone: '9000000005', city: 'Lucknow', budget: '90 lakh - 1.1 cr', property_type: 'Apartment' },
    { name: 'Neha Gupta', phone: '9000000006', city: 'Unnao', budget: '25 lakh', property_type: 'Plot' },
  ], 'excel', o('Diwali campaign - Excel batch'));
  await L.importRows([
    { full_name: 'Imran Khan', phone_number: 'p:+919000000007', email: 'imran@example.com', city: 'Lucknow', 'what_is_your_budget?': '50_lakh_-_75_lakh', campaign_name: 'Diwali Offer' },
    { full_name: 'Sneha Joshi', phone_number: '+919000000008', city: 'Lucknow', 'what_is_your_budget?': '1_cr_-_1.5_cr', campaign_name: 'Diwali Offer' },
    { full_name: 'Vikram Rao', phone_number: '+919000000009', city: 'Barabanki', campaign_name: 'Diwali Offer' },
  ], 'meta', o('Meta - Diwali Offer'));
  await L.importRows([
    { FULL_NAME: 'Anita Desai', PHONE_NUMBER: '+919000000010', EMAIL: 'anita@example.com', CITY: 'Lucknow', campaign: 'Search - 3BHK Lucknow' },
    { FULL_NAME: 'Manoj Tiwari', PHONE_NUMBER: '+919000000011', CITY: 'Lucknow', campaign: 'Search - Plots' },
  ], 'google', o('Google - Search leads'));
  await L.importRows([{ name: 'Deepak Yadav', phone: '9000000012', message: 'Enquiry from 99acres listing #4821. Call 9876501234', budget: '55 lakh' }], '99acres', o('99acres - October'));
}

let ready;
function ensureReady() {
  ready ||= (async () => {
    await migrate();
    await exec("INSERT INTO settings (key,value) VALUES ('webhook_key',?) ON CONFLICT (key) DO NOTHING", [S.randHex(20)]);
    await exec("INSERT INTO settings (key,value) VALUES ('meta_verify_token',?) ON CONFLICT (key) DO NOTHING", [S.randHex(8)]);
    if ((await one('SELECT COUNT(*) AS n FROM users')).n === 0) {
      if (IS_PROD && process.env.DEMO_SEED !== '1') await bootstrapAdmin(); else await demoSeed();
    }
    S.invalidateSettings();
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

module.exports = { ensureReady, IS_PROD };
