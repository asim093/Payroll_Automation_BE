const Client = require('../models/Client');
const { setupClientFolders } = require('./clientFolderSetupService');
const { formatError } = require('../utils/formatError');

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

const RETRYABLE_WARNING = /could not create the (folder|mail folder) automatically/i;

const hasRetryableWarning = (warnings = []) => warnings.some((w) => RETRYABLE_WARNING.test(w));

const backoffMs = (attempts) => Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);

const isDue = (client, now) => {
  const retry = client.folderSetupRetry || {};
  if (retry.exhausted) return false;
  if ((retry.attempts || 0) >= MAX_ATTEMPTS) return false;
  if (!retry.lastAttemptAt) return true;
  return now - new Date(retry.lastAttemptAt).getTime() >= backoffMs(retry.attempts || 0);
};

const retryOne = async (client) => {
  const warnings = await setupClientFolders(client);
  const attempts = (client.folderSetupRetry?.attempts || 0) + 1;
  const stillFailing = hasRetryableWarning(warnings);

  client.folderSetupWarnings = warnings;
  client.folderSetupRetry = stillFailing
    ? { attempts, lastAttemptAt: new Date(), exhausted: attempts >= MAX_ATTEMPTS }
    : { attempts: 0, lastAttemptAt: new Date(), exhausted: false };
  await client.save();

  return { name: client.name, resolved: !stillFailing, attempts, exhausted: client.folderSetupRetry.exhausted };
};

const retryPendingFolderSetups = async () => {
  const candidates = await Client.find({
    folderSetupWarnings: { $exists: true, $ne: [] },
    'folderSetupRetry.exhausted': { $ne: true },
  });

  const now = Date.now();
  const due = candidates.filter((c) => hasRetryableWarning(c.folderSetupWarnings) && isDue(c, now));

  if (due.length === 0) return { checked: candidates.length, retried: 0, resolved: 0, results: [] };

  const results = [];
  for (const client of due) {
    try {
      results.push(await retryOne(client));
    } catch (error) {
      const message = formatError(error);
      console.error(`[FOLDER-RETRY] "${client.name}" retry threw: ${message}`);
      const attempts = (client.folderSetupRetry?.attempts || 0) + 1;
      client.folderSetupRetry = {
        attempts,
        lastAttemptAt: new Date(),
        exhausted: attempts >= MAX_ATTEMPTS,
      };
      await client.save().catch(() => {});
      results.push({ name: client.name, resolved: false, attempts, error: message });
    }
  }

  const resolved = results.filter((r) => r.resolved).length;
  console.log(
    `[FOLDER-RETRY] retried ${results.length} client(s), ${resolved} resolved, ${results.length - resolved} still pending.`
  );
  return { checked: candidates.length, retried: results.length, resolved, results };
};

module.exports = { retryPendingFolderSetups, hasRetryableWarning, MAX_ATTEMPTS, RETRYABLE_WARNING };
