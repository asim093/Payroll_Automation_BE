const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const mongoose = require('mongoose');
const { getSettings } = require('./settingsService');
const { findLatestLogiFormsCsvInShareFile, downloadFileContentByIdToPath } = require('./sharefileService');
const { parseLogiFormsLine, normalizeFein, attributeSkippedRows } = require('./logiFormsService');
const { runGuardedProcess } = require('./processRunner');
const { isProcessDue } = require('./scanThrottle');
const { formatError } = require('../utils/formatError');
const LogiFormsIngestStatus = require('../models/LogiFormsIngestStatus');
const LogiFormsRecord = require('../models/LogiFormsRecord');

const PROCESS_KEY = 'logiFormsIngest';
const STAGING_COLLECTION = 'logiforms_records_staging';
const CHUNK_SIZE = 5000;
const OLD_COLLECTION_RETENTION_MS = 48 * 60 * 60 * 1000;
const DAILY_FORCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const getIngestStatus = () => LogiFormsIngestStatus.findOne().lean();

const ensureStatusDoc = async () => {
  let doc = await LogiFormsIngestStatus.findOne();
  if (!doc) doc = await LogiFormsIngestStatus.create({});
  return doc;
};

// Conditional "keep the latest DateSubmitted per EIN+SSN" upsert, done inside
// Mongo itself via a pipeline update — this is what lets ingestion stream
// rows in bounded chunks instead of building one in-memory Map for the whole
// file the way the old in-memory parse (logiFormsService.js) had to.
const buildUpsertOp = ({ ein, ssn, status, dateSubmitted }) => ({
  updateOne: {
    filter: { ein, ssn },
    update: [
      {
        $set: {
          ein,
          ssn,
          status: {
            $cond: [{ $gte: [dateSubmitted, { $ifNull: ['$dateSubmitted', new Date(0)] }] }, status, '$status'],
          },
          dateSubmitted: {
            $cond: [
              { $gte: [dateSubmitted, { $ifNull: ['$dateSubmitted', new Date(0)] }] },
              dateSubmitted,
              '$dateSubmitted',
            ],
          },
        },
      },
    ],
    upsert: true,
  },
});

// Streams the CSV line-by-line, buffering up to CHUNK_SIZE parsed rows before
// bulkWrite-ing them into the staging collection. Backpressure via
// rl.pause()/resume() around each flush is what actually bounds memory to
// ~one chunk at a time — without it, readline would keep emitting 'line'
// events (fast, local disk) far ahead of the network bulkWrite calls
// (Atlas round-trips), defeating the point of chunking.
const streamIngestIntoStaging = (localFilePath, stagingCollection) =>
  new Promise((resolve, reject) => {
    if (!fs.existsSync(localFilePath)) {
      reject(new Error(`LogiForms file not found: ${localFilePath}`));
      return;
    }

    let lineNumber = 0;
    let headerColumns = null;
    let totalDataRows = 0;
    const skippedRows = [];
    let buffer = [];
    let settled = false;

    const rl = readline.createInterface({
      input: fs.createReadStream(localFilePath),
      crlfDelay: Infinity,
    });

    const fail = (error) => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(error);
    };

    const flush = async () => {
      if (buffer.length === 0) return;
      const ops = buffer.map(buildUpsertOp);
      buffer = [];
      await stagingCollection.bulkWrite(ops, { ordered: false });
    };

    rl.on('line', (rawLine) => {
      if (settled) return;
      lineNumber += 1;
      const parsed = parseLogiFormsLine(rawLine, lineNumber, headerColumns);

      if (parsed.type === 'blank' || parsed.type === 'incomplete') return;

      if (parsed.type === 'skipped') {
        skippedRows.push(parsed.skippedRow);
        return;
      }

      if (parsed.type === 'invalid_header') {
        fail(new Error(`LogiForms file is missing required column "${parsed.missingHeader}": ${localFilePath}`));
        return;
      }

      if (parsed.type === 'header') {
        headerColumns = parsed.headerColumns;
        return;
      }

      totalDataRows += 1;
      buffer.push(parsed.row);

      if (buffer.length >= CHUNK_SIZE) {
        rl.pause();
        flush()
          .then(() => {
            if (!settled) rl.resume();
          })
          .catch(fail);
      }
    });

    rl.on('error', fail);

    rl.on('close', async () => {
      if (settled) return;
      if (!headerColumns) {
        fail(new Error(`LogiForms file is empty: ${localFilePath}`));
        return;
      }
      try {
        await flush();
        const uniqueRecordCount = await stagingCollection.countDocuments();
        settled = true;
        resolve({ totalRowsRead: lineNumber, totalDataRows, uniqueRecordCount, skippedRows });
      } catch (error) {
        fail(error);
      }
    });
  });

