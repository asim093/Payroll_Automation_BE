/**
 * PHASE 2 migration — moves Settings from the old *PathTemplate
 * ("{Client Name}"-placeholder) scheme to the new *RootPath + per-client
 * full-manual-path scheme (see models/Settings.js, models/Client.js,
 * utils/folderPath.js).
 *
 * WHY a migration is needed at all: the old template could carry a SUFFIX
 * after the placeholder — e.g. default "WOTC/{Client Name}/Payroll Files"
 * has "/Payroll Files" after the slot. The new scheme has no per-destination
 * suffix concept at the Settings level anymore (the client's own path is now
 * the ENTIRE remainder), so that suffix has to be folded into each client's
 * stored dropboxPath/shareFilePath — otherwise every existing client would
 * silently start uploading to a shorter path than before (breaking
 * continuity with files already sitting in Dropbox/ShareFile).
 *
 * What it does, per destination (dropbox / shareFile):
 *   1. Reads the RAW (pre-migration) Settings document directly via the
 *      native collection (not the Mongoose model, which no longer knows
 *      about the old field names and would silently not return them).
 *   2. Splits the old template on "{Client Name}" into {before, after}.
 *   3. New root path = before (trailing "/" stripped).
 *   4. For every client: new dropboxPath/shareFilePath =
 *      `${client.dropboxPath || client.name}${after ? '/' + after : ''}`
 *      — i.e. whatever segment was already being substituted in, with the
 *      old suffix appended, so the FINAL resolved path is identical to what
 *      it was before the migration.
 *
 * outlookPathTemplate is migrated at the Settings level only (root path) —
 * Client.outlookFolderPath is not read by any processing code today (see
 * the comment on that field in models/Client.js), so there is nothing to
 * backfill per-client there.
 *
 * USAGE:
 *   node scripts/migratePhase2FolderPaths.js            -> DRY RUN (default).
 *                                                           Only console.logs
 *                                                           what WOULD change.
 *                                                           No DB writes.
 *   node scripts/migratePhase2FolderPaths.js --apply     -> Actually writes
 *                                                           the changes.
 *
 * Safe to run more than once in dry-run mode. In --apply mode it is
 * idempotent in the sense that a second run will find no *PathTemplate
 * field left on Settings and report "nothing to migrate" rather than
 * double-appending suffixes onto client paths.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('../models/Client');

const APPLY = process.argv.includes('--apply');

const stripSlashes = (value) => String(value || '').replace(/^\/+|\/+$/g, '');

const splitOnPlaceholder = (template) => {
  const value = String(template || '');
  const index = value.indexOf('{Client Name}');
  if (index === -1) {
    return { before: stripSlashes(value), after: '' };
  }
  return {
    before: stripSlashes(value.slice(0, index)),
    after: stripSlashes(value.slice(index + '{Client Name}'.length)),
  };
};

const run = async () => {
  console.log(`\n=== PHASE 2 folder-path migration — ${APPLY ? 'APPLY MODE (will write to DB)' : 'DRY RUN (no writes)'} ===\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.\n');

  const settingsCollection = mongoose.connection.collection('settings');
  const rawSettings = await settingsCollection.findOne({});

  if (!rawSettings) {
    console.log('No Settings document exists yet — nothing to migrate. A fresh one with the new');
    console.log('*RootPath defaults will be created automatically on first use (see settingsService.js).');
    await mongoose.disconnect();
    return;
  }

  const hasOldFields =
    rawSettings.dropboxPathTemplate !== undefined ||
    rawSettings.shareFilePathTemplate !== undefined ||
    rawSettings.outlookPathTemplate !== undefined;

  if (!hasOldFields) {
    console.log('Settings document has no *PathTemplate fields — already migrated (or a fresh install).');
    console.log('Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  const dropbox = splitOnPlaceholder(rawSettings.dropboxPathTemplate);
  const shareFile = splitOnPlaceholder(rawSettings.shareFilePathTemplate);
  const outlook = splitOnPlaceholder(rawSettings.outlookPathTemplate);

  console.log('--- Settings migration ---');
  console.log(`  dropboxPathTemplate   = "${rawSettings.dropboxPathTemplate || ''}"`);
  console.log(`    -> dropboxRootPath  = "${dropbox.before}"  (suffix to fold into each client: "${dropbox.after || '(none)'}")`);
  console.log(`  shareFilePathTemplate = "${rawSettings.shareFilePathTemplate || ''}"`);
  console.log(`    -> shareFileRootPath = "${shareFile.before}"  (suffix to fold into each client: "${shareFile.after || '(none)'}")`);
  console.log(`  outlookPathTemplate   = "${rawSettings.outlookPathTemplate || ''}"`);
  console.log(`    -> outlookRootPath  = "${outlook.before}"  (per-client outlook path not migrated — unused by processing code today)`);

  console.log('\n--- Client migration ---');
  const clients = await Client.find().lean();
  const clientUpdates = [];

  for (const client of clients) {
    const oldDropboxSegment = client.dropboxPath || client.name;
    const oldShareFileSegment = client.shareFilePath || client.name;

    const newDropboxPath = dropbox.after ? `${oldDropboxSegment}/${dropbox.after}` : client.dropboxPath || '';
    const newShareFilePath = shareFile.after ? `${oldShareFileSegment}/${shareFile.after}` : client.shareFilePath || '';

    const dropboxChanges = newDropboxPath !== (client.dropboxPath || '');
    const shareFileChanges = newShareFilePath !== (client.shareFilePath || '');

    if (!dropboxChanges && !shareFileChanges) {
      console.log(`  "${client.name}" - no change needed (no suffix to fold in, or already set).`);
      continue;
    }

    console.log(`  "${client.name}":`);
    if (dropboxChanges) {
      console.log(`    dropboxPath:   "${client.dropboxPath || '(unset, was falling back to name)'}" -> "${newDropboxPath}"`);
    }
    if (shareFileChanges) {
      console.log(`    shareFilePath: "${client.shareFilePath || '(unset, was falling back to name)'}" -> "${newShareFilePath}"`);
    }

    clientUpdates.push({
      _id: client._id,
      dropboxPath: dropboxChanges ? newDropboxPath : undefined,
      shareFilePath: shareFileChanges ? newShareFilePath : undefined,
    });
  }

  console.log(`\n${clientUpdates.length} of ${clients.length} client(s) need a path update.`);

  if (!APPLY) {
    console.log('\nDRY RUN ONLY - nothing was written. Re-run with --apply once this looks correct.');
    await mongoose.disconnect();
    return;
  }

  console.log('\n--- Applying changes ---');

  await settingsCollection.updateOne(
    { _id: rawSettings._id },
    {
      $set: {
        dropboxRootPath: dropbox.before,
        shareFileRootPath: shareFile.before,
        outlookRootPath: outlook.before,
      },
      $unset: {
        dropboxPathTemplate: '',
        shareFilePathTemplate: '',
        outlookPathTemplate: '',
      },
    }
  );
  console.log('Settings updated.');

  for (const update of clientUpdates) {
    const setFields = {};
    if (update.dropboxPath !== undefined) setFields.dropboxPath = update.dropboxPath;
    if (update.shareFilePath !== undefined) setFields.shareFilePath = update.shareFilePath;
    await Client.updateOne({ _id: update._id }, { $set: setFields });
  }
  console.log(`${clientUpdates.length} client(s) updated.`);

  console.log('\n=== Migration complete ===');
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error('MIGRATION ERROR:', error);
  process.exit(1);
});
