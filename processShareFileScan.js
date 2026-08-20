require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const FileLog = require('./models/FileLog');
const { scanShareFileForNewFiles, scanShareFileRootForUnmatchedItems } = require('./services/sharefileService');
const { uploadFileToDropbox, scanDropboxRootForUnmatchedItems } = require('./services/dropboxService');
const { formatError } = require('./utils/formatError');
const { startPhase, startItem, completeItem } = require('./services/scanActivityService');


const processShareFileScan = async () => {
  const clientsScanned = await Client.countDocuments({ status: 'active' });
  console.log(`Scanning ShareFile for new files across ${clientsScanned} active client(s)...`);

  const newFiles = await scanShareFileForNewFiles();

  let saved = 0;
  let failed = 0;

  // PHASE-UI-11 — always announce this phase, even with 0 new files found
  // (Mail Sync Engine already does this unconditionally - see
  // processInbox.js/processInboxDelegated.js). The orphan-scans below
  // still take real time regardless of newFiles.length (each is a full
  // ShareFile/Dropbox API walk - tens of seconds is normal), so "Running"
  // needs to stay visible for the WHOLE run, not just the file-copy loop,
  // which is often skipped entirely.
  await startPhase('shareFileBridge', 'ShareFile Scan', newFiles.length);

  if (newFiles.length === 0) {
    console.log('[SHAREFILE SCAN] No new files found.');
  } else {
    for (const file of newFiles) {
      await startItem('shareFileBridge', `${file.fileName} (${file.clientName})`);

      try {
        const dropboxPath = await uploadFileToDropbox(file.dropboxFolderSegment, file.fileName, file.content);

        await FileLog.create({
          source: 'sharefile',
          sourceFileId: file.fileId,
          clientId: file.clientId,
          originalName: file.fileName,
          destinationPath: dropboxPath,
          destination: 'dropbox',
          status: 'moved',
          processedAt: new Date(),
        });

        saved++;
        console.log(`[SHAREFILE SCAN] New file found for ${file.clientName}: ${file.fileName} - copied to Dropbox`);
      } catch (error) {
        failed++;
        console.error(
          `[SHAREFILE SCAN] ERROR copying "${file.fileName}" for ${file.clientName} to Dropbox: ${formatError(error)}`
        );
       
        try {
          await FileLog.create({
            source: 'sharefile',
            sourceFileId: file.fileId,
            clientId: file.clientId,
            originalName: file.fileName,
            destination: 'dropbox',
            status: 'failed',
            errorMessage: formatError(error),
            processedAt: new Date(),
          });
        } catch (logError) {
          console.error(
            `[SHAREFILE SCAN] Could not even record the failure for "${file.fileName}": ${formatError(logError)}`
          );
        }
      }

      await completeItem('shareFileBridge');
    }
  }


  // Labeled as its own "current item" (even though it isn't literally one
  // of newFiles.length's items) purely so the dashboard's "Currently on..."
  // line has something honest to show during this step - it's routinely
  // the slowest part of the whole run (a full ShareFile API folder walk).
  await startItem('shareFileBridge', 'Scanning ShareFile for orphaned folders/files...');
  let orphanScan = { scanned: 0, newOrphans: 0, autoResolved: 0 };
  try {
    orphanScan = await scanShareFileRootForUnmatchedItems();
  } catch (error) {
    console.error(`[SHAREFILE ORPHAN SCAN] ERROR: ${formatError(error)}`);
  }
  await completeItem('shareFileBridge');

  // Dropbox counterpart of the same housekeeping - see
  // dropboxService.js's scanDropboxRootForUnmatchedItems() for why this
  // lives here (part of the same scan cycle) rather than as its own
  // separate flow. Isolated in its own try/catch, same reasoning as the
  // ShareFile one above: a failure here should never take down the actual
  // file-copying work this function just finished.
  await startItem('shareFileBridge', 'Scanning Dropbox for orphaned folders/files...');
  let dropboxOrphanScan = { scanned: 0, newOrphans: 0, autoResolved: 0 };
  try {
    dropboxOrphanScan = await scanDropboxRootForUnmatchedItems();
  } catch (error) {
    console.error(`[DROPBOX ORPHAN SCAN] ERROR: ${formatError(error)}`);
  }
  await completeItem('shareFileBridge');

  console.log('\n--- ShareFile scan summary ---');
  console.log(`Clients scanned: ${clientsScanned}`);
  console.log(`New files found: ${newFiles.length}`);
  console.log(`Saved to Dropbox: ${saved}`);
  console.log(`Failed (will retry next scan): ${failed}`);
  console.log(
    `ShareFile root-folder items scanned: ${orphanScan.scanned} (new unmatched: ${orphanScan.newOrphans}, auto-resolved: ${orphanScan.autoResolved || 0})`
  );
  console.log(
    `Dropbox root-folder items scanned: ${dropboxOrphanScan.scanned} (new unmatched: ${dropboxOrphanScan.newOrphans}, auto-resolved: ${dropboxOrphanScan.autoResolved || 0})`
  );

  return {
    clientsScanned,
    newFilesFound: newFiles.length,
    saved,
    failed,
    unmatchedItemsScanned: orphanScan.scanned,
    newUnmatchedItems: orphanScan.newOrphans,
    autoResolvedUnmatchedItems: orphanScan.autoResolved || 0,
    dropboxUnmatchedItemsScanned: dropboxOrphanScan.scanned,
    dropboxNewUnmatchedItems: dropboxOrphanScan.newOrphans,
    dropboxAutoResolvedUnmatchedItems: dropboxOrphanScan.autoResolved || 0,
  };
};


if (require.main === module) {
  (async () => {
    let failedRun = false;
    try {
      await connectDB();
      await processShareFileScan();
    } catch (error) {
      failedRun = true;
      console.error('Error running ShareFile scan:', error.message);
    } finally {
      await mongoose.connection.close();
      console.log('\nConnection closed.');
    }
    if (failedRun) process.exit(1);
  })();
}

module.exports = { processShareFileScan };
