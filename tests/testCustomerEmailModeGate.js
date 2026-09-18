require('dotenv').config();
// Force dry-run regardless of the real .env's live-drafting switch — this
// regression test must never attempt a real Graph/Dropbox call, even after
// COMPLIANCE_DRAFT_LIVE_ENABLED=true is set for the actual running app.
process.env.COMPLIANCE_DRAFT_LIVE_ENABLED = 'false';
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Client = require('../models/Client');
const ComplianceReportLog = require('../models/ComplianceReportLog');
const CustomerReportEmail = require('../models/CustomerReportEmail');

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

const CLIENT_NAME = 'ZZZ Test Client 12';

const run = async () => {
  await connectDB();

  const realFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = (...args) => {
    fetchCalls += 1;
    throw new Error(`test guard: a Graph/Dropbox network call was attempted: ${args[0]}`);
  };

  let client = null;
  let log = null;
  let row = null;

  try {
    const { createCustomerReportEmail, COMPLIANCE_EMAIL_SEND_ENABLED } = require('../services/customerEmailDraftService');
    const { actionCustomerReportEmails } = require('../services/customerReportEmailService');

    check('COMPLIANCE_EMAIL_SEND_ENABLED is hardcoded false', COMPLIANCE_EMAIL_SEND_ENABLED === false, String(COMPLIANCE_EMAIL_SEND_ENABLED));

    const payload = {
      from: 'reports@mja-associates.com',
      to: 'zzz12-customer@zz-test.local',
      subject: 'Compliance Report - ZZZ Test Client 12',
      body: 'Hi team,\n\nPlease find attached the compliance report.',
      reportFilePath: '/ZZZ Test Client 12/Compliance Reports/does-not-need-to-exist-for-this-check.xlsx',
    };

    // --- 1. createCustomerReportEmail(payload, 'send') must throw explicitly ---
    let sendError = null;
    try {
      await createCustomerReportEmail(payload, 'send');
    } catch (error) {
      sendError = error;
    }
    check('mode=send + SEND_ENABLED=false -> throws', Boolean(sendError));
    check('mode=send error message says "not yet enabled"', /not yet enabled/i.test(sendError?.message || ''), sendError?.message);
    check('mode=send error carries statusCode 400', sendError?.statusCode === 400);
    check('mode=send never touched the network', fetchCalls === 0, `fetchCalls=${fetchCalls}`);

    // --- 2. mode='draft' (default) -> dry-run log only, no Dropbox download, no Graph call ---
    const draftResult = await createCustomerReportEmail(payload);
    check('mode=draft (default) -> dryRun:true', draftResult.dryRun === true, JSON.stringify(draftResult));
    check('mode=draft (default) -> mode:"draft"', draftResult.mode === 'draft');
    check('mode=draft never touched the network (no Dropbox download for a fake path)', fetchCalls === 0, `fetchCalls=${fetchCalls}`);

    // --- 3. actionCustomerReportEmails(ids, operator, 'send') rejects the WHOLE batch upfront ---
    client = await Client.create({ name: CLIENT_NAME, status: 'inactive' });
    log = await ComplianceReportLog.create({
      clientId: client._id,
      generatedAt: new Date(),
      reportType: 'Client',
      filePath: `/ZZZ Test Client 12/Compliance Reports/fake.xlsx`,
      totalEmployees: 2,
      completedCount: 1,
      incompleteCount: 1,
      success: true,
    });
    row = await CustomerReportEmail.create({
      clientId: client._id,
      complianceReportLogId: log._id,
      generatedAt: log.generatedAt,
      emailSalutation: 'Hi team',
      customerEmail: 'zzz12-customer@zz-test.local',
      reportFilePath: log.filePath,
      status: 'pending',
    });

    let batchSendError = null;
    try {
      await actionCustomerReportEmails([String(row._id)], 'tester@mja-associates.com', 'send');
    } catch (error) {
      batchSendError = error;
    }
    check('actionCustomerReportEmails mode=send -> throws upfront', Boolean(batchSendError));
    check('actionCustomerReportEmails mode=send error says "not yet enabled"', /not yet enabled/i.test(batchSendError?.message || ''), batchSendError?.message);
    check('actionCustomerReportEmails mode=send error carries statusCode 400', batchSendError?.statusCode === 400);

    const untouchedRow = await CustomerReportEmail.findById(row._id).lean();
    check('actionCustomerReportEmails mode=send left the row untouched (still pending)', untouchedRow.status === 'pending', untouchedRow.status);
    check('actionCustomerReportEmails mode=send never touched the network', fetchCalls === 0, `fetchCalls=${fetchCalls}`);

    // --- 4. actionCustomerReportEmails mode='draft' -> unchanged dry-run behavior ---
    const draftBatchResults = await actionCustomerReportEmails([String(row._id)], 'tester@mja-associates.com', 'draft');
    check('actionCustomerReportEmails mode=draft -> 1 result', draftBatchResults.length === 1, JSON.stringify(draftBatchResults));
    check('actionCustomerReportEmails mode=draft -> status draft_created', draftBatchResults[0].status === 'draft_created', JSON.stringify(draftBatchResults[0]));
    check('actionCustomerReportEmails mode=draft -> dryRun true', draftBatchResults[0].dryRun === true);

    const rowAfterDraft = await CustomerReportEmail.findById(row._id).lean();
    check('row now draft_created', rowAfterDraft.status === 'draft_created', rowAfterDraft.status);
    check('row emailMode draft', rowAfterDraft.emailMode === 'draft', rowAfterDraft.emailMode);
    check('row dryRun true', rowAfterDraft.dryRun === true);
    check('row has no graphMessageId (nothing hit Graph)', !rowAfterDraft.graphMessageId, rowAfterDraft.graphMessageId);
    check('actionCustomerReportEmails mode=draft never touched the network', fetchCalls === 0, `fetchCalls=${fetchCalls}`);
  } finally {
    global.fetch = realFetch;
    if (row) await CustomerReportEmail.deleteOne({ _id: row._id });
    if (log) await ComplianceReportLog.deleteOne({ _id: log._id });
    if (client) await Client.deleteOne({ _id: client._id });
    console.log('\ncleanup: ZZZ Test Client 12 + its log + its email row removed');
    await mongoose.connection.close();
  }

  console.log(`\n${FAIL ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'}  (${PASS} passed, ${FAIL} failed)`);
  process.exit(FAIL ? 1 : 0);
};

run().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exit(1);
});
