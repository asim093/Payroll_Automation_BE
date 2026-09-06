const SystemStatus = require('../models/SystemStatus');

const DEFAULT_STATIC_CUTOFF = '2026-08-26T00:00:00.000Z';
const INCREMENTAL_BUFFER_MS = 15 * 60 * 1000;
const FULL_SCAN_EVERY_MS = 6 * 60 * 60 * 1000;

const staticCutoff = () => {
  const parsed = new Date(process.env.SHAREFILE_INGEST_SINCE_DATE || DEFAULT_STATIC_CUTOFF);
  return Number.isNaN(parsed.getTime()) ? new Date(DEFAULT_STATIC_CUTOFF) : parsed;
};

const decideScanWindow = (bridgeStatus = {}, now = Date.now(), { forceFull = false } = {}) => {
  const floor = staticCutoff();
  if (forceFull) return { since: floor, full: true, reason: 'forced' };

  const lastFull = bridgeStatus.lastFullScanAt ? new Date(bridgeStatus.lastFullScanAt).getTime() : 0;
  if (now - lastFull >= FULL_SCAN_EVERY_MS) {
    return { since: floor, full: true, reason: lastFull ? 'periodic-full' : 'first-run' };
  }

  const resumeFrom = bridgeStatus.lastIncrementalScanStartedAt
    ? new Date(bridgeStatus.lastIncrementalScanStartedAt).getTime()
    : 0;
  if (!resumeFrom) return { since: floor, full: true, reason: 'no-incremental-marker' };

  const since = new Date(Math.max(floor.getTime(), resumeFrom - INCREMENTAL_BUFFER_MS));
  return { since, full: false, reason: 'incremental' };
};

const computeScanWindow = async ({ forceFull = false } = {}) => {
  const status = await SystemStatus.findOne().select('shareFileBridge').lean();
  return decideScanWindow(status?.shareFileBridge || {}, Date.now(), {
    forceFull: forceFull || process.env.SHAREFILE_FORCE_FULL_SCAN === 'true',
  });
};

const recordScanCompleted = async ({ startedAt, full, incomplete }) => {
  if (incomplete) return;
  const set = { 'shareFileBridge.lastIncrementalScanStartedAt': startedAt };
  if (full) set['shareFileBridge.lastFullScanAt'] = startedAt;
  await SystemStatus.updateOne({}, { $set: set }, { upsert: true });
};

module.exports = {
  staticCutoff,
  decideScanWindow,
  computeScanWindow,
  recordScanCompleted,
  INCREMENTAL_BUFFER_MS,
  FULL_SCAN_EVERY_MS,
};
