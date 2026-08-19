/**
 * PHASE 4 (+ PHASE 9) — writes live per-item progress to the single
 * ScanActivity document as processInboxDelegated.js/processInbox.js/
 * processShareFileScan.js work through their items, AND (Phase 9) pushes a
 * throttled WebSocket-broadcast notification so the dashboard updates in
 * near-real-time without polling (see models/ScanActivity.js,
 * services/socketService.js).
 *
 * Every function here is fire-and-forget safe: each one swallows its own
 * errors (logged, not thrown) so a bug or a transient DB/network hiccup in
 * this PURELY COSMETIC status-tracking layer can never break the actual
 * email/file processing it's just narrating. Callers do not need to wrap
 * these calls in their own try/catch.
 *
 * OPTIMIZATION NOTE (Phase 9): a scan can process dozens of items in quick
 * succession (see the high-volume diagnosis that originally motivated
 * Phase 4) - broadcasting on literally every single startItem/completeItem
 * call would mean one HTTP round-trip (this process -> the web service,
 * POSSIBLY A SEPARATE CONTAINER on Render - see runScanOnce.js) PLUS one
 * WebSocket fan-out to every connected dashboard, per item. That's wasteful
 * for a UI that only needs to feel "live", not literally pixel-perfect
 * per-millisecond. So progress-tick notifications (startItem/completeItem)
 * are THROTTLED to at most once every NOTIFY_THROTTLE_MS - phase
 * transitions (startPhase/endActivity) still always notify immediately,
 * since those are rare (a handful of times per scan cycle, not per item)
 * and are the transitions a user most wants to see promptly. The
 * notify-payload itself is also DB-free on the receiving end (see
 * utils/scanActivityView.js) - completedToday is deliberately NOT part of
 * the broadcast, only of the initial-load GET, to keep every broadcast
 * cheap regardless of throttling.
 */
const ScanActivity = require('../models/ScanActivity');
const { deriveScanActivityView } = require('../utils/scanActivityView');

const NOTIFY_THROTTLE_MS = 1500;
const NOTIFY_TIMEOUT_MS = 2000;

const safeUpdate = async (update, upsert = false) => {
  try {
    await ScanActivity.findOneAndUpdate({}, update, { upsert, returnDocument: 'after' });
  } catch (error) {
    console.error('[SCAN ACTIVITY] Failed to update status (non-fatal):', error.message);
  }
};

// In-memory mirror of the current ScanActivity state, updated alongside
// every DB write below. Used as the notify-payload so a broadcast never
// needs an extra DB read-back to know "what does the doc look like right
// now" - this process already knows, since it's the only writer during its
// own scan cycle (the isEmailScanRunning lock in runAllFlows.js guarantees
// that - no other process is concurrently updating this same document).
let currentState = {
  isActive: false,
  phaseLabel: null,
  totalItems: 0,
  processedItems: 0,
  currentItemLabel: null,
  currentItemStartedAt: null,
};

let lastNotifyAt = 0;

// POST to the web service's internal broadcast endpoint. Returns the
// underlying promise (settles on completion, timeout, or network failure -
// never rejects/throws) so callers that need the notify to actually have
// landed before moving on can await it - see endActivity() below. Every
// OTHER caller (startPhase/startItem/completeItem) still fires this without
// awaiting, exactly as before: a slow/unreachable web service must never
// add latency to actual email/file processing. Silently does nothing if
// WEB_SERVICE_INTERNAL_URL/INTERNAL_NOTIFY_SECRET aren't configured (e.g.
// local dev without Phase 9 set up) rather than logging noise on every scan.
const sendInternalNotify = (state) => {
  const rawUrl = process.env.WEB_SERVICE_INTERNAL_URL;
  const secret = process.env.INTERNAL_NOTIFY_SECRET;
  if (!rawUrl || !secret) return Promise.resolve();

  // On Render, this comes from a `fromService: {property: hostport}`
  // reference (see render.yaml), which yields a bare "host:port" with no
  // scheme — add one so it's a valid fetch() URL either way (a manually-set
  // local value like "http://localhost:5000" already has one and is left
  // as-is).
  const url = rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);

  return fetch(`${url.replace(/\/$/, '')}/internal/notify-progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify(state),
    signal: controller.signal,
  })
    .catch((error) => {
      console.error('[SCAN ACTIVITY] Internal notify failed (non-fatal):', error.message);
    })
    .finally(() => clearTimeout(timeoutId));
};

// @param force - true for phase transitions (always notify immediately);
//   false for per-item ticks (throttled - see NOTIFY_THROTTLE_MS above).
// Returns the notify promise (or undefined if skipped by the throttle) -
// see sendInternalNotify()'s comment on who actually awaits this.
const notify = (force) => {
  const now = Date.now();
  if (!force && now - lastNotifyAt < NOTIFY_THROTTLE_MS) return undefined;
  lastNotifyAt = now;
  return sendInternalNotify(currentState);
};

// Called once at the start of each of the 3 flows, with however many items
// that flow fetched to work through.
const startPhase = async (phaseLabel, totalItems) => {
  currentState = {
    isActive: true,
    phaseLabel,
    totalItems,
    processedItems: 0,
    currentItemLabel: null,
    currentItemStartedAt: null,
  };
  await safeUpdate({ ...currentState, phaseStartedAt: new Date() }, true);
  notify(true);
};

// Called right before starting work on one item (one email or one file).
const startItem = async (label) => {
  currentState = { ...currentState, currentItemLabel: label, currentItemStartedAt: new Date() };
  await safeUpdate({ currentItemLabel: currentState.currentItemLabel, currentItemStartedAt: currentState.currentItemStartedAt });
  notify(false);
};

// Called right after an item finishes, success OR error — the item is done
// either way and the queue count should move on.
const completeItem = async () => {
  currentState = { ...currentState, processedItems: currentState.processedItems + 1, currentItemLabel: null, currentItemStartedAt: null };
  await safeUpdate({ $inc: { processedItems: 1 }, currentItemLabel: null, currentItemStartedAt: null });
  notify(false);
};

// Called once, at the very end of runAllFlows() (after all 3 flows,
// success or error - see its finally block), NOT after each individual
// flow, so the panel doesn't flicker to "idle" between phases.
const endActivity = async () => {
  currentState = {
    isActive: false,
    phaseLabel: null,
    totalItems: 0,
    processedItems: 0,
    currentItemLabel: null,
    currentItemStartedAt: null,
  };
  await safeUpdate({ ...currentState });
  // Unlike every other notify() call (fire-and-forget, by design), THIS one
  // is awaited: on the cron path (see runScanOnce.js), the process calls
  // process.exit() shortly after runAllFlows() - and therefore this
  // function - returns. Firing the notify without waiting for it left the
  // outbound request racing process.exit(), which can kill it mid-flight -
  // the dashboard's "Processing Now" card would then never learn the scan
  // ended, and stay stuck spinning until the next scan or a manual page
  // refresh. Bounded by NOTIFY_TIMEOUT_MS regardless, so this can never
  // hang the process.
  await notify(true);
};

// Pure helper exported for the internal API layer's own use if ever
// needed (e.g. debugging) — not required for normal operation.
const getCurrentStateView = () => deriveScanActivityView(currentState);

module.exports = { startPhase, startItem, completeItem, endActivity, getCurrentStateView };
