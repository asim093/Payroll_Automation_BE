require('dotenv').config();

const RETRYABLE = 'ShareFile: could not create the folder automatically, please check manually. (some 401)';
const INFO_ONLY = 'Using the existing ShareFile folder "Clients/X", which already contains 2 items. New files for this client will be added there.';

// ---- in-memory Client store ----
const Client = require('./models/Client');
let clients;
const mkClient = (over) => ({
  _id: over._id || `c${Math.random().toString(36).slice(2, 8)}`,
  name: over.name || 'Test',
  folderSetupWarnings: over.folderSetupWarnings || [],
  folderSetupRetry: over.folderSetupRetry || { attempts: 0, lastAttemptAt: null, exhausted: false },
  async save() {
    const i = clients.findIndex((c) => c._id === this._id);
    clients[i] = this;
    return this;
  },
});

Client.find = (query) => {
  let rows = clients.filter((c) => (c.folderSetupWarnings || []).length > 0);
  if (query && query['folderSetupRetry.exhausted'] && query['folderSetupRetry.exhausted'].$ne === true) {
    rows = rows.filter((c) => !c.folderSetupRetry?.exhausted);
  }
  return Promise.resolve(rows);
};

const folderSetup = require('./services/clientFolderSetupService');
let setupImpl;
folderSetup.setupClientFolders = (...a) => setupImpl(...a);

const { retryPendingFolderSetups, MAX_ATTEMPTS } = require('./services/folderSetupRetryService');

let pass = 0;
let fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); }
};

(async () => {
  // 1. a transient failure that then succeeds -> warning cleared, retry state reset
  clients = [mkClient({ name: 'Recovers', folderSetupWarnings: [RETRYABLE] })];
  setupImpl = async () => ({ warnings: [], notices: [] });
  let res = await retryPendingFolderSetups();
  ok('resolved client count is 1', res.resolved === 1, res);
  ok('warning cleared after a successful retry', clients[0].folderSetupWarnings.length === 0);
  ok('retry state reset on success', clients[0].folderSetupRetry.attempts === 0 && clients[0].folderSetupRetry.exhausted === false);

  // 2. info-only notice is never retried
  clients = [mkClient({ name: 'InfoOnly', folderSetupWarnings: [INFO_ONLY] })];
  setupImpl = async () => { throw new Error('should not be called'); };
  res = await retryPendingFolderSetups();
  ok('a folder-reuse notice is not treated as pending', res.retried === 0, res);

  // 3. persistent failure -> attempts climb, then exhausted, then skipped
  clients = [mkClient({ name: 'Broken', folderSetupWarnings: [RETRYABLE] })];
  setupImpl = async () => ({ warnings: [RETRYABLE], notices: [] });
  for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
    clients[0].folderSetupRetry.lastAttemptAt = null; // bypass backoff for the test
    await retryPendingFolderSetups();
  }
  ok(`attempts capped at ${MAX_ATTEMPTS}`, clients[0].folderSetupRetry.attempts === MAX_ATTEMPTS, clients[0].folderSetupRetry);
  ok('client marked exhausted after max attempts', clients[0].folderSetupRetry.exhausted === true);
  const callsBefore = clients[0].folderSetupRetry.attempts;
  clients[0].folderSetupRetry.lastAttemptAt = null;
  await retryPendingFolderSetups();
  ok('an exhausted client is skipped on later ticks', clients[0].folderSetupRetry.attempts === callsBefore);

  // 4. backoff: a just-attempted client is not retried again immediately
  clients = [mkClient({
    name: 'JustTried',
    folderSetupWarnings: [RETRYABLE],
    folderSetupRetry: { attempts: 1, lastAttemptAt: new Date(), exhausted: false },
  })];
  setupImpl = async () => { throw new Error('should not be called yet'); };
  res = await retryPendingFolderSetups();
  ok('backoff prevents an immediate re-retry', res.retried === 0, res);

  // 5. setupClientFolders throwing is caught, attempt still recorded
  clients = [mkClient({ name: 'Throws', folderSetupWarnings: [RETRYABLE] })];
  setupImpl = async () => { throw new Error('ShareFile exploded'); };
  res = await retryPendingFolderSetups();
  ok('a thrown error is caught, not fatal', res.retried === 1 && res.resolved === 0, res);
  ok('attempt recorded even when setup throws', clients[0].folderSetupRetry.attempts === 1, clients[0].folderSetupRetry);

  console.log(`\n${fail === 0 ? 'ALL GREEN' : fail + ' FAILURES'} (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
})();
