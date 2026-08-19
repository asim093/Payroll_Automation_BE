// PHASE 9 — shared derivation logic, used by BOTH GET /api/scan-activity
// (controllers/scanActivityController.js) and the internal WebSocket-
// broadcast path (controllers/internalController.js), so the two never
// drift out of sync with each other.
//
// Deliberately a PURE function with no DB access: the broadcast path calls
// this on every throttled progress-tick during a scan (see
// services/scanActivityService.js's notify()), so keeping it DB-free here
// means each broadcast costs nothing beyond a bit of arithmetic — no extra
// Mongo round-trip per tick. completedToday (which DOES need an
// EmailLog/FileLog count query) is deliberately NOT part of this function;
// it's computed once, separately, only by the GET route — see that
// controller's own comment.
const SLOW_ITEM_THRESHOLD_MS = 30 * 1000;

const deriveScanActivityView = (raw) => {
  if (!raw || !raw.isActive) {
    return {
      isActive: false,
      phaseLabel: null,
      queueRemaining: 0,
      activelyProcessing: 0,
      currentItemLabel: null,
      currentItemElapsedMs: null,
      isCurrentItemSlow: false,
    };
  }

  const currentItemElapsedMs = raw.currentItemStartedAt
    ? Date.now() - new Date(raw.currentItemStartedAt).getTime()
    : null;

  return {
    isActive: true,
    phaseLabel: raw.phaseLabel,
    queueRemaining: Math.max((raw.totalItems || 0) - (raw.processedItems || 0), 0),
    activelyProcessing: raw.currentItemLabel ? 1 : 0,
    currentItemLabel: raw.currentItemLabel,
    currentItemElapsedMs,
    isCurrentItemSlow: Boolean(currentItemElapsedMs && currentItemElapsedMs > SLOW_ITEM_THRESHOLD_MS),
  };
};

module.exports = { deriveScanActivityView, SLOW_ITEM_THRESHOLD_MS };
