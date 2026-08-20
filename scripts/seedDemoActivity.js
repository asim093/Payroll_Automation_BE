/**
 * PHASE-UI-3 — inserts realistic-looking demo EmailLog/FileLog rows so the
 * new dashboard (Process Cards, Recent Activity feed, filters) can be
 * screenshotted/demoed with actual volume instead of an empty or
 * single-test-client dataset.
 *
 * Every row this script inserts gets isDemoData: true (see the matching
 * field added to models/EmailLog.js and models/FileLog.js) — that's the
 * ONLY thing that distinguishes it from real data, and it's what
 * scripts/removeDemoActivity.js keys off of to clean back up afterward.
 * Nothing here ever touches a row that doesn't already have that flag.
 *
 * Prefers linking demo rows to REAL clients already in the database (so
 * Client Profile pages/counts look populated too) — falls back to a
 * generic name if none exist, with no client link (shows as "N/A", same
 * as a genuinely unmatched item would).
 *
 * USAGE:
 *   node scripts/seedDemoActivity.js         -> prompts for confirmation
 *   node scripts/seedDemoActivity.js --yes    -> skips the prompt (for
 *                                                scripted/CI use)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');
const crypto = require('crypto');
const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');
const Client = require('../models/Client');

const SKIP_CONFIRM = process.argv.includes('--yes') || process.argv.includes('-y');

// 18 of each => 36 total, inside both "15-20 per sync-type" and
// "30-40 total" from the spec.
const ENTRIES_PER_TYPE = 18;
const MAX_DAYS_AGO = 4;

const FALLBACK_CLIENT_NAMES = [
  'Acme Staffing',
  'Wilson & Co',
  'Bright Path Logistics',
  'Summit HR Partners',
  'Riverstone Solutions',
];

const SENDER_LOCAL_PARTS = ['hr', 'payroll', 'onboarding', 'admin', 'benefits'];

const SUBJECTS = [
  'New Hire Documents',
  'W-2 Request',
  'Timesheet Submission - This Week',
  'Payroll Correction Needed',
  'Direct Deposit Update',
  'I-9 Verification Docs',
  'Termination Notice',
  'Onboarding Packet',
  'Updated Tax Withholding Form',
  'Background Check Result',
];

const FILE_NAMES = [
  'W2_2025.pdf',
  'I9_Form_Signed.pdf',
  'VoidedCheck.jpg',
  'DirectDeposit_Form.pdf',
  'Timesheet_Week32.xlsx',
  'Offer_Letter_Signed.pdf',
  'Background_Check_Result.pdf',
  'ID_Verification.pdf',
  'W4_Withholding.pdf',
  'Emergency_Contact_Form.pdf',
];

const ERROR_MESSAGES = [
  'Dropbox upload failed: rate limited, please retry',
  'ShareFile API timeout while fetching file content',
  'Local fallback also failed: disk quota exceeded',
  'Attachment no longer available on the source email',
];

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[randomInt(0, arr.length - 1)];
const randomPastDate = (maxDaysAgo = MAX_DAYS_AGO) =>
  new Date(Date.now() - randomInt(0, maxDaysAgo * 24 * 60 * 60 * 1000));

// Weighted so most demo rows look like a healthy system (mostly success),
// with a believable minority needing review or failed - enough to exercise
// every StatusBadge color/icon without looking like everything is broken.
const weightedOutcome = () => {
  const roll = Math.random();
  if (roll < 0.72) return 'success';
  if (roll < 0.9) return 'needs_review';
  return 'failed';
};

const confirm = async (question) => {
  if (SKIP_CONFIRM) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
};

const buildEmailDocs = (realClients) =>
  Array.from({ length: ENTRIES_PER_TYPE }, () => {
    const client = realClients.length > 0 ? pick(realClients) : null;
    const companyName = client?.name || pick(FALLBACK_CLIENT_NAMES);
    const domain = `${companyName.toLowerCase().replace(/[^a-z0-9]+/g, '')}.com`;
    const outcome = weightedOutcome();
    const status = outcome === 'success' ? 'processed' : outcome;

    return {
      messageId: `demo-email-${crypto.randomUUID()}`,
      sender: `${pick(SENDER_LOCAL_PARTS)}@${domain}`,
      subject: pick(SUBJECTS),
      receivedAt: randomPastDate(),
      // needs_review rows deliberately have no matched client - that's what
      // "needs review" means for a real one too.
      matchedClientId: status === 'needs_review' ? undefined : client?._id,
      status,
      categoryAssigned: status === 'processed',
      outlookCopySaved: status === 'processed',
      attachments: [{ filename: pick(FILE_NAMES), size: randomInt(15000, 900000) }],
      sourceType: 'outlook_attachment',
      authMode: Math.random() < 0.5 ? 'delegated' : 'app-only',
      processingError: status === 'failed' ? pick(ERROR_MESSAGES) : undefined,
      isDemoData: true,
    };
  });

const buildFileDocs = (realClients) =>
  Array.from({ length: ENTRIES_PER_TYPE }, () => {
    const client = realClients.length > 0 ? pick(realClients) : null;
    // Mixed source so both Mail Sync (outlook attachments) and ShareFile
    // Bridge (sharefile-discovered files) show demo volume - see
    // utils/activityFeed.js's process split, which keys off this field.
    const source = Math.random() < 0.55 ? 'sharefile' : 'outlook';
    const outcome = weightedOutcome();
    const status = outcome === 'success' ? 'moved' : outcome;
    const fileName = pick(FILE_NAMES);

    return {
      source,
      originalName: fileName,
      sourceFileId: source === 'sharefile' ? `demo-sf-${crypto.randomUUID()}` : undefined,
      sourceMessageId: source === 'outlook' ? `demo-msg-${crypto.randomUUID()}` : undefined,
      clientId: status === 'needs_review' ? undefined : client?._id,
      destinationPath: client ? `/${client.name}/${fileName}` : undefined,
      destination: 'dropbox',
      processedAt: randomPastDate(),
      status,
      fallbackUsed: false,
      errorMessage: status === 'failed' ? pick(ERROR_MESSAGES) : undefined,
      isDemoData: true,
    };
  });

const run = async () => {
  console.log('\n=== Demo Activity Seeder ===\n');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  const realClients = await Client.find().limit(30).lean();
  if (realClients.length > 0) {
    console.log(`Found ${realClients.length} real client(s) - demo entries will link to them.`);
  } else {
    console.log('No clients found - demo entries will use generic company names with no client link.');
  }

  const proceed = await confirm(
    `\nThis will insert ${ENTRIES_PER_TYPE} demo EmailLog + ${ENTRIES_PER_TYPE} demo FileLog entries ` +
      `(${ENTRIES_PER_TYPE * 2} total, all flagged isDemoData: true, spread over the last ${MAX_DAYS_AGO} days).\n` +
      'Remove them anytime with `node scripts/removeDemoActivity.js`.\n\n' +
      'Seed demo entries? (y/n) '
  );

  if (!proceed) {
    console.log('\nCancelled - nothing was written.');
    await mongoose.disconnect();
    return;
  }

  const emailDocs = buildEmailDocs(realClients);
  const fileDocs = buildFileDocs(realClients);

  await EmailLog.insertMany(emailDocs);
  await FileLog.insertMany(fileDocs);

  console.log(`\nInserted ${emailDocs.length} demo EmailLog entries and ${fileDocs.length} demo FileLog entries.`);
  console.log('Reload the dashboard to see them in Recent Activity / Process Cards.');
  console.log('Run `node scripts/removeDemoActivity.js` when you are done demoing.\n');

  await mongoose.disconnect();
};

run().catch((error) => {
  console.error('SEED ERROR:', error);
  process.exit(1);
});