// Drops any leftover staging collection from a previous crashed/failed
// attempt, then creates a fresh one with the same unique index the live
// collection has (indexes travel with a rename, so this index is what the
// live collection will end up with after the swap).
const prepareStagingCollection = async (db) => {
  await db.collection(STAGING_COLLECTION).drop().catch((error) => {
    if (error.codeName !== 'NamespaceNotFound') throw error;
  });
  await db.createCollection(STAGING_COLLECTION);
  await db.collection(STAGING_COLLECTION).createIndex({ ein: 1, ssn: 1 }, { unique: true });
  return db.collection(STAGING_COLLECTION);
};

// Atomic swap: staging becomes the live collection. The live collection is
// untouched (still fully queryable with the OLD data) for the entire
// ingestion above — this rename is the only moment anything changes, and
// MongoDB's collection rename is a fast metadata-only operation, not a
// row-by-row copy. The old collection is kept (not dropped) for 48h rollback
// safety — see dropExpiredOldLogiFormsCollections.
const swapStagingToLive = async (db) => {
  const liveExists = await db.listCollections({ name: LogiFormsRecord.LIVE_COLLECTION_NAME }).hasNext();
  let oldCollectionName = null;

  if (liveExists) {
    oldCollectionName = `logiforms_records_old_${Date.now()}`;
    await db.collection(LogiFormsRecord.LIVE_COLLECTION_NAME).rename(oldCollectionName);
  }

  await db.collection(STAGING_COLLECTION).rename(LogiFormsRecord.LIVE_COLLECTION_NAME);
  return oldCollectionName;
};

// The one function both the hourly/daily cron (Phase 2) and the "Check Now"
// button (Phase 2, force:true) call — identical detection+ingestion logic
// either way. Concurrency is guarded by runGuardedProcess's existing
// CAS-based SystemStatus lock (processKey 'logiFormsIngest'), the same
// mechanism mailSync/shareFileBridge already use — a second call while one
// is in flight returns {skipped:true} instead of starting a duplicate run.
// staleMs override: default runGuardedProcess staleness is 15 min, but a
// real ingestion measures ~9.6 min end to end — too little margin (a
// slightly slower run could exceed 15 min and let a concurrent tick
// "reclaim" the lock while the first ingestion is still genuinely running,
// both writing to the same staging collection). 30 min gives real headroom
// above the measured real-world duration, matching shareFileBridgeRunner.js's
// own precedent of overriding this default for its own longer-running work.
const LOGIFORMS_LOCK_STALE_MS = 30 * 60 * 1000;

