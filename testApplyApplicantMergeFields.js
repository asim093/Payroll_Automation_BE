const { applyApplicantMergeFields, APPLICANT_MERGE_FIELD_PATTERN } = require('./utils/applyApplicantMergeFields');
const { DEFAULT_SUBJECT, DEFAULT_BODY } = require('./services/reminderDraftService');

let PASS = 0;
let FAIL = 0;
const check = (label, pass, detail) => {
  if (pass) {
    PASS += 1;
    console.log(`  PASS  ${label}`);
  } else {
    FAIL += 1;
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ''}`);
  }
};

const run = () => {
  const values = { Customer: 'Acme Staffing Co.', 'WOTC Form URL': 'https://forms.example.com/wotc/acme' };

  console.log('=== TEST 1: default subject/body merge against the real legacy-text constants ===');
  const outSubject = applyApplicantMergeFields(DEFAULT_SUBJECT, values);
  const outBody = applyApplicantMergeFields(DEFAULT_BODY, values);
  check('subject has no tokens (none present)', outSubject === DEFAULT_SUBJECT);
  check('body: {{Customer}} replaced', outBody.includes('Your employer, Acme Staffing Co., participates'));
  check('body: {{WOTC Form URL}} replaced', outBody.includes('https://forms.example.com/wotc/acme'));
  check('body: no {{ }} tokens remain', !/\{\{.*\}\}/.test(outBody));

  console.log('\n=== TEST 2: token handling ===');
  check('inner whitespace {{ Customer }} handled', applyApplicantMergeFields('Hi {{ Customer }}', values) === 'Hi Acme Staffing Co.');
  check('missing value -> empty string', applyApplicantMergeFields('X{{Customer}}Y', {}) === 'XY');
  check('null text -> ""', applyApplicantMergeFields(null, values) === '');
  check('undefined values arg -> tokens blanked', applyApplicantMergeFields('a{{Customer}}b') === 'ab');
  check('global replace (multiple occurrences)', applyApplicantMergeFields('{{Customer}}/{{Customer}}', values) === 'Acme Staffing Co./Acme Staffing Co.');
  check('repeated calls stable (no lastIndex leak)', applyApplicantMergeFields('{{Customer}}', values) === applyApplicantMergeFields('{{Customer}}', values));

  console.log('\n=== TEST 3: isolation from the customer-report merge tokens ===');
  check(
    'does NOT touch {{Client Name}}/{{Salutation}}',
    applyApplicantMergeFields('{{Client Name}} {{Salutation}}', values) === '{{Client Name}} {{Salutation}}'
  );

  console.log('\n=== TEST 4: pattern is locked to exactly (Customer|WOTC Form URL) ===');
  check(
    'pattern source is exactly the expected regex',
    APPLICANT_MERGE_FIELD_PATTERN.source === '\\{\\{\\s*(Customer|WOTC Form URL)\\s*\\}\\}'
  );
  check('pattern flags include g', APPLICANT_MERGE_FIELD_PATTERN.flags === 'g');

  console.log(`\n${FAIL ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'} (${PASS} passed, ${FAIL} failed)`);
  process.exit(FAIL ? 1 : 0);
};

run();
