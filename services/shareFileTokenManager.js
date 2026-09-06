const crypto = require('crypto');
const OAuthCredential = require('../models/OAuthCredential');
const { PROVIDER_KEY, refreshAccessToken, getSubdomain } = require('./shareFileOAuthSetupService');
const { formatError } = require('../utils/formatError');

const PROCESS_ID = crypto.randomUUID();

const EXPIRY_SAFETY_BUFFER_MS = 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_MS = 5 * 60 * 1000;
const LOCK_TTL_MS = 25 * 1000;
const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 40 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let memo = null;

const recordIsFresh = (record, now) =>
  Boolean(
    record &&
      record.accessToken &&
      record.accessTokenExpiresAt &&
      new Date(record.accessTokenExpiresAt).getTime() > now + EXPIRY_SAFETY_BUFFER_MS
  );

const adopt = (record) => {
  memo = {
    accessToken: record.accessToken,
    subdomain: record.subdomain || getSubdomain(),
    expiresAt: new Date(record.accessTokenExpiresAt).getTime(),
  };
  return { accessToken: memo.accessToken, subdomain: memo.subdomain };
};

const persistRefreshResult = async (result) => {
  const lifetimeMs = result.expiresIn ? result.expiresIn * 1000 : DEFAULT_TOKEN_LIFETIME_MS;
  const accessTokenExpiresAt = new Date(Date.now() + lifetimeMs);
  const update = {
    accessToken: result.accessToken,
    accessTokenExpiresAt,
    subdomain: result.subdomain,
    refreshLockedUntil: null,
    refreshLockHolder: null,
  };
  if (result.newRefreshToken) update.refreshToken = result.newRefreshToken;
  await OAuthCredential.updateOne({ provider: PROVIDER_KEY }, { $set: update });
  return adopt({ accessToken: result.accessToken, accessTokenExpiresAt, subdomain: result.subdomain });
};

const runRefreshUnderLock = async (lockedRecord) => {
  let result;
  try {
    result = await refreshAccessToken(lockedRecord.refreshToken);
  } catch (error) {
    if (error.code === 'invalid_grant') {
      const latest = await OAuthCredential.findOne({ provider: PROVIDER_KEY }).lean();
      if (latest && latest.refreshToken && latest.refreshToken !== lockedRecord.refreshToken) {
        result = await refreshAccessToken(latest.refreshToken);
      } else {
        throw new Error(
          'ShareFile refresh token is invalid or revoked. Re-authorize at /oauth/sharefile/start.'
        );
      }
    } else {
      throw error;
    }
  }
  return persistRefreshResult(result);
};

const releaseLock = async () => {
  await OAuthCredential.updateOne(
    { provider: PROVIDER_KEY, refreshLockHolder: PROCESS_ID },
    { $set: { refreshLockedUntil: null, refreshLockHolder: null } }
  ).catch(() => {});
};

const refreshCoordinated = async (forceRefresh) => {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  for (;;) {
    const now = Date.now();
    const claimed = await OAuthCredential.findOneAndUpdate(
      {
        provider: PROVIDER_KEY,
        $or: [
          { refreshLockedUntil: { $exists: false } },
          { refreshLockedUntil: null },
          { refreshLockedUntil: { $lt: new Date(now) } },
        ],
      },
      { $set: { refreshLockedUntil: new Date(now + LOCK_TTL_MS), refreshLockHolder: PROCESS_ID } },
      { new: true }
    ).lean();

    if (claimed) {
      try {
        if (!forceRefresh && recordIsFresh(claimed, Date.now())) {
          return adopt(claimed);
        }
        return await runRefreshUnderLock(claimed);
      } catch (error) {
        await releaseLock();
        throw error;
      }
    }

    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for another process to refresh the ShareFile token.');
    }

    await sleep(POLL_INTERVAL_MS);
    const latest = await OAuthCredential.findOne({ provider: PROVIDER_KEY }).lean();
    if (recordIsFresh(latest, Date.now())) {
      return adopt(latest);
    }
  }
};

const getAccessToken = async ({ forceRefresh = false } = {}) => {
  const now = Date.now();

  if (!forceRefresh && memo && memo.expiresAt > now + EXPIRY_SAFETY_BUFFER_MS) {
    return { accessToken: memo.accessToken, subdomain: memo.subdomain };
  }

  const record = await OAuthCredential.findOne({ provider: PROVIDER_KEY }).lean();
  if (!record || !record.refreshToken) {
    throw new Error(
      'No ShareFile authorization available. Complete the hosted login at /oauth/sharefile/start.'
    );
  }

  if (!forceRefresh && recordIsFresh(record, now)) {
    return adopt(record);
  }

  try {
    return await refreshCoordinated(forceRefresh);
  } catch (error) {
    console.error(`shareFileTokenManager.getAccessToken ERROR: ${formatError(error)}`);
    throw error;
  }
};

const _resetMemo = () => {
  memo = null;
};

module.exports = { getAccessToken, PROCESS_ID, _resetMemo };
