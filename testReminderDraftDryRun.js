require('dotenv').config();

let PASS = 0;
let FAIL = 0;
const check = (label, cond, detail) => {
  if (cond) {
    PASS += 1;
    console.log(`  PASS  ${label}`);
  } else {
    FAIL += 1;
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ''}`);
  }
};

const run = async () => {
  const { createReminderDraft, isDryRun, REMINDER_SEND_ENABLED } = require('./services/reminderDraftService');

  const realFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = (...args) => {
    fetchCalls += 1;
    throw new Error(`test guard: reminderDraftService made a network call: ${args[0]}`);
  };

  const payload = { from: 'noreply@example.com', to: 'employee@zz-test.local', subject: 'Please complete your WOTC Questionnaire', body: 'link: https://x' };

  try {
    check('REMINDER_SEND_ENABLED is hardcoded false', REMINDER_SEND_ENABLED === false, String(REMINDER_SEND_ENABLED));

    delete process.env.REMINDER_DRAFTS_DRY_RUN;
    check('env unset -> isDryRun() true', isDryRun() === true);
    const r1 = await createReminderDraft(payload);
    check('env unset -> createReminderDraft returns dryRun:true', r1.dryRun === true, JSON.stringify(r1));
    check('env unset -> graphDraftId null', r1.graphDraftId === null);
    check('env unset -> payloadPreview echoes the payload', r1.payloadPreview && r1.payloadPreview.to === payload.to && r1.payloadPreview.subject === payload.subject);

    process.env.REMINDER_DRAFTS_DRY_RUN = 'false';
    check("env='false' -> STILL isDryRun() true (hardcoded layer wins)", isDryRun() === true);
    const r2 = await createReminderDraft(payload);
    check("env='false' -> STILL dryRun:true", r2.dryRun === true, JSON.stringify(r2));

    process.env.REMINDER_DRAFTS_DRY_RUN = 'true';
    check("env='true' -> isDryRun() true", isDryRun() === true);
    const r3 = await createReminderDraft(payload);
    check("env='true' -> dryRun:true", r3.dryRun === true);

    process.env.REMINDER_DRAFTS_DRY_RUN = 'garbage';
    check("env='garbage' -> isDryRun() true (only 'false' opts out)", isDryRun() === true);

    let threw = null;
    try {
      await createReminderDraft({ from: 'x', subject: 's', body: 'b' });
    } catch (error) {
      threw = error;
    }
    check('missing recipient -> throws', Boolean(threw) && /recipient/.test(threw.message));

    check('global.fetch was never called during any scenario', fetchCalls === 0, `fetchCalls=${fetchCalls}`);
  } finally {
    global.fetch = realFetch;
    delete process.env.REMINDER_DRAFTS_DRY_RUN;
  }

  console.log(`\n${FAIL ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'}  (${PASS} passed, ${FAIL} failed)`);
  process.exit(FAIL ? 1 : 0);
};

run().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exit(1);
});
