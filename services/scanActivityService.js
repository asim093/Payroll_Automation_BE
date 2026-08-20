
const ScanActivity = require('../models/ScanActivity');

const NOTIFY_THROTTLE_MS = 1500;
const NOTIFY_TIMEOUT_MS = 2000;

const safeUpdate = async (processKey, update, upsert = false) => {
  try {
    await ScanActivity.findOneAndUpdate({ processKey }, update, { upsert, returnDocument: 'after' });
  } catch (error) {
    console.error(`[SCAN ACTIVITY] Failed to update status for ${processKey} (non-fatal):`, error.message);
  }
};

const EMPTY_STATE = {
  isActive: false,
  phaseLabel: null,
  totalItems: 0,
  processedItems: 0,
  currentItemLabel: null,
  currentItemStartedAt: null,
};


const currentStates = new Map();
const lastNotifyAtByKey = new Map();

const getState = (processKey) => currentStates.get(processKey) || EMPTY_STATE;


const sendInternalNotify = (processKey, state) => {
  const rawUrl = process.env.WEB_SERVICE_INTERNAL_URL;
  const secret = process.env.INTERNAL_NOTIFY_SECRET;
  if (!rawUrl || !secret) return Promise.resolve();

  
  const url = rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);

  return fetch(`${url.replace(/\/$/, '')}/internal/notify-progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify({ processKey, ...state }),
    signal: controller.signal,
  })
    .catch((error) => {
      console.error('[SCAN ACTIVITY] Internal notify failed (non-fatal):', error.message);
    })
    .finally(() => clearTimeout(timeoutId));
};


const notify = (processKey, force) => {
  const now = Date.now();
  const lastNotifyAt = lastNotifyAtByKey.get(processKey) || 0;
  if (!force && now - lastNotifyAt < NOTIFY_THROTTLE_MS) return undefined;
  lastNotifyAtByKey.set(processKey, now);
  return sendInternalNotify(processKey, getState(processKey));
};


const startPhase = async (processKey, phaseLabel, totalItems) => {
  const state = { ...EMPTY_STATE, isActive: true, phaseLabel, totalItems };
  currentStates.set(processKey, state);
  await safeUpdate(processKey, { ...state, phaseStartedAt: new Date() }, true);
  notify(processKey, true);
};

const startItem = async (processKey, label) => {
  const state = { ...getState(processKey), currentItemLabel: label, currentItemStartedAt: new Date() };
  currentStates.set(processKey, state);
  await safeUpdate(processKey, { currentItemLabel: state.currentItemLabel, currentItemStartedAt: state.currentItemStartedAt });
  notify(processKey, false);
};

const completeItem = async (processKey) => {
  const prev = getState(processKey);
  const state = { ...prev, processedItems: prev.processedItems + 1, currentItemLabel: null, currentItemStartedAt: null };
  currentStates.set(processKey, state);
  await safeUpdate(processKey, { $inc: { processedItems: 1 }, currentItemLabel: null, currentItemStartedAt: null });
  notify(processKey, false);
};

const endActivity = async (processKey) => {
  currentStates.set(processKey, EMPTY_STATE);
  await safeUpdate(processKey, { ...EMPTY_STATE });
  await notify(processKey, true);
};

module.exports = { startPhase, startItem, completeItem, endActivity };
