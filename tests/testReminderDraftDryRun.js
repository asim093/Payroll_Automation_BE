require('dotenv').config();
// Force dry-run regardless of the real .env's live-drafting switch — this
// regression test must never attempt a real Graph call, even after
// REMINDER_DRAFT_LIVE_ENABLED=true is set for the actual running app.
process.env.REMINDER_DRAFT_LIVE_ENABLED = 'false';

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
  const { createReminderDraft, isDryRun, REMINDER_SEND_ENABLED } = require('../services/reminderDraftService');

  const realFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = (...args) => {
    fetchCalls += 1;
    throw new Error(`test guard: reminderDraftService made a network call: ${args[0]}`);
  };

  const payload = { from: 'noreply@example.com', to: 'employee@zz-test.local', subject: 'Please complete your WOTC Questionnaire', body: 'link: https://x' };

  try {
    check('REMINDER_SEND_ENABLED is hardcoded false', REMINDER_SEND_ENABLED === false, String(REMINDER_SEND_ENABLED));

    // isDryRun() is gated by REMINDER_DRAFT_LIVE_ENABLED (env-configurable,
    // forced to 'false' above for this test), independent of
    // REMINDER_SEND_ENABLED — that second, always-hardcoded-false constant
    // gates mode='send' only (blocked vs real send), checked separately below.
    check('isDryRun() is true while REMINDER_DRAFT_LIVE_ENABLED is forced false', isDryRun() === true);

    const r1 = await createReminderDraft(payload);
    check('default mode -> createReminderDraft returns dryRun:true', r1.dryRun === true, JSON.stringify(r1));
    check('default mode -> mode:"draft"', r1.mode === 'draft');
    check('default mode -> graphDraftId null', r1.graphDraftId === null);
    check('default mode -> payloadPreview echoes the payload', r1.payloadPreview && r1.payloadPreview.to === payload.to && r1.payloadPreview.subject === payload.subject);

    const r2 = await createReminderDraft(payload, 'draft');
    check("explicit mode='draft' -> same dryRun:true behavior", r2.dryRun === true, JSON.stringify(r2));

    let sendError = null;
    try {
      await createReminderDraft(payload, 'send');
    } catch (error) {
      sendError = error;
    }
    check("mode='send' while disabled -> throws explicitly (never falls back to draft)", Boolean(sendError));
    check('send-blocked error message says "not yet enabled"', /not yet enabled/i.test(sendError?.message || ''), sendError?.message);
    check('send-blocked error carries statusCode 400', sendError?.statusCode === 400);

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
  }

  console.log(`\n${FAIL ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'}  (${PASS} passed, ${FAIL} failed)`);
  process.exit(FAIL ? 1 : 0);
};

run().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exit(1);
});
