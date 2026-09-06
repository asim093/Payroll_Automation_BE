const assert = require('node:assert/strict');

process.env.SHAREFILE_INGEST_SINCE_DATE = '2026-08-26T00:00:00.000Z';
delete process.env.SHAREFILE_FORCE_FULL_SCAN;

const SystemStatus = require('./models/SystemStatus');
let store = {};
SystemStatus.findOne = () => ({
  select: () => ({ lean: async () => (store ? { shareFileBridge: store.shareFileBridge } : null) }),
});
SystemStatus.updateOne = async (_filter, update) => {
  store.shareFileBridge = store.shareFileBridge || {};
  for (const [k, v] of Object.entries(update.$set)) {
    const key = k.replace('shareFileBridge.', '');
    store.shareFileBridge[key] = v;
  }
  return { modifiedCount: 1 };
};

const {
  decideScanWindow,
  computeScanWindow,
  recordScanCompleted,
  staticCutoff,
  INCREMENTAL_BUFFER_MS,
  FULL_SCAN_EVERY_MS,
} = require('./services/shareFileScanWindow');

let pass = 0;
let fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); }
};

const FLOOR = staticCutoff().getTime();
const NOW = Date.parse('2026-09-10T12:00:00.000Z');

// 1. no markers at all -> full scan from the static floor
let w = decideScanWindow({}, NOW);
ok('first run (no markers) => full', w.full && w.since.getTime() === FLOOR, w);

// 2. recent full scan + a recent incremental marker -> incremental, since = marker - 15m
const incAt = NOW - 4 * 60 * 1000; // 4 min ago
w = decideScanWindow({ lastFullScanAt: new Date(NOW - 30 * 60 * 1000), lastIncrementalScanStartedAt: new Date(incAt) }, NOW);
ok('incremental window uses marker minus buffer', !w.full && w.since.getTime() === incAt - INCREMENTAL_BUFFER_MS, w);

// 3. incremental marker older than the floor would push below it -> clamped to floor
w = decideScanWindow(
  { lastFullScanAt: new Date(NOW - 30 * 60 * 1000), lastIncrementalScanStartedAt: new Date(FLOOR + 5 * 60 * 1000) },
  NOW
);
ok('incremental since never drops below the static floor', w.since.getTime() === FLOOR, w);

// 4. last full scan > 6h ago -> forced full
w = decideScanWindow(
  { lastFullScanAt: new Date(NOW - (FULL_SCAN_EVERY_MS + 60 * 1000)), lastIncrementalScanStartedAt: new Date(NOW - 60 * 1000) },
  NOW
);
ok('a full scan is due every 6h', w.full && w.reason === 'periodic-full', w);

// 5. forceFull overrides everything
w = decideScanWindow(
  { lastFullScanAt: new Date(NOW - 60 * 1000), lastIncrementalScanStartedAt: new Date(NOW - 60 * 1000) },
  NOW,
  { forceFull: true }
);
ok('forceFull => full from the floor', w.full && w.since.getTime() === FLOOR && w.reason === 'forced', w);

(async () => {
  // 6. SHAREFILE_FORCE_FULL_SCAN env is honoured by computeScanWindow
  store = { shareFileBridge: { lastFullScanAt: new Date(NOW - 60 * 1000), lastIncrementalScanStartedAt: new Date(NOW - 60 * 1000) } };
  process.env.SHAREFILE_FORCE_FULL_SCAN = 'true';
  let cw = await computeScanWindow();
  ok('env SHAREFILE_FORCE_FULL_SCAN forces a full scan', cw.full && cw.reason === 'forced', cw);
  delete process.env.SHAREFILE_FORCE_FULL_SCAN;

  // 7. a clean run advances the incremental marker (and the full marker for a full run)
  store = { shareFileBridge: {} };
  const startedAt = new Date(NOW);
  await recordScanCompleted({ startedAt, full: true, incomplete: false });
  ok('clean full run advances both markers', store.shareFileBridge.lastIncrementalScanStartedAt === startedAt && store.shareFileBridge.lastFullScanAt === startedAt, store.shareFileBridge);

  // 8. an incomplete run advances NOTHING
  store = { shareFileBridge: { lastIncrementalScanStartedAt: new Date(NOW - 3600 * 1000), lastFullScanAt: new Date(NOW - 3600 * 1000) } };
  const before = { ...store.shareFileBridge };
  await recordScanCompleted({ startedAt: new Date(NOW), full: false, incomplete: true });
  ok('incomplete run does NOT advance the marker', String(store.shareFileBridge.lastIncrementalScanStartedAt) === String(before.lastIncrementalScanStartedAt), store.shareFileBridge);

  // 9. a clean incremental run advances only the incremental marker, not the full one
  store = { shareFileBridge: { lastFullScanAt: new Date(NOW - 60 * 60 * 1000) } };
  const s2 = new Date(NOW);
  await recordScanCompleted({ startedAt: s2, full: false, incomplete: false });
  ok('clean incremental run leaves lastFullScanAt alone', store.shareFileBridge.lastIncrementalScanStartedAt === s2 && store.shareFileBridge.lastFullScanAt.getTime() === NOW - 60 * 60 * 1000, store.shareFileBridge);

  console.log(`\n${fail === 0 ? 'ALL GREEN' : fail + ' FAILURES'} (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
})();
