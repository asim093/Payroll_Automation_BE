require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const FileLog = require('./models/FileLog');
const { scanShareFileForNewFiles, scanShareFileRootForUnmatchedItems } = require('./services/sharefileService');
const { uploadFileToDropbox } = require('./services/dropboxService');
const { formatError } = require('./utils/formatError');
const { startPhase, startItem, completeItem } = require('./services/scanActivityService');


const processShareFileScan = async () => {
  const clientsScanned = await Client.countDocuments({ status: 'active' });
  console.log(`Scanning ShareFile for new files across ${clientsScanned} active client(s)...`);

  const newFiles = await scanShareFileForNewFiles();

  let saved = 0;
  let failed = 0;

  if (newFiles.length === 0) {
    console.log('[SHAREFILE SCAN] No new files found.');
  } else {
    await startPhase('ShareFile Scan', newFiles.length);

    for (const file of newFiles) {
      await startItem(`${file.fileName} (${file.clientName})`);

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

      await completeItem();
    }
  }


  let orphanScan = { scanned: 0, newOrphans: 0, autoResolved: 0 };
  try {
    orphanScan = await scanShareFileRootForUnmatchedItems();
  } catch (error) {
    console.error(`[SHAREFILE ORPHAN SCAN] ERROR: ${formatError(error)}`);
  }

  console.log('\n--- ShareFile scan summary ---');
  console.log(`Clients scanned: ${clientsScanned}`);
  console.log(`New files found: ${newFiles.length}`);
  console.log(`Saved to Dropbox: ${saved}`);
  console.log(`Failed (will retry next scan): ${failed}`);
  console.log(
    `Root-folder items scanned: ${orphanScan.scanned} (new unmatched: ${orphanScan.newOrphans}, auto-resolved: ${orphanScan.autoResolved || 0})`
  );

  return {
    clientsScanned,
    newFilesFound: newFiles.length,
    saved,
    failed,
    unmatchedItemsScanned: orphanScan.scanned,
    newUnmatchedItems: orphanScan.newOrphans,
    autoResolvedUnmatchedItems: orphanScan.autoResolved || 0,
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
