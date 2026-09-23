// Cron processes (runMailSyncOnce.js, runShareFileBridgeOnce.js) run as
// separate Node processes from the web service and never call initSocket(),
// so they have no `io` instance to emit on directly — calling
// broadcastClientDataChanged() from inside a cron process silently no-ops.
// This mirrors the existing scanActivityService.js -> /internal/notify-progress
// pattern: POST to the web service, which DOES hold the live socket
// connections, and let IT call broadcastClientDataChanged for real.
const NOTIFY_TIMEOUT_MS = 2000;

const notifyClientDataChanged = (payload) => {
  const rawUrl = process.env.WEB_SERVICE_INTERNAL_URL;
  const secret = process.env.INTERNAL_NOTIFY_SECRET;
  if (!rawUrl || !secret) return Promise.resolve();

  const url = rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);

  return fetch(`${url.replace(/\/$/, '')}/internal/notify-client-data-changed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .catch((error) => {
      console.error('[CROSS-PROCESS-NOTIFY] notify-client-data-changed failed (non-fatal):', error.message);
    })
    .finally(() => clearTimeout(timeoutId));
};

module.exports = { notifyClientDataChanged };
