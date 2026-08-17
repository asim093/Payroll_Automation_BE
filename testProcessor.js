require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const mockEmails = require('./mockEmails.json');
const { processEmail } = require('./services/emailProcessor');
const { STORAGE_ROOT } = require('./services/fileStorage');
const EmailLog = require('./models/EmailLog');
const ReviewQueue = require('./models/ReviewQueue');
const FileLog = require('./models/FileLog');

// Lists backend/storage/{clientFolder}/{files...} so we can print exactly
// what landed on disk.
function listStorageContents() {
  if (!fs.existsSync(STORAGE_ROOT)) return {};
  const contents = {};
  const clientFolders = fs
    .readdirSync(STORAGE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  for (const folder of clientFolders) {
    const folderPath = path.join(STORAGE_ROOT, folder.name);
    contents[folder.name] = fs.readdirSync(folderPath);
  }
  return contents;
}

const runTest = async () => {
  try {
    await connectDB();

    // Clear previous test data (DB + disk) so this script gives the same
    // result on every run.
    await EmailLog.deleteMany({});
    await ReviewQueue.deleteMany({});
    await FileLog.deleteMany({});
    fs.rmSync(STORAGE_ROOT, { recursive: true, force: true });
    console.log('Cleared existing EmailLog / ReviewQueue / FileLog records and storage/ folder.\n');

    console.log(`Processing ${mockEmails.length} mock emails (sequentially)...\n`);

    // Sequential, order-preserving — for...of with await (not Promise.all).
    for (const email of mockEmails) {
      await processEmail(email);
    }

    console.log('\n--- EmailLog collection ---');
    const emailLogs = await EmailLog.find().populate('matchedClientId', 'name');
    emailLogs.forEach((log) => {
      console.log(
        `${log.messageId} | sender: ${log.sender} | status: ${log.status} | sourceType: ${
          log.sourceType
        } | matchedClient: ${
          log.matchedClientId ? log.matchedClientId.name : 'none'
        } | attachments: ${log.attachments.map((a) => a.filename).join(', ') || 'none'}`
      );
    });

    console.log('\n--- ReviewQueue collection ---');
    const reviewEntries = await ReviewQueue.find();
    reviewEntries.forEach((entry) => {
      console.log(
        `type: ${entry.type} | referenceId: ${entry.referenceId} | reason: ${entry.reason}`
      );
    });

    console.log('\n--- FileLog collection ---');
    const fileLogs = await FileLog.find().populate('clientId', 'name');
    fileLogs.forEach((log) => {
      console.log(
        `${log.originalName} | source: ${log.source} | client: ${
          log.clientId ? log.clientId.name : 'none'
        } | status: ${log.status} | destinationPath: ${log.destinationPath}`
      );
    });

    console.log('\n--- backend/storage/ contents (on disk) ---');
    const storageContents = listStorageContents();
    const clientFolderNames = Object.keys(storageContents);
    if (clientFolderNames.length === 0) {
      console.log('(storage folder is empty)');
    } else {
      clientFolderNames.forEach((folderName) => {
        storageContents[folderName].forEach((fileName) => {
          console.log(`backend/storage/${folderName}/${fileName}`);
        });
      });
    }
  } catch (error) {
    console.error('Error running processor test:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('\nConnection closed.');
  }
};

runTest();
