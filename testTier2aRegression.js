// Regression coverage for Tier 2a (email/domain derivation + validation parity).
//
//   node testTier2aRegression.js
//
// Requires the API server on localhost:5000. Exercises the server contract:
// public-provider parity on both fields, and that a normal client-create with
// valid email + domain still persists the right matching-rule types. Creates and
// removes "ZZ-T2AREG-" clients; cleans up folders it makes.

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const MatchingRule = require('./models/MatchingRule');

const API = 'http://127.0.0.1:5000';
const PREFIX = 'ZZ-T2AREG-';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const ok = (label, cond, extra) => {
  if (cond) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
};

const api = async (method, path, body) => {
  for (let i = 0; i < 5; i += 1) {
    try {
      const r = await fetch(API + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await r.json(); } catch { /* none */ }
      return { status: r.status, json };
    } catch { await sleep(3000); }
  }
  throw new Error(`API unreachable: ${method} ${path}`);
};

const cleanup = async () => {
  const rows = await Client.find({ name: new RegExp(`^${PREFIX}`) }).lean();
  for (const c of rows) await api('DELETE', `/api/clients/${c._id}?deleteFolders=true`).catch(() => {});
  await Client.deleteMany({ name: new RegExp(`^${PREFIX}`) });
  await MatchingRule.deleteMany({ clientId: { $in: rows.map((c) => c._id) } });
};

const run = async () => {
  await connectDB();
  await cleanup();

  // ---- public-provider parity: blocked from the email-addresses field ----
  console.log('\n[public-provider parity]');
  {
    const r1 = await api('POST', '/api/clients', { name: `${PREFIX}A`, matchingRules: { emailAddresses: ['@gmail.com'], domains: [] } });
    ok('emailAddresses ["@gmail.com"] -> 400', r1.status === 400 && /public email provider/.test(r1.json?.error || ''), `got ${r1.status}`);
    const r2 = await api('POST', '/api/clients', { name: `${PREFIX}B`, matchingRules: { emailAddresses: ['gmail.com'], domains: [] } });
    ok('emailAddresses ["gmail.com"] -> 400', r2.status === 400, `got ${r2.status}`);
    const r3 = await api('POST', '/api/clients', { name: `${PREFIX}C`, matchingRules: { emailAddresses: [], domains: ['yahoo.com'] } });
    ok('domains ["yahoo.com"] -> 400 (unchanged)', r3.status === 400, `got ${r3.status}`);
    ok('none of the blocked attempts created a client', (await Client.countDocuments({ name: new RegExp(`^${PREFIX}[ABC]$`) })) === 0);
  }

  // ---- regression: a normal create with a valid email + domain still works ----
  console.log('\n[regression: normal client create]');
  let normalId;
  {
    const res = await api('POST', '/api/clients', {
      name: `${PREFIX}NORMAL`,
      matchingRules: { emailAddresses: ['ap@realcorp.example', 'bob@gmail.com'], domains: ['realcorp.example'] },
      dropboxPath: `${PREFIX}NORMAL/Payroll Files`,
      dropboxPathIsAbsolute: false,
      shareFilePath: `${PREFIX}NORMAL`,
      shareFilePathIsAbsolute: false,
    });
    ok('valid create (incl. an exact gmail address) -> 201', res.status === 201, `got ${res.status} ${JSON.stringify(res.json).slice(0, 140)}`);
    normalId = res.json?._id;
    await sleep(800);
    const rules = await MatchingRule.find({ clientId: normalId }).lean();
    const byType = rules.reduce((acc, r) => { (acc[r.type] = acc[r.type] || []).push(r.value); return acc; }, {});
    ok('exact_email rules created for both addresses', (byType.exact_email || []).sort().join(',') === 'ap@realcorp.example,bob@gmail.com', JSON.stringify(byType));
    ok('domain rule created for the domain', (byType.domain || []).join(',') === 'realcorp.example', JSON.stringify(byType));
  }

  // ---- regression: adding a rule through the API still persists ----
  console.log('\n[regression: normal rule add]');
  {
    const res = await api('POST', '/api/matching-rules', { clientId: normalId, type: 'domain', value: 'another-corp.example' });
    ok('POST /api/matching-rules -> 201', res.status === 201, `got ${res.status} ${res.json?.error}`);
    const stored = await MatchingRule.findOne({ clientId: normalId, value: 'another-corp.example' }).lean();
    ok('rule persisted with type=domain', stored && stored.type === 'domain');
  }

  // ---- regression: editing the client's rules re-syncs correctly ----
  console.log('\n[regression: edit client rules]');
  {
    const res = await api('PUT', `/api/clients/${normalId}`, {
      matchingRules: { emailAddresses: ['ap@realcorp.example'], domains: ['realcorp.example', 'second.example'] },
    });
    ok('PUT matchingRules -> 200', res.status === 200, `got ${res.status}`);
    await sleep(600);
    const rules = await MatchingRule.find({ clientId: normalId, source: 'legacy_sync' }).lean();
    const domains = rules.filter((r) => r.type === 'domain').map((r) => r.value).sort();
    ok('domain rules re-synced to the new set', domains.join(',') === 'realcorp.example,second.example', JSON.stringify(domains));
    ok('the removed second exact_email is gone from legacy_sync', !rules.some((r) => r.type === 'exact_email' && r.value === 'bob@gmail.com'));
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
};

run().catch(async (error) => {
  console.error('testTier2aRegression ERROR:', error);
  try { await cleanup(); } catch { /* ignore */ }
  process.exit(2);
});
