require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');
const readline = require('readline');
const Client = require('../models/Client');
const EmailLog = require('../models/EmailLog');
const ReviewQueue = require('../models/ReviewQueue');
const { matchClientBySender, matchInactiveClientBySender } = require('../services/clientMatcher');

const SUBJECT_PREFIX = '[QA-TEST]';
const DEFAULT_SENDER = 'qa-test@example.com';
const DEFAULT_COUNT = 1;
const MAX_COUNT = 50;

const SKIP_CONFIRM = process.argv.includes('--yes') || process.argv.includes('-y');
const FORCE = process.argv.includes('--force');
const CLEANUP = process.argv.includes('--cleanup');

const SUBJECT_POOL = [
  'New Hire Documents (attached)',
  'WOTC Questionnaire - see attachment',
  'Timesheet Submission - Attached',
  'I-9 Verification Docs Attached',
  'Onboarding Packet - Please see attachment',
  'Signed WOTC Form Enclosed',
  'Employee Paperwork Attached',
  'Weekly WOTC Activity Report Attached',
];

const getArg = (name, fallback) => {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found !== undefined ? found.slice(prefix.length) : fallback;
};

const confirm = async (question) => {
  if (SKIP_CONFIRM) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
};

const assertNotProduction = () => {
  const uri = process.env.MONGODB_URI || '';
  const hostMatch = uri.match(/@([^/]+)\//);
  const host = hostMatch ? hostMatch[1] : '(unknown host)';
  const dbMatch = uri.match(/\/([^/?]+)(\?|$)/);
  const dbName = dbMatch ? dbMatch[1] : '(unknown db)';

  console.log(`\nTarget database: ${host}/${dbName}`);

  const looksLikeDevOrTest = /localhost|127\.0\.0\.1|dev|test|staging|sandbox/i.test(uri);
  if (looksLikeDevOrTest || FORCE) {
    if (!looksLikeDevOrTest && FORCE) {
      console.log('WARNING: this connection string does not look like a dev/test database, but --force was passed - proceeding anyway.');
    }
    return;
  }

  console.error(
    '\nREFUSING TO RUN: MONGODB_URI does not look like a dev/test/staging database ' +
      '(no "localhost", "dev", "test", "staging", or "sandbox" found in it).\n' +
      'This script writes fake ingestion data and is not meant to run against a shared/production database.\n\n' +
      'If you are certain this connection is safe to seed test data into, re-run with --force.\n'
  );
  process.exit(1);
};

const fakeGraphId = () => crypto.randomBytes(110).toString('base64url');

const buildSenderList = (rawSender, count) => {
  const trimmed = (rawSender || DEFAULT_SENDER).trim().toLowerCase();
  const [localPart, domain] = trimmed.includes('@') ? trimmed.split('@') : [null, trimmed];

  return Array.from({ length: count }, (_, index) => {
    if (index === 0 && localPart) return `${localPart}@${domain}`;
    const tag = localPart ? `${localPart}+${index + 1}` : `qa-test-${index + 1}`;
    return `${tag}@${domain}`;
  });
};

const decideOutcome = async (sender, subject, activeClients) => {
  const matchResult = await matchClientBySender(sender, subject, activeClients);
  if (matchResult) {
    return { outcome: 'matched', client: matchResult.client, matchMethod: matchResult.method };
  }

  const inactiveMatch = await matchInactiveClientBySender(sender);
  const suggestedClient = inactiveMatch || null;
  const reason = inactiveMatch ? 'client_inactive' : 'no_match';

  return { outcome: 'needs_review', reason, suggestedClient };
};

const seed = async () => {
  const sender = getArg('sender', DEFAULT_SENDER);
  const count = Math.min(MAX_COUNT, Math.max(1, parseInt(getArg('count', String(DEFAULT_COUNT)), 10) || DEFAULT_COUNT));
  const customSubject = getArg('subject', null);

  console.log('\n=== Test Ingestion Seeder ===');
  assertNotProduction();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  const senders = buildSenderList(sender, count);
  console.log(`\nAbout to seed ${count} fake "Needs Review" style ingestion item(s):`);
  senders.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

  const proceed = await confirm('\nProceed? (y/n) ');
  if (!proceed) {
    console.log('\nCancelled - nothing was written.');
    await mongoose.disconnect();
    return;
  }

  const activeClients = await Client.find({ status: 'active' });
  let matchedCount = 0;
  let needsReviewCount = 0;

  for (let i = 0; i < senders.length; i += 1) {
    const senderAddress = senders[i];
    const subject = customSubject
      ? `${SUBJECT_PREFIX} ${customSubject}`
      : `${SUBJECT_PREFIX} ${SUBJECT_POOL[i % SUBJECT_POOL.length]} #${i + 1}`;
    const receivedAt = new Date(Date.now() - i * 60 * 1000);

    const decision = await decideOutcome(senderAddress, subject, activeClients);

    const emailLog = await EmailLog.create({
      messageId: `qa-test-seed-${crypto.randomUUID()}`,
      internetMessageId: `<qa-test-${crypto.randomUUID()}@example.test>`,
      sender: senderAddress,
      subject,
      receivedAt,
      matchedClientId: decision.outcome === 'matched' ? decision.client._id : null,
      status: decision.outcome === 'matched' ? 'processed' : 'needs_review',
      categoryAssigned: false,
      outlookCopySaved: false,
      attachments: [],
      sourceType: 'outlook_attachment',
      authMode: 'delegated',
      matchMethod: decision.outcome === 'matched' ? decision.matchMethod : undefined,
      isDemoData: true,
    });

    if (decision.outcome === 'matched') {
      matchedCount += 1;
      console.log(`  [ASSIGNED] ${senderAddress} — matched "${decision.client.name}" (${decision.matchMethod})`);
    } else {
      needsReviewCount += 1;
      await ReviewQueue.create({
        type: 'email',
        referenceId: emailLog._id,
        reason: decision.reason,
        suggestedClientId: decision.suggestedClient?._id,
      });
      console.log(
        `  [NEEDS REVIEW] ${senderAddress} — reason: ${decision.reason}` +
          (decision.suggestedClient ? ` (suggested: ${decision.suggestedClient.name})` : '')
      );
    }
  }

  console.log(`\nDone. ${matchedCount} auto-assigned, ${needsReviewCount} sent to Needs Review.`);
  console.log('Reload the Ingestion page to see them. Clean up anytime with:');
  console.log('  node scripts/seed-test-ingestion.js --cleanup\n');

  await mongoose.disconnect();
};

const cleanup = async () => {
  console.log('\n=== Test Ingestion Cleanup ===');
  assertNotProduction();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  const testLogs = await EmailLog.find({ subject: { $regex: `^${SUBJECT_PREFIX.replace(/[[\]]/g, '\\$&')}` } }).lean();

  if (testLogs.length === 0) {
    console.log(`\nNo items found with a "${SUBJECT_PREFIX}" subject prefix - nothing to remove.`);
    await mongoose.disconnect();
    return;
  }

  console.log(`\nFound ${testLogs.length} test ingestion item(s) to remove (real data is untouched):`);
  testLogs.forEach((log, i) => console.log(`  ${i + 1}. [${log.status}] ${log.sender} — "${log.subject}"`));

  const proceed = await confirm(`\nDelete all ${testLogs.length} test item(s)? (y/n) `);
  if (!proceed) {
    console.log('\nCancelled - nothing was deleted.');
    await mongoose.disconnect();
    return;
  }

  const logIds = testLogs.map((log) => log._id);
  const reviewResult = await ReviewQueue.deleteMany({ referenceId: { $in: logIds } });
  const logResult = await EmailLog.deleteMany({ _id: { $in: logIds } });

  console.log(`\nDeleted ${logResult.deletedCount} EmailLog entries and ${reviewResult.deletedCount} ReviewQueue entries.\n`);

  await mongoose.disconnect();
};

(async () => {
  try {
    if (CLEANUP) {
      await cleanup();
    } else {
      await seed();
    }
  } catch (error) {
    console.error('SCRIPT ERROR:', error);
    process.exit(1);
  }
})();
