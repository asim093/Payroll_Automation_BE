const ComplianceGenerationJob = require('../models/ComplianceGenerationJob');

const createJob = async (clientIds) => {
  const job = await ComplianceGenerationJob.create({
    status: 'running',
    clientIds,
    total: clientIds.length,
    results: [],
    logiFormsWarnings: [],
    startedAt: new Date(),
  });
  return job._id.toString();
};

const toJobDto = (job) => ({
  jobId: job._id.toString(),
  total: job.total,
  completed: job.results.length,
  done: job.status !== 'running',
  status: job.status,
  results: job.results,
  warnings: job.logiFormsWarnings,
});

const getJob = async (jobId) => {
  const job = await ComplianceGenerationJob.findById(jobId).lean();
  return job ? toJobDto(job) : null;
};

const getActiveJob = async () => {
  const job = await ComplianceGenerationJob.findOne({ status: 'running' }).sort({ startedAt: -1 }).lean();
  return job ? toJobDto(job) : null;
};

const recordResult = async (jobId, result) => {
  const job = await ComplianceGenerationJob.findByIdAndUpdate(
    jobId,
    { $push: { results: result } },
    { returnDocument: 'after' }
  );
  if (!job) return;
  if (job.results.length >= job.total) {
    job.status = 'completed';
    job.completedAt = new Date();
    await job.save();
  }
};

const setJobWarnings = async (jobId, warnings) => {
  await ComplianceGenerationJob.updateOne({ _id: jobId }, { $set: { logiFormsWarnings: warnings } });
};

const markJobFailed = async (jobId) => {
  await ComplianceGenerationJob.updateOne({ _id: jobId }, { $set: { status: 'failed', completedAt: new Date() } });
};

module.exports = { createJob, getJob, getActiveJob, recordResult, setJobWarnings, markJobFailed };
