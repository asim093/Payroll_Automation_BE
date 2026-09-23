const EmailActionJob = require('../models/EmailActionJob');

const DEFAULT_CONCURRENCY = 4;

// Maps sourceType -> the existing per-item action function to reuse
// unchanged (idempotency via loadActionableRow, orphaned-draft graphMessageId
// capture, and the draft/send Graph calls themselves all already live there —
// this job layer only adds job-level tracking + bounded concurrency around
// calls that already work correctly one at a time).
const actionFnForSourceType = (sourceType) => {
  if (sourceType === 'applicant_reminder') {
    return require('./applicantReminderService').actionReminders;
  }
  if (sourceType === 'customer_report_email') {
    return require('./customerReportEmailService').actionCustomerReportEmails;
  }
  throw new Error(`Unknown EmailActionJob sourceType: ${sourceType}`);
};

// SAFETY GATE: for mode 'send', this MUST run and MUST throw before
// EmailActionJob.create(...) below — Mail.Send is not yet granted, and
// REMINDER_SEND_ENABLED / COMPLIANCE_EMAIL_SEND_ENABLED are hardcoded false
// in reminderDraftService.js / customerEmailDraftService.js until it is.
// Checking here means attempting "Send All" today produces a clean 400 with
// zero Graph calls, zero drafts, and zero job document ever created — not a
// job that gets created and then immediately fails item 1.
const assertSendModeAllowed = (sourceType) => {
  const { REMINDER_SEND_ENABLED } = require('./reminderDraftService');
  const { COMPLIANCE_EMAIL_SEND_ENABLED } = require('./customerEmailDraftService');
  const enabled = sourceType === 'applicant_reminder' ? REMINDER_SEND_ENABLED : COMPLIANCE_EMAIL_SEND_ENABLED;
  if (enabled !== true) {
    const label = sourceType === 'applicant_reminder' ? 'WOTC reminders' : 'Customer Report emails';
    const error = new Error(
      `Real sending is not yet enabled for ${label} (Mail.Send permission pending). Choose Draft instead, or ask an administrator to enable real sending first.`
    );
    error.statusCode = 400;
    throw error;
  }
};

const createEmailActionJob = async ({ sourceType, mode, itemIds, operatorEmail }) => {
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    const error = new Error('itemIds must be a non-empty array.');
    error.statusCode = 400;
    throw error;
  }

  if (mode === 'send') {
    assertSendModeAllowed(sourceType);
  }

  const job = await EmailActionJob.create({
    sourceType,
    mode,
    status: 'pending',
    operatorEmail: operatorEmail || '',
    total: itemIds.length,
    items: itemIds.map((itemId) => ({ itemId, status: 'pending' })),
    startedAt: new Date(),
  });

  // Fire-and-forget — the HTTP caller gets the jobId immediately and polls
  // for progress, same pattern as compliance report generation.
  runEmailActionJob(job._id.toString()).catch((error) => {
    console.error(`[EMAIL-ACTION-JOB] job ${job._id} crashed unexpectedly: ${error.message}`);
  });

  return job._id.toString();
};

const setItemStatus = async (jobId, itemId, patch) => {
  await EmailActionJob.updateOne(
    { _id: jobId, 'items.itemId': itemId },
    {
      $set: Object.fromEntries(Object.entries(patch).map(([key, value]) => [`items.$.${key}`, value])),
    }
  );
};

