/**
 * Test harness for the Ingestion "auto-rules" (ignore / assign) feature.
 * Creates fake Needs-Review items WITHOUT sending real mail or touching Dropbox/ShareFile,
 * applying the SAME rule checks the real ingestion pipeline does, so you can verify:
 *   - toggle OFF + Dismiss  -> item only
 *   - toggle ON  + Dismiss  -> IgnoreRule (action: ignore); future items skip Needs Review
 *   - toggle ON  + Assign   -> MatchingRule (email) / IgnoreRule (action: assign, sharefile/dropbox)
 *
 * Usage:
 *   node testIngestionRules.js status
 *       Show every ignore/assign rule + how many test items are review / dismissed / ignored / assigned.
 *
 *   node testIngestionRules.js email [count] [sender]
 *       Create N fake email review items. Default: 3 from test-dismiss@zz-review-test.local
 *       If an ignore rule already matches the sender -> creates them as EmailLog status "ignored"
 *       (no ReviewQueue entry), exactly like emailProcessor does.
 *
 *   node testIngestionRules.js sharefile [count] [topFolder]
 *       Create N fake unmatched-ShareFile items under  Clients/<topFolder>/...
 *       Default: 3 under  Clients/ZZ Rule Test Folder
 *       - folder_path IGNORE rule matches -> not created (skipped, like recordUnmatchedFile)
 *       - folder_path ASSIGN rule matches -> created as status "resolved" to that client
 *       - otherwise -> status "unresolved" (shows in Needs Review)
 *
 *   node testIngestionRules.js cleanup
 *       Remove every EmailLog / ReviewQueue / UnmatchedShareFileItem this script ever made,
 *       plus any IgnoreRule whose value points at the test sender/folder.
 *
 * Everything it creates is tagged so cleanup is exact:
 *   EmailLog.messageId               starts with  "test-review-"     (+ isDemoData: true)
 *   UnmatchedShareFileItem.itemId    starts with  "test-sf-"
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const EmailLog = require('./models/EmailLog');
const ReviewQueue = require('./models/ReviewQueue');
const UnmatchedShareFileItem = require('./models/UnmatchedShareFileItem');
const IgnoreRule = require('./models/IgnoreRule');
const Client = require('./models/Client');
const {
  isSenderIgnored,
  isShareFilePathIgnored,
  shareFileFolderAssignClientId,
  listIgnoreRules,
} = require('./services/ignoreRuleService');
const { matchClientBySender } = require('./services/clientMatcher');

const EMAIL_PREFIX = 'test-review-';
const SF_PREFIX = 'test-sf-';
const DEFAULT_SENDER = 'test-dismiss@zz-review-test.local';
const DEFAULT_SF_FOLDER = 'ZZ Rule Test Folder';

const pad = (n, w) => String(n).padStart(w);

// ---------------------------------------------------------------- status
async function status() {
  const rules = await listIgnoreRules();
  console.log(`\n=== Ignore / Assign rules (${rules.length}) ===`);
  if (rules.length === 0) console.log('  (none)');
  for (const r of rules) {
    const target = r.action === 'assign' ? `assign -> ${r.clientId?.name || r.clientId || '?'}` : 'ignore';
    console.log(`  ${r.scope.padEnd(9)} ${r.type.padEnd(14)} ${String(r.value).padEnd(38)} ${target}${r.active ? '' : '  [inactive]'}`);
  }

  const matchingRules = await mongoose.connection
    .collection('matchingrules')
    .find({})
    .toArray()
    .catch(() => []);
  console.log(`\n=== MatchingRules (client auto-assign for email) : ${matchingRules.length} total ===`);

  const emailLogs = await EmailLog.find({ messageId: new RegExp(`^${EMAIL_PREFIX}`) }).lean();
  const emailIds = emailLogs.map((e) => e._id);
  const rq = await ReviewQueue.find({ type: 'email', referenceId: { $in: emailIds } }).lean();
  const rqOpen = rq.filter((e) => !e.archivedReason && !e.resolvedClientId).length;
  const rqDismissed = rq.filter((e) => e.archivedReason).length;
  const rqResolved = rq.filter((e) => e.resolvedClientId).length;
  console.log(`\n=== TEST EMAIL items (messageId ^${EMAIL_PREFIX}) : ${emailLogs.length} ===`);
  console.log(`  EmailLog status: ${JSON.stringify(count(emailLogs.map((e) => e.status)))}`);
  console.log(`  ReviewQueue    : open ${rqOpen}   dismissed ${rqDismissed}   resolved ${rqResolved}   (no-queue ${emailLogs.length - rq.length})`);

  const sf = await UnmatchedShareFileItem.find({ itemId: new RegExp(`^${SF_PREFIX}`) })
    .populate('resolvedClientId', 'name')
    .lean();
  console.log(`\n=== TEST SHAREFILE items (itemId ^${SF_PREFIX}) : ${sf.length} ===`);
  console.log(`  status: ${JSON.stringify(count(sf.map((s) => s.status)))}`);
  sf.filter((s) => s.status === 'resolved').forEach((s) =>
    console.log(`     resolved -> ${s.resolvedClientId?.name || s.resolvedClientId}   ${s.path}`)
  );
  console.log('');
}

const count = (arr) => arr.reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {});

// ---------------------------------------------------------------- email
async function createEmails(n, sender) {
  const ignored = await isSenderIgnored(sender);
  const matched = await matchClientBySender(sender, '', undefined).catch(() => null);
  const now = Date.now();
  for (let i = 0; i < n; i += 1) {
    const messageId = `${EMAIL_PREFIX}${now}-${i}`;
    const emailLog = await EmailLog.create({
      messageId,
      internetMessageId: `<${messageId}@test.local>`,
      sender,
      subject: `TEST email #${i + 1} — ${new Date(now).toISOString().slice(0, 16)}`,
      receivedAt: new Date(now - i * 60000),
      status: ignored ? 'ignored' : matched ? 'processed' : 'needs_review',
      matchedClientId: !ignored && matched ? matched.client._id : null,
      matchMethod: !ignored && matched ? matched.method : undefined,
      attachments: [],
      authMode: 'app-only',
      sourceType: 'outlook_attachment',
      isDemoData: true,
    });
    if (!ignored && !matched) {
      await ReviewQueue.create({ type: 'email', referenceId: emailLog._id, reason: 'no_match' });
    }
    console.log(`  + ${messageId}  status=${emailLog.status}${!ignored && matched ? ` (auto-assigned -> ${matched.client.name} via ${matched.method})` : ''}`);
  }
  if (ignored) {
    console.log(`\nAn active IGNORE rule matches "${sender}" -> ${n} EmailLog(s) with status "ignored", NOT added to Needs Review (correct).`);
  } else if (matched) {
    console.log(`\nA MatchingRule matches "${sender}" -> ${n} email(s) auto-assigned to "${matched.client.name}" (status processed), NOT in Needs Review (correct).`);
  } else {
    console.log(`\n${n} email item(s) added to Needs Review from "${sender}". Open Ingestion -> Needs Review -> Email.`);
  }
}

// ---------------------------------------------------------------- sharefile
async function createShareFile(n, topFolder) {
  const shareRoot = 'Clients';
  const topPath = `${shareRoot}/${topFolder}`;
  const assignClientId = await shareFileFolderAssignClientId(topPath);
  const assignClient = assignClientId ? await Client.findById(assignClientId) : null;
  const now = Date.now();
  for (let i = 0; i < n; i += 1) {
    const name = `TEST payroll ${new Date(now).toISOString().slice(0, 10)} #${i + 1}.xlsx`;
    const fullPath = `${topPath}/${name}`;
    const itemId = `${SF_PREFIX}${now}-${i}`;

    if (await isShareFilePathIgnored(fullPath)) {
      console.log(`  ~ SKIPPED (folder_path IGNORE rule matches): ${fullPath}`);
      continue;
    }
    const item = await UnmatchedShareFileItem.create({
      itemId,
      name,
      path: fullPath,
      discoveredAt: new Date(now - i * 60000),
      sourceCreatedAt: new Date(now - i * 60000),
      status: assignClient ? 'resolved' : 'unresolved',
      resolvedClientId: assignClient ? assignClient._id : undefined,
      resolvedAt: assignClient ? new Date() : undefined,
    });
    console.log(`  + ${itemId}  status=${item.status}${assignClient ? ` (auto-assigned -> ${assignClient.name} via folder_path ASSIGN rule)` : ''}   ${fullPath}`);
  }
  if (assignClient) {
    console.log(`\nA folder_path ASSIGN rule matches "${topPath}" -> items auto-resolved to "${assignClient.name}" (correct).`);
  } else if (await isShareFilePathIgnored(`${topPath}/x.xlsx`)) {
    console.log(`\nA folder_path IGNORE rule matches "${topPath}" -> nothing created (correct).`);
  } else {
    console.log(`\n${n} ShareFile item(s) added to Needs Review under "${topPath}". Open Ingestion -> Needs Review -> ShareFile.`);
  }
}

// ---------------------------------------------------------------- cleanup
async function cleanup() {
  const logs = await EmailLog.find({ messageId: new RegExp(`^${EMAIL_PREFIX}`) }).select('_id sender').lean();
  const ids = logs.map((l) => l._id);
  const rq = await ReviewQueue.deleteMany({ type: 'email', referenceId: { $in: ids } });
  const el = await EmailLog.deleteMany({ _id: { $in: ids } });
  const sf = await UnmatchedShareFileItem.deleteMany({ itemId: new RegExp(`^${SF_PREFIX}`) });

  // remove rules pointing at the test sender / test folder
  const ir = await IgnoreRule.deleteMany({
    $or: [
      { value: new RegExp('zz-review-test\\.local$', 'i') },
      { value: new RegExp('^clients/zz rule test folder', 'i') },
      { value: new RegExp('zz rule test folder', 'i') },
    ],
  });
  const mr = await mongoose.connection
    .collection('matchingrules')
    .deleteMany({ value: new RegExp('zz-review-test\\.local$', 'i') })
    .catch(() => ({ deletedCount: 0 }));

  console.log(
    `Cleanup: ${el.deletedCount} EmailLog, ${rq.deletedCount} ReviewQueue, ${sf.deletedCount} UnmatchedShareFileItem, ${ir.deletedCount} IgnoreRule, ${mr.deletedCount} MatchingRule removed.`
  );
}

// ---------------------------------------------------------------- main
(async () => {
  await connectDB();
  try {
    const [cmd, a, b] = process.argv.slice(2);
    if (cmd === 'status' || !cmd) await status();
    else if (cmd === 'email') await createEmails(Number(a) || 3, b || DEFAULT_SENDER);
    else if (cmd === 'sharefile') await createShareFile(Number(a) || 3, b || DEFAULT_SF_FOLDER);
    else if (cmd === 'cleanup') await cleanup();
    else {
      console.log('Unknown command. Use: status | email [n] [sender] | sharefile [n] [folder] | cleanup');
    }
  } finally {
    await mongoose.disconnect();
  }
})().catch((error) => {
  console.error('ERROR:', error.message);
  process.exit(1);
});
