const crypto = require('crypto');

// In-memory only — a page refresh loses job tracking, which is fine here
// since the underlying generation work itself is unaffected and the client
// list will simply show the real per-client result once it completes either
// way. Jobs are pruned a while after completion so this Map can't grow
// unbounded across a long-running server process.
const JOB_TTL_MS = 10 * 60 * 1000;

const jobs = new Map();

const createJob = (clientIds) => {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, {
    jobId,
    total: clientIds.length,
    completed: 0,
    done: false,
    results: [],
    startedAt: new Date(),
  });
  return jobId;
};

const getJob = (jobId) => jobs.get(jobId) || null;

const recordResult = (jobId, result) => {
  const job = jobs.get(jobId);
  if (!job) return;
  job.results.push(result);
  job.completed += 1;
  if (job.completed >= job.total) {
    job.done = true;
    setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
  }
};

module.exports = { createJob, getJob, recordResult };
