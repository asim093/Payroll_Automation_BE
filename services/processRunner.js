const SystemStatus = require('../models/SystemStatus');
const { endActivity } = require('./scanActivityService');

const LOCK_STALE_MS = 15 * 60 * 1000;

const runGuardedProcess = async (processKey, work, { staleMs = LOCK_STALE_MS } = {}) => {
  const staleThreshold = new Date(Date.now() - staleMs);
  const lockField = `${processKey}.isRunning`;
  const startedAtField = `${processKey}.runStartedAt`;

  let lockDoc = await SystemStatus.findOneAndUpdate(
    { $or: [{ [lockField]: { $ne: true } }, { [startedAtField]: { $lt: staleThreshold } }] },
    { [lockField]: true, [startedAtField]: new Date() },
    { returnDocument: 'after' }

  );

  if (!lockDoc) {
    const existing = await SystemStatus.findOne();

    if (existing) {
      const startedAt = existing[processKey]?.runStartedAt;
      const lockAgeMs = startedAt ? Date.now() - new Date(startedAt).getTime() : null;
      console.log(
        `[${processKey}] Previous run still in progress` +
          (lockAgeMs !== null ? ` (started ${Math.round(lockAgeMs / 1000)}s ago)` : '') +
          ' - skipping this cycle.'
      );
      return { skipped: true, reason: 'previous_run_still_in_progress' };
    }

    lockDoc = await SystemStatus.findOneAndUpdate(
      {},
      { [lockField]: true, [startedAtField]: new Date() },
      { upsert: true, returnDocument: 'after' }
    );
  }

  try {
    const result = await work();

    await SystemStatus.findOneAndUpdate(
      {},
      {
        [`${processKey}.lastRunAt`]: new Date(),
        [`${processKey}.lastRunResult`]: result,
        [`${processKey}.lastRunSuccess`]: result?.success !== false,
      },
      { upsert: true }
    );

    return result;
  } catch (error) {
    console.error(`[${processKey}] Unexpected error:`, error.message);
    const result = { success: false, error: error.message };

    try {
      await SystemStatus.findOneAndUpdate(
        {},
        {
          [`${processKey}.lastRunAt`]: new Date(),
          [`${processKey}.lastRunResult`]: result,
          [`${processKey}.lastRunSuccess`]: false,
        },
        { upsert: true }
      );
    } catch (writeError) {
      console.error(`[${processKey}] Failed to persist failed-run status:`, writeError.message);
    }

    return result;
  } finally {
    try {
      await SystemStatus.findOneAndUpdate({}, { [lockField]: false });
    } catch (error) {
      console.error(`[${processKey}] Failed to release lock:`, error.message);
    }
    await endActivity(processKey);
  }
};

module.exports = { runGuardedProcess };