const runEmailActionJob = async (jobId) => {
  const job = await EmailActionJob.findById(jobId);
  if (!job) return;

  if (job.status === 'pending') {
    job.status = 'running';
    await job.save();
  }

  const actionFn = actionFnForSourceType(job.sourceType);

  // Resume-safe: only items still 'pending' are picked up. An item stuck in
  // 'processing' from a crashed prior run is reset to 'pending' first (see
  // resumeRunningEmailActionJobs) rather than assumed complete — the
  // underlying ApplicantReminder/CustomerReportEmail row's own status
  // (checked by loadActionableRow inside actionFn) is what actually prevents
  // a duplicate send/draft if that item had in fact already succeeded.
  const pendingItemIds = job.items.filter((item) => item.status === 'pending').map((item) => item.itemId.toString());

  let nextIndex = 0;
  const runWorker = async () => {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= pendingItemIds.length) return;

      const itemId = pendingItemIds[currentIndex];
      await setItemStatus(jobId, itemId, { status: 'processing', updatedAt: new Date() });

      try {
        const [result] = await actionFn([itemId], job.operatorEmail, job.mode);
        await setItemStatus(jobId, itemId, {
          status: result?.status || 'failed',
          graphMessageId: result?.graphMessageId || null,
          lastError: result?.error || undefined,
          updatedAt: new Date(),
          attempts: (job.items.find((i) => i.itemId.toString() === itemId)?.attempts || 0) + 1,
        });
      } catch (error) {
        await setItemStatus(jobId, itemId, {
          status: 'failed',
          lastError: error.message,
          updatedAt: new Date(),
          attempts: (job.items.find((i) => i.itemId.toString() === itemId)?.attempts || 0) + 1,
        });
      }
    }
  };

  const workerCount = Math.max(1, Math.min(DEFAULT_CONCURRENCY, pendingItemIds.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  const finalJob = await EmailActionJob.findById(jobId);
  if (!finalJob) return;
  const hasFailures = finalJob.items.some((item) => item.status === 'failed');
  finalJob.status = hasFailures ? 'completed_with_errors' : 'completed';
  finalJob.completedAt = new Date();
  await finalJob.save();
};

// Called once at server startup — a job left 'running' means the process
// exited mid-batch. Any item still 'processing' from that crashed run is
// reset to 'pending' so runEmailActionJob picks it back up; the per-item
// loadActionableRow check inside actionReminders/actionCustomerReportEmails
// (not this file) is what actually skips it if it had in fact already
// succeeded before the crash.
const resumeRunningEmailActionJobs = async () => {
  const staleJobs = await EmailActionJob.find({ status: { $in: ['pending', 'running'] } });
  for (const job of staleJobs) {
    let changed = false;
    for (const item of job.items) {
      if (item.status === 'processing') {
        item.status = 'pending';
        changed = true;
      }
    }
    if (changed) await job.save();
    console.log(`[EMAIL-ACTION-JOB] resuming job ${job._id} (${job.sourceType}, ${job.mode}) after restart`);
    runEmailActionJob(job._id.toString()).catch((error) => {
      console.error(`[EMAIL-ACTION-JOB] resumed job ${job._id} crashed unexpectedly: ${error.message}`);
    });
  }
};

const toJobDto = (job) => ({
  jobId: job._id.toString(),
  sourceType: job.sourceType,
  mode: job.mode,
  total: job.total,
  completed: job.items.filter((item) => item.status !== 'pending' && item.status !== 'processing').length,
  done: job.status === 'completed' || job.status === 'completed_with_errors' || job.status === 'failed',
  status: job.status,
  results: job.items.map((item) => ({
    id: item.itemId.toString(),
    status: item.status,
    error: item.lastError || undefined,
    graphMessageId: item.graphMessageId || undefined,
  })),
});

const getEmailActionJob = async (jobId) => {
  const job = await EmailActionJob.findById(jobId).lean();
  return job ? toJobDto(job) : null;
};

const getActiveEmailActionJob = async (sourceType) => {
  const job = await EmailActionJob.findOne({ sourceType, status: { $in: ['pending', 'running'] } })
    .sort({ startedAt: -1 })
    .lean();
  return job ? toJobDto(job) : null;
};

module.exports = {
  createEmailActionJob,
  runEmailActionJob,
  resumeRunningEmailActionJobs,
  getEmailActionJob,
  getActiveEmailActionJob,
};
