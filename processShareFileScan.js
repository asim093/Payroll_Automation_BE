require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const FileLog = require('./models/FileLog');
const { scanShareFileClientsTree } = require('./services/sharefileService');
const { uploadFileToDropbox, scanDropboxRootForUnmatchedItems } = require('./services/dropboxService');
const { recordScanErrors } = require('./services/scanErrorLogService');
const { formatError } = require('./utils/formatError');
const { startPhase, startItem, completeItem } = require('./services/scanActivityService');

const PROCESS_KEY = 'shareFileBridge';


const processShareFileScan = async ({ since } = {}) => {
  const clientsScanned = await Client.countDocuments({ status: 'active' });

  const tree = await scanShareFileClientsTree(since ? { since: new Date(since) } : {});
  const errors = [...tree.errors];

  console.log(
    `Scanned ${tree.foldersScanned} ShareFile folder(s) since ${tree.since} - ` +
      `${tree.matchedFolders} matched, ${tree.unmatchedFolders} unmatched.`
  );

  let saved = 0;
  let failed = 0;

  await startPhase(PROCESS_KEY, 'ShareFile Scan', tree.newFiles.length);

  if (tree.newFiles.length === 0) {
    console.log('[SHAREFILE SCAN] No new files to copy for matched clients.');
  } else {
    for (const file of tree.newFiles) {
      await startItem(PROCESS_KEY, `${file.fileName} (${file.clientName})`);

      try {
        const dropboxPath = await uploadFileToDropbox(
          file.dropboxFolderSegment,
          file.fileName,
          file.content,
          undefined,
          file.dropboxIsAbsolute
        );

        await FileLog.findOneAndUpdate(
          { source: 'sharefile', sourceFileId: file.fileId, clientId: file.clientId },
          {
            $set: {
              source: 'sharefile',
              sourceFileId: file.fileId,
              clientId: file.clientId,
              originalName: file.fileName,
              destinationPath: dropboxPath,
              destination: 'dropbox',
              status: 'moved',
              matchMethod: 'folder_scan',
              processedAt: new Date(),
              sourceCreatedAt: file.sourceCreatedAt || null,
            },
            $unset: { errorMessage: 1 },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        saved++;
        console.log(`[SHAREFILE SCAN] New file for ${file.clientName}: ${file.fileName} - copied to Dropbox`);
      } catch (error) {
        failed++;
        const message = `Could not copy "${file.fileName}" for ${file.clientName} to Dropbox: ${formatError(error)}`;
        console.error(`[SHAREFILE SCAN] ERROR ${message}`);
        errors.push({ scope: `${file.clientName}/${file.fileName}`, message });

        try {
          await FileLog.findOneAndUpdate(
            { source: 'sharefile', sourceFileId: file.fileId, clientId: file.clientId },
            {
              $set: {
                source: 'sharefile',
                sourceFileId: file.fileId,
                clientId: file.clientId,
                originalName: file.fileName,
                destination: 'dropbox',
                status: 'failed',
                errorMessage: formatError(error),
                matchMethod: 'folder_scan',
                processedAt: new Date(),
                sourceCreatedAt: file.sourceCreatedAt || null,
              },
            },
            { upsert: true, setDefaultsOnInsert: true }
          );
        } catch (logError) {
          console.error(`[SHAREFILE SCAN] Could not record the failure for "${file.fileName}": ${formatError(logError)}`);
        }
      }

      await completeItem(PROCESS_KEY);
    }
  }


  await startItem(PROCESS_KEY, 'Scanning Dropbox for orphaned folders/files...');
  let dropboxOrphanScan = { scanned: 0, newOrphans: 0, autoResolved: 0 };
  try {
    dropboxOrphanScan = await scanDropboxRootForUnmatchedItems();
  } catch (error) {
    const message = `Dropbox orphan scan failed: ${formatError(error)}`;
    console.error(`[DROPBOX ORPHAN SCAN] ERROR: ${message}`);
    errors.push({ scope: 'dropbox-orphan-scan', message });
  }
  await completeItem(PROCESS_KEY);

  if (errors.length > 0) {
    await recordScanErrors(PROCESS_KEY, errors);
  }

  console.log('\n--- ShareFile scan summary ---');
  console.log(`Active clients: ${clientsScanned}`);
  console.log(`Folders scanned: ${tree.foldersScanned} (skipped, no recent activity: ${tree.foldersSkippedNoRecentActivity})`);
  console.log(`New files copied for matched clients: ${saved} (failed: ${failed})`);
  console.log(`Unmatched files newly detected (Needs Review): ${tree.unmatchedFilesRecorded}`);
  console.log(`Files skipped (before ${tree.since} cutoff): ${tree.filesSkippedBeforeCutoff}`);
  console.log(`Legacy folder placeholders removed: ${tree.removedFolderPlaceholders}`);
  console.log(`Scan errors persisted: ${errors.length}`);

  return {
    clientsScanned,
    foldersScanned: tree.foldersScanned,
    foldersSkippedNoRecentActivity: tree.foldersSkippedNoRecentActivity,
    matchedFolders: tree.matchedFolders,
    unmatchedFolders: tree.unmatchedFolders,
    newFilesFound: tree.newFiles.length,
    saved,
    failed,
    filesSeen: tree.filesSeen,
    unmatchedFilesRecorded: tree.unmatchedFilesRecorded,
    filesSkippedBeforeCutoff: tree.filesSkippedBeforeCutoff,
    autoResolvedFiles: tree.autoResolvedFiles,
    removedFolderPlaceholders: tree.removedFolderPlaceholders,
    downloadFailures: tree.downloadFailures,
    pathMismatchFiles: tree.pathMismatchFiles,
    ingestSince: tree.since,
    scanErrors: errors.length,
    scanErrorSample: errors.slice(0, 3).map((entry) => `${entry.scope || 'general'}: ${entry.message}`),
    unmatchedItemsScanned: tree.foldersScanned,
    newUnmatchedItems: tree.unmatchedFilesRecorded,
    autoResolvedUnmatchedItems: tree.autoResolvedFiles,
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
      try {
        await recordScanErrors(PROCESS_KEY, [{ scope: 'sharefile-scan', message: formatError(error) }]);
      } catch (logError) {
        console.error('Could not persist the ShareFile scan failure:', logError.message);
      }
    } finally {
      await mongoose.connection.close();
      console.log('\nConnection closed.');
    }
    if (failedRun) process.exit(1);
  })();
}

module.exports = { processShareFileScan };
