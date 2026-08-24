/**
 * PHASE-UI-17 — live "does this token actually work" verification, for the
 * exact moment right after Marcel (or anyone) completes a hosted OAuth
 * login. A refresh token existing in MongoDB only proves the LOGIN
 * succeeded - it says nothing about whether the granted permissions are
 * the right TYPE (Delegated vs Application) or scope, which is a separate
 * failure mode that would otherwise only surface later, during a scheduled
 * scan, far from anyone able to fix it live.
 *
 * Each test here does the smallest possible real read (and, for Dropbox
 * only, a tiny write+delete) against the actual provider API using the
 * freshly-obtained token - not a mock, not just "did acquireToken not
 * throw". `forceRefresh: true` is used everywhere a cache exists
 * (sharefileService.js / dropboxService.js) so a stale-but-still-valid
 * OLD token cached from before this login can't mask whether the NEW one
 * actually works.
 */
const { getAccessTokenFromRefreshToken } = require('./delegatedAuthService');
const { getDropboxAccessToken } = require('./dropboxService');
const { getShareFileContext } = require('./sharefileService');
const { formatError } = require('../utils/formatError');

const TEST_TIMEOUT_MS = 8000;

// Races the real test against a timer so one hung provider can never make
// the whole smoke-test page hang - each test resolves (never rejects, never
// hangs past 8s) with a normal FAIL result instead.
const withTimeout = (label, promise) =>
  Promise.race([
    promise,
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ label, pass: false, error: `Timed out after ${TEST_TIMEOUT_MS / 1000}s (provider took too long to respond).` }),
        TEST_TIMEOUT_MS
      )
    ),
  ]);

// ============================================================
// MICROSOFT / OUTLOOK
// ============================================================
const classifyGraphError = (status) => {
  if (status === 401) return 'Token invalid ya expired lagta hai — dobara login try karein.';
  if (status === 403) return 'Permission/consent ka masla ho sakta hai — Azure mein "API permissions" check karein ke Mail.Read Delegated-type hai (Application nahi), aur admin-consent grant hui hai.';
  return null;
};

const testMicrosoft = async () => {
  const label = 'Microsoft / Outlook';

  // Split into two try/catches on purpose - a failure getting the token at
  // all (no login completed yet) and a failure calling Graph WITH a token
  // (permissions/network) are different problems with different fixes, and
  // conflating them under one generic hint would mislead whoever's reading
  // this live during the call.
  let accessToken;
  try {
    accessToken = await getAccessTokenFromRefreshToken();
  } catch (error) {
    return {
      label,
      pass: false,
      error: formatError(error),
      hint: 'Koi delegated login/token available nahi hai — pehle /oauth/microsoft/start se login complete karna hoga.',
    };
  }

  try {
    const response = await fetch(
      'https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=subject,receivedDateTime',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const code = data?.error?.code || `HTTP ${response.status}`;
      const message = data?.error?.message || 'Unknown error';
      return { label, pass: false, error: `${code}: ${message}`, hint: classifyGraphError(response.status) };
    }

    const first = data.value?.[0];
    return {
      label,
      pass: true,
      detail: first
        ? `Read access confirmed — latest email subject: "${first.subject || '(no subject)'}"`
        : 'Read access confirmed (inbox has no messages right now, but the permission works).',
    };
  } catch (error) {
    return { label, pass: false, error: formatError(error), hint: 'Network/connection error - dobara try karein.' };
  }
};

// ============================================================
// DROPBOX
// ============================================================
const classifyDropboxError = (status) => {
  if (status === 401) return 'Token invalid ya expired lagta hai — dobara login try karein.';
  if (status === 403 || status === 409) return 'Permission/scope ka masla ho sakta hai — Dropbox App Console mein required scopes (files.metadata.read, files.content.write) check karein.';
  return null;
};

