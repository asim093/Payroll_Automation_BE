// Parity check: the backend classifier must agree with the frontend's, which is
// the source of truth for rule types.  node testMatchValue.js

const assert = require('node:assert/strict');
const { classifyMatchValue, deriveRuleType, normalizeMatchValue, isPlausibleDomain } = require('./utils/matchValue');

let passed = 0;
let failed = 0;
const check = (label, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${label}`); }
  catch (error) { failed += 1; console.log(`  FAIL ${label}\n       ${error.message}`); }
};

check('email form', () => {
  assert.deepEqual(classifyMatchValue('Bob@Acme.com'), { kind: 'email', value: 'bob@acme.com', domain: 'acme.com' });
  assert.equal(classifyMatchValue('first.last@sub.acme.co.uk').kind, 'email');
});

check('bare domain form', () => {
  assert.deepEqual(classifyMatchValue('ACME.com'), { kind: 'domain', value: 'acme.com', domain: 'acme.com' });
});

check('leading-@ domain form -> domain, @ stripped', () => {
  assert.deepEqual(classifyMatchValue('@excel-pros.com'), { kind: 'domain', value: 'excel-pros.com', domain: 'excel-pros.com' });
  assert.equal(deriveRuleType('@tempstaff.net'), 'domain');
});

check('invalid', () => {
  for (const v of ['', '  ', 'not-an-email', 'payroll', 'acme', '.com', 'acme.', 'bob@acme', 'two@@x.com', '@', 'a b@x.com']) {
    assert.equal(classifyMatchValue(v).kind, 'invalid', JSON.stringify(v));
  }
});

check('deriveRuleType', () => {
  assert.equal(deriveRuleType('bob@acme.com'), 'exact_email');
  assert.equal(deriveRuleType('acme.com'), 'domain');
  assert.equal(deriveRuleType('nonsense'), null);
});

check('normalizeMatchValue', () => {
  assert.equal(normalizeMatchValue('  @Excel-Pros.COM '), 'excel-pros.com');
  assert.equal(normalizeMatchValue('Bob@Acme.com'), 'bob@acme.com');
});

check('isPlausibleDomain', () => {
  for (const v of ['acme.com', 'a.io', 'sub.acme.co.uk']) assert.ok(isPlausibleDomain(v), v);
  for (const v of ['acme', '.com', '-acme.com', 'acme-.com', 'a b.com']) assert.ok(!isPlausibleDomain(v), v);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