const checkAndIngestLogiForms = ({ force = false } = {}) =>
  runGuardedProcess(
    PROCESS_KEY,
    async () => {
      const statusDoc = await ensureStatusDoc();
      let tempDir = null;

      try {
        const { logiFormsFolderPath } = await getSettings();
        if (!logiFormsFolderPath) {
          throw new Error('LogiForms folder path is not configured. Set "LogiForms Folder Path" on the Settings page first.');
        }

        statusDoc.status = 'checking';
        await statusDoc.save();

        const latestFile = await findLatestLogiFormsCsvInShareFile(logiFormsFolderPath);
        if (!latestFile) {
          throw new Error(`No LogiForms CSV file found in ShareFile folder "${logiFormsFolderPath}".`);
        }

        const unchanged =
          !force &&
          statusDoc.activeFileId === latestFile.fileId &&
          statusDoc.activeFileModifiedAt &&
          new Date(statusDoc.activeFileModifiedAt).getTime() === new Date(latestFile.modifiedAt).getTime();

        statusDoc.lastCheckedAt = new Date();
        if (force) statusDoc.lastForcedRecheckAt = new Date();
        if (unchanged) {
          statusDoc.status = 'ready';
          await statusDoc.save();
          return { success: true, changed: false };
        }

        statusDoc.status = 'ingesting';
        statusDoc.lastIngestStartedAt = new Date();
        await statusDoc.save();

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logiforms-ingest-'));
        const localFilePath = path.join(tempDir, latestFile.fileName);
        await downloadFileContentByIdToPath(latestFile.fileId, localFilePath);

        const db = mongoose.connection.db;
        const stagingCollection = await prepareStagingCollection(db);
        const { totalRowsRead, uniqueRecordCount, skippedRows } = await streamIngestIntoStaging(
          localFilePath,
          stagingCollection
        );

        const oldCollectionName = await swapStagingToLive(db);

        statusDoc.status = 'ready';
        statusDoc.activeFileId = latestFile.fileId;
        statusDoc.activeFileName = latestFile.fileName;
        statusDoc.activeFileModifiedAt = latestFile.modifiedAt;
        statusDoc.lastIngestCompletedAt = new Date();
        statusDoc.totalRowsRead = totalRowsRead;
        statusDoc.uniqueRecordCount = uniqueRecordCount;
        statusDoc.skippedRowsCount = skippedRows.length;
        statusDoc.skippedRows = skippedRows;
        statusDoc.lastError = null;
        if (oldCollectionName) {
          statusDoc.pendingDrops.push({
            collectionName: oldCollectionName,
            droppedOldCollectionAt: new Date(),
            dropAfter: new Date(Date.now() + OLD_COLLECTION_RETENTION_MS),
          });
        }
        await statusDoc.save();

        console.log(
          `[LOGIFORMS-INGEST] Ingested "${latestFile.fileName}": ${totalRowsRead} lines read, ${uniqueRecordCount} unique records, ${skippedRows.length} skipped rows.`
        );

        return { success: true, changed: true, totalRowsRead, uniqueRecordCount, skippedRowsCount: skippedRows.length };
      } catch (error) {
        console.error(`[LOGIFORMS-INGEST] Failed: ${formatError(error)}`);
        statusDoc.status = 'failed';
        statusDoc.lastError = error.message;
        statusDoc.lastCheckedAt = new Date();
        await statusDoc.save().catch(() => {});
        // Best-effort: don't leave a half-built staging collection around for
        // the next attempt to trip over — the live collection was never
        // touched at this point (the rename swap only happens after a fully
        // successful ingest), so old data is still intact and queryable.
        await mongoose.connection.db
          .collection(STAGING_COLLECTION)
          .drop()
          .catch(() => {});
        return { success: false, error: error.message };
      } finally {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
    { staleMs: LOGIFORMS_LOCK_STALE_MS }
  );

// Drops any old (renamed-aside) collection whose 48h retention window has
// passed. Called from the same hourly cron tick as checkAndIngestLogiForms
// (Phase 2) — not on its own schedule, so no separate scheduling mechanism
// is needed for this.
const dropExpiredOldLogiFormsCollections = async () => {
  const statusDoc = await LogiFormsIngestStatus.findOne();
  if (!statusDoc || statusDoc.pendingDrops.length === 0) return { dropped: [] };

  const now = Date.now();
  const dropped = [];
  const remaining = [];

  for (const entry of statusDoc.pendingDrops) {
    if (new Date(entry.dropAfter).getTime() <= now) {
      try {
        await mongoose.connection.db.collection(entry.collectionName).drop();
        dropped.push(entry.collectionName);
        console.log(`[LOGIFORMS-INGEST] Dropped expired old collection "${entry.collectionName}" (48h retention passed).`);
      } catch (error) {
        if (error.codeName !== 'NamespaceNotFound') {
          console.error(`[LOGIFORMS-INGEST] Could not drop "${entry.collectionName}": ${formatError(error)}`);
          remaining.push(entry);
          continue;
        }
        dropped.push(entry.collectionName);
      }
    } else {
      remaining.push(entry);
    }
  }

  if (dropped.length > 0) {
    statusDoc.pendingDrops = remaining;
    await statusDoc.save();
  }

  return { dropped };
};

// The hourly cron's entry point (Phase 2). isProcessDue reuses the same
// SystemStatus.logiFormsIngest.lastRunAt that runGuardedProcess already
// maintains, so this naturally throttles to the configured interval and
// "catches up" correctly after a missed tick or a server restart (see
// scanThrottle.js — the due-check is driven by elapsed real time stored in
// Mongo, not by the cron actually firing on a precise schedule).
//
// Separately from the interval throttle, this also decides whether TODAY's
// check should be forced past the modifiedAt comparison — a safety net for
// ShareFile's known limitation of not always bumping modifiedAt on an
// in-place file overwrite, so a same-content-looking file doesn't silently
// go unnoticed forever. This is independent of the "Check Now" button, which
// always forces immediately regardless of either throttle.
const runScheduledLogiFormsCheck = async () => {
  const due = await isProcessDue(PROCESS_KEY, 'logiFormsCheckIntervalMinutes');
  if (!due.shouldRun) {
    return { skipped: true, reason: 'not_due_yet', minutesRemaining: due.minutesRemaining };
  }

  const statusDoc = await ensureStatusDoc();
  const lastForced = statusDoc.lastForcedRecheckAt ? new Date(statusDoc.lastForcedRecheckAt).getTime() : 0;
  const forceNow = Date.now() - lastForced >= DAILY_FORCE_INTERVAL_MS;

  const result = await checkAndIngestLogiForms({ force: forceNow });
  const dropResult = await dropExpiredOldLogiFormsCollections();

  return { ...result, forced: forceNow, droppedOldCollections: dropResult.dropped };
};

// Phase 4 — replaces the old per-generation ShareFile download+full-file
// parse (previously fetchLogiFormsDataForClient in logiFormsService.js,
// still exists there but no longer called from the report-generation path)
// with a single indexed Mongo query against the collection the hourly/daily
// cron already keeps current. Same return shape as the old function
// (records, skippedRows, relevantSkippedRows, unattributableSkippedRows) so
// complianceReportOrchestratorService.js's consuming code — including the
// existing Part 1(a) per-client skipped-row attribution — is unaffected by
// the swap.
//
// Edge case: if ingestion has never completed successfully (status isn't
// 'ready', or there's no activeFileId yet), this throws rather than
// silently returning zero records — a client with genuinely zero LogiForms
// submissions is a normal business case (handled fine, they just show up as
// all-Incomplete); "no data has ever been ingested at all" is a
// configuration/timing problem that must not be confused with that.
const fetchLogiFormsDataForClient = async (fein) => {
  const status = await LogiFormsIngestStatus.findOne().lean();
  if (!status || status.status !== 'ready' || !status.activeFileId) {
    throw new Error(
      'No LogiForms data has been ingested yet — please wait for the next scheduled check or use Check Now in Settings.'
    );
  }

  const normalizedFein = normalizeFein(fein);
  const records = await LogiFormsRecord.find({ ein: normalizedFein })
    .select('ssn status dateSubmitted -_id')
    .lean();

  const skippedRows = status.skippedRows || [];
  const { relevantSkippedRows, unattributableSkippedRows } = attributeSkippedRows(skippedRows, fein);

  return {
    records: records.map((record) => ({ ein: normalizedFein, ...record })),
    skippedRows,
    relevantSkippedRows,
    unattributableSkippedRows,
  };
};

module.exports = {
  checkAndIngestLogiForms,
  runScheduledLogiFormsCheck,
  dropExpiredOldLogiFormsCollections,
  getIngestStatus,
  fetchLogiFormsDataForClient,
};
