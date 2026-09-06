const assert = require('node:assert/strict');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- in-memory OAuthCredential store with an atomic lock claim ----
const OAuthCredential = require('./models/OAuthCredential');
let doc;
let refreshCalls;
let refreshImpl;

const resetStore = () => {
  doc = {
    provider: 'sharefile',
    refreshToken: 'r0',
    accessToken: null,
    accessTokenExpiresAt: null,
    subdomain: 'sub',
    refreshLockedUntil: null,
    refreshLockHolder: null,
  };
  refreshCalls = 0;
  refreshImpl = async () => {
    refreshCalls += 1;
    await sleep(25);
    return { accessToken: `at-${refreshCalls}`, subdomain: 'sub', expiresIn: 3600, newRefreshToken: `r${refreshCalls}` };
  };
};
resetStore();

OAuthCredential.findOne = () => ({ lean: async () => (doc ? { ...doc } : null) });
OAuthCredential.findOneAndUpdate = (filter, update) => {
  // synchronous check-and-set => atomic w.r.t. the event loop, like Mongo
  const now = Date.now();
  const lockFree =
    !doc.refreshLockedUntil || new Date(doc.refreshLockedUntil).getTime() < now;
  const claimed = !(filter.$or && !lockFree);
  if (claimed) Object.assign(doc, update.$set);
  const snapshot = claimed ? { ...doc } : null;
  return { lean: async () => snapshot };
};
OAuthCredential.updateOne = async (filter, update) => {
  if (filter.refreshLockHolder && filter.refreshLockHolder !== doc.refreshLockHolder) {
    return { modifiedCount: 0 };
  }
  Object.assign(doc, update.$set);
  return { modifiedCount: 1 };
};

const oauthSetup = require('./services/shareFileOAuthSetupService');
oauthSetup.getSubdomain = () => 'sub';
oauthSetup.refreshAccessToken = (...args) => refreshImpl(...args);

const { getAccessToken, _resetMemo } = require('./services/shareFileTokenManager');

let pass = 0;
let fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); }
};

(async () => {
  // 1. concurrent callers => exactly one refresh
  resetStore();
  _resetMemo();
  const results = await Promise.all(Array.from({ length: 6 }, () => getAccessToken()));
  ok('6 concurrent callers trigger exactly ONE refresh', refreshCalls === 1, refreshCalls);
  ok('all concurrent callers get the same access token', new Set(results.map((r) => r.accessToken)).size === 1, results.map((r) => r.accessToken));
  ok('lock is released after refresh', doc.refreshLockedUntil === null && doc.refreshLockHolder === null);
  ok('new rotated refresh token was persisted', doc.refreshToken === 'r1', doc.refreshToken);

  // 2. in-process memo avoids a second refresh
  await getAccessToken();
  ok('a subsequent call is served from memo (no new refresh)', refreshCalls === 1, refreshCalls);

  // 3. forceRefresh bypasses memo
  await getAccessToken({ forceRefresh: true });
  ok('forceRefresh triggers a new refresh', refreshCalls === 2, refreshCalls);

  // 4. a DB-fresh token is adopted without any refresh
  resetStore();
  _resetMemo();
  doc.accessToken = 'pre-existing';
  doc.accessTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const adopted = await getAccessToken();
  ok('a still-valid shared token is adopted, no refresh', refreshCalls === 0 && adopted.accessToken === 'pre-existing', { refreshCalls, adopted });

  // 5. poller path: another process holds the lock, then publishes a token
  resetStore();
  _resetMemo();
  doc.refreshLockedUntil = new Date(Date.now() + 30 * 1000);
  doc.refreshLockHolder = 'someone-else';
  const pending = getAccessToken();
  setTimeout(() => {
    doc.accessToken = 'published-by-other';
    doc.accessTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    doc.refreshLockedUntil = null;
    doc.refreshLockHolder = null;
  }, 300);
  const polled = await pending;
  ok('poller adopts the token another process published', polled.accessToken === 'published-by-other', polled);
  ok('poller never called refresh itself', refreshCalls === 0, refreshCalls);

  // 6. invalid_grant surfaces a clear re-auth error and releases the lock
  resetStore();
  _resetMemo();
  refreshImpl = async () => { const e = new Error('bad'); e.code = 'invalid_grant'; throw e; };
  let threw = null;
  try { await getAccessToken(); } catch (e) { threw = e; }
  ok('invalid_grant rejects with a re-auth hint', threw && /\/oauth\/sharefile\/start/.test(threw.message), threw && threw.message);
  ok('lock is released after a failed refresh', doc.refreshLockedUntil === null && doc.refreshLockHolder === null);

  console.log(`\n${fail === 0 ? 'ALL GREEN' : fail + ' FAILURES'} (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
})();
