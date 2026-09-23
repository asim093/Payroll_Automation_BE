const mongoose = require('mongoose');

// Bound to the LIVE collection name. Ingestion writes go through the native
// driver into a staging collection (see logiFormsIngestService.js) and only
// this name is ever read from — the atomic rename swap is what makes the
// staging collection "become" this one, all at once.
const LIVE_COLLECTION_NAME = 'logiforms_records';

const logiFormsRecordSchema = new mongoose.Schema(
  {
    ein: { type: String, required: true },
    ssn: { type: String, required: true },
    status: { type: String, required: true },
    dateSubmitted: { type: Date, required: true },
  },
  {
    collection: LIVE_COLLECTION_NAME,
    // The ingestion service fully owns this collection's lifecycle (staging
    // build -> atomic rename swap, see logiFormsIngestService.js) — Mongoose
    // must never spontaneously auto-create it or its index on its own
    // (which it otherwise does at connection time by default), or the very
    // first-ever ingest would find a Mongoose-created empty collection
    // already "live" and rename it aside as spurious old data.
    autoCreate: false,
    autoIndex: false,
  }
);

// Serves both the per-client "all records for this FEIN" query (Phase 4) and
// the dedup key (one row per ein+ssn) enforced during ingestion.
logiFormsRecordSchema.index({ ein: 1, ssn: 1 }, { unique: true });

const LogiFormsRecord = mongoose.model('LogiFormsRecord', logiFormsRecordSchema);
LogiFormsRecord.LIVE_COLLECTION_NAME = LIVE_COLLECTION_NAME;

module.exports = LogiFormsRecord;
