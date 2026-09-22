const crypto = require('crypto');

// Generic in-memory job tracker, same pattern as
// complianceReportGenerationJobs.js — a page refresh loses job tracking,
// which is fine since the underlying work itself is unaffected and the real
// per-item result is visible in the data either way. Jobs are pruned a
// while after completion so this Map can't grow unbounded across a
// long-running server process.
const JOB_TTL_MS = 10 * 60 * 1000;

const jobs = new Map();

const createJob = (itemIds) => {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, {
    jobId,
    total: itemIds.length,
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