const testDropboxWrite = async (accessToken) => {
  const testPath = '/__oauth_smoke_test__.txt';
  try {
    const uploadResponse = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: testPath, mode: 'overwrite' }),
        'Content-Type': 'application/octet-stream',
      },
      body: 'oauth smoke test - safe to ignore/delete',
    });
    const uploadOk = uploadResponse.ok;
    const uploadData = uploadOk ? null : await uploadResponse.json().catch(() => ({}));

    // Always attempt cleanup, even if upload itself failed partway - never
    // leave the test file behind on a partial success.
    const deleteResponse = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: testPath }),
    }).catch(() => null);

    if (!uploadOk) {
      return { pass: false, error: uploadData?.error_summary || `Upload failed (HTTP ${uploadResponse.status})` };
    }
    if (deleteResponse && !deleteResponse.ok) {
      return { pass: true, warning: 'Upload OK, but cleanup-delete failed - a small test file may be left at /__oauth_smoke_test__.txt, safe to delete manually.' };
    }
    return { pass: true };
  } catch (error) {
    return { pass: false, error: formatError(error) };
  }
};

const testDropbox = async () => {
  const label = 'Dropbox';

  let accessToken;
  try {
    accessToken = await getDropboxAccessToken({ forceRefresh: true });
  } catch (error) {
    return {
      label,
      pass: false,
      error: formatError(error),
      hint: 'Koi Dropbox login/token available nahi hai — pehle /oauth/dropbox/start se login complete karna hoga.',
    };
  }

  try {
    const listResponse = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '' }),
    });
    const listData = await listResponse.json().catch(() => ({}));

    if (!listResponse.ok) {
      return {
        label,
        pass: false,
        error: listData?.error_summary || `HTTP ${listResponse.status}`,
        hint: classifyDropboxError(listResponse.status),
      };
    }

    const writeTest = await testDropboxWrite(accessToken);
    return {
      label,
      pass: true,
      detail: `Read access confirmed — root folder has ${listData.entries?.length ?? 0} item(s) visible.`,
      writeTest,
    };
  } catch (error) {
    return { label, pass: false, error: formatError(error), hint: 'Network/connection error - dobara try karein.' };
  }
};

// ============================================================
// SHAREFILE
// ============================================================
const classifyShareFileError = (status) => {
  if (status === 401) return 'Token invalid ya expired lagta hai — dobara login try karein.';
  if (status === 403) return 'Permission ka masla ho sakta hai — ShareFile app ke scopes check karein.';
  return null;
};

const testShareFile = async () => {
  const label = 'ShareFile';

  let context;
  try {
    context = await getShareFileContext({ forceRefresh: true });
  } catch (error) {
    return {
      label,
      pass: false,
      error: formatError(error),
      hint: 'Koi ShareFile login/token available nahi hai — pehle /oauth/sharefile/start se login complete karna hoga.',
    };
  }

  try {
    const { apiBase, authHeaders, rootId } = context;
    const response = await fetch(`${apiBase}/Items(${rootId})/Children?$top=1`, { headers: authHeaders });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = data?.message?.message || data?.error?.message || `HTTP ${response.status}`;
      return { label, pass: false, error: message, hint: classifyShareFileError(response.status) };
    }

    return {
      label,
      pass: true,
      detail: `Read access confirmed — Shared Folders root is reachable (${data.value?.length ?? 0}+ item(s) visible).`,
    };
  } catch (error) {
    return { label, pass: false, error: formatError(error), hint: 'Network/connection error - dobara try karein.' };
  }
};

// ============================================================
// RUN ALL THREE
// ============================================================
const runAllSmokeTests = async () => {
  const [microsoft, dropbox, sharefile] = await Promise.all([
    withTimeout('Microsoft / Outlook', testMicrosoft()),
    withTimeout('Dropbox', testDropbox()),
    withTimeout('ShareFile', testShareFile()),
  ]);
  return { microsoft, dropbox, sharefile };
};

module.exports = { runAllSmokeTests };
