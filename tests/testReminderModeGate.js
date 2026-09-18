require('dotenv').config();
// Force dry-run regardless of the real .env's live-drafting switch — this
// regression test must never attempt a real Graph call, even after
// REMINDER_DRAFT_LIVE_ENABLED=true is set for the actual running app.
process.env.REMINDER_DRAFT_LIVE_ENABLED = 'false';
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Client = require('../models/Client');
const ApplicantReminder = require('../models/ApplicantReminder');

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

const CLIENT_NAME = 'ZZZ Test Client 8';

const run = async () => {
  await connectDB();

  const realFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = (...args) => {
    fetchCalls += 1;
    throw new Error(`test guard: a Graph network call was attempted: ${args[0]}`);
  };

  let client = null;
  let reminder = null;

  try {
    const { createReminderDraft, REMINDER_SEND_ENABLED } = require('../services/reminderDraftService');
    const { actionReminders } = require('../services/applicantReminderService');

    check('REMINDER_SEND_ENABLED is still hardcoded false', REMINDER_SEND_ENABLED === false, String(REMINDER_SEND_ENABLED));

    const payload = {
      from: 'applicant-support@mja-associates.com',
      to: 'employee@zz-test.local',
      subject: 'Please complete your WOTC Questionnaire',
      body: 'link: https://x',
    };

    // --- 1. createReminderDraft(payload, 'send') must throw explicitly, not silently draft ---
    let sendError = null;
    try {
      await createReminderDraft(payload, 'send');
    } catch (error) {
      sendError = error;
    }
    check('mode=send + SEND_ENABLED=false -> throws', Boolean(sendError));
    check('mode=send error message says "not yet enabled"', /not yet enabled/i.test(sendError?.message || ''), sendError?.message);
    check('mode=send error carries statusCode 400', sendError?.statusCode === 400, String(sendError?.statusCode));
    check('mode=send never touched the network', fetchCalls === 0, `fetchCalls=${fetchCalls}`);

    // --- 2. mode='draft' (default) is completely unchanged: still a local dry-run log ---
    const draftResult = await createReminderDraft(payload);
    check('mode=draft (default) -> dryRun:true, unchanged', draftResult.dryRun === true, JSON.stringify(draftResult));
    check('mode=draft (default) -> mode:"draft" in result', draftResult.mode === 'draft');
    check('mode=draft never touched the network either', fetchCalls === 0, `fetchCalls=${fetchCalls}`);

    // --- 3. actionReminders(ids, operator, 'send') rejects the WHOLE batch upfront, before touching any row ---
    client = await Client.create({ name: CLIENT_NAME, status: 'inactive', wotcFormUrl: 'https://forms.example.com/wotc/zzz8' });
    reminder = await ApplicantReminder.create({
      clientId: client._id,
      employeeSsnHash: 'zzz8-hash-1',
      employeeName: 'ZZZ Test Employee',
      employeeSsnLast4: '1111',
      employeeEmail: 'zzz8-employee@zz-test.local',
      hireDate: new Date('2026-08-01'),
      weekEndingDate: new Date('2026-08-08'),
      logiformsStatusAtRun: 'Incomplete',
      reminderStatus: 'pending',
      complianceRunAt: new Date(),
    });

    let batchSendError = null;
    try {
      await actionReminders([String(reminder._id)], 'tester@mja-associates.com', 'send');
    } catch (error) {
      batchSendError = error;
    }
    check('actionReminders mode=send -> throws upfront', Boolean(batchSendError));
    check('actionReminders mode=send error says "not yet enabled"', /not yet enabled/i.test(batchSendError?.message || ''), batchSendError?.message);
    check('actionReminders mode=send error carries statusCode 400', batchSendError?.statusCode === 400);

    const untouchedRow = await ApplicantReminder.findById(reminder._id).lean();
    check('actionReminders mode=send left the reminder row completely untouched (still pending)', untouchedRow.reminderStatus === 'pending', untouchedRow.reminderStatus);
    check('actionReminders mode=send never touched the network', fetchCalls === 0, `fetchCalls=${fetchCalls}`);

    // --- 4. actionReminders(ids, operator, 'draft') / default -> unchanged dry-run behavior ---
    const draftBatchResults = await actionReminders([String(reminder._id)], 'tester@mja-associates.com', 'draft');
    check('actionReminders mode=draft -> 1 result', draftBatchResults.length === 1, JSON.stringify(draftBatchResults));
    check('actionReminders mode=draft -> status draft_created', draftBatchResults[0].status === 'draft_created', JSON.stringify(draftBatchResults[0]));
    check('actionReminders mode=draft -> dryRun true', draftBatchResults[0].dryRun === true);

    const rowAfterDraft = await ApplicantReminder.findById(reminder._id).lean();
    check('reminder row now draft_created', rowAfterDraft.reminderStatus === 'draft_created', rowAfterDraft.reminderStatus);
    check('reminder row reminderMode draft', rowAfterDraft.reminderMode === 'draft', rowAfterDraft.reminderMode);
    check('reminder row dryRun true', rowAfterDraft.dryRun === true);
    check('reminder row has no graphDraftId (nothing hit Graph)', !rowAfterDraft.graphDraftId, rowAfterDraft.graphDraftId);
    check('actionReminders mode=draft never touched the network', fetchCalls === 0, `fetchCalls=${fetchCalls}`);

    // --- 5. default (no mode arg at all) behaves the same as explicit 'draft' ---
    await ApplicantReminder.updateOne({ _id: reminder._id }, { reminderStatus: 'pending', dryRun: false, graphDraftId: null });
    const defaultResults = await actionReminders([String(reminder._id)], 'tester@mja-associates.com');
    check('actionReminders default mode -> status draft_created (same as explicit draft)', defaultResults[0].status === 'draft_created', JSON.stringify(defaultResults[0]));
  } finally {
    global.fetch = realFetch;
    if (reminder) await ApplicantReminder.deleteOne({ _id: reminder._id });
    if (client) await Client.deleteOne({ _id: client._id });
    console.log('\ncleanup: ZZZ Test Client 8 + its reminder row removed');
    await mongoose.connection.close();
  }

  console.log(`\n${FAIL ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'}  (${PASS} passed, ${FAIL} failed)`);
  process.exit(FAIL ? 1 : 0);
};

run().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exit(1);
});
