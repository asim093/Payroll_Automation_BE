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
